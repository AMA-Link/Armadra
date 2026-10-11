/**
 * 流量计量的内存累加器（契约 §76）。
 *
 * 热路径只做加法：隧道流每读写一块调一次 {@link StreamCounter.add}，隧道每收发一条
 * 消息调一次 {@link TrafficMeter.wire}；都只是在一张 `Map` 里找到当前桶的那一行、
 * 把数加上去，不碰库。落库由服务每 30 秒、隧道断开时与进程退出前 {@link
 * TrafficMeter.drain} 一次，一个事务里 upsert。
 *
 * 键 = UTC 小时桶 + 维度，NUL 分隔（与 `usage/cost-buckets.ts` 同一个做法：任何
 * 维度里都可能出现空格或冒号，NUL 不会）。
 *
 * 一条流在认出对端之前（HTTP 头还没解析、准入还没判）读写的字节先记在流自己身上；
 * 准入认出是谁（{@link StreamCounter.identify}）或流结束时才并进表里——所以登录
 * 请求、健康探针这类始终认不出的流落在 `anonymous`，不会混进别人的行。
 *
 * 挂载点在流与隧道的边界上（`relay/streams.ts` 的 `TunnelDuplex`、`relay/client.ts`
 * 的隧道消息），端到端通道接进来时内层流沿用同一个计数器，记录层另记 `wire`。
 */

import {
  type StreamTrafficCategory,
  type TrafficCategory,
  type TrafficPeerKind,
  trafficCategory,
} from "@armadra/shared";

export const HOUR_MS = 3_600_000;
const KEY_SEPARATOR = "\u0000";
/** 速率按最近这么长时间的采样算。 */
const RATE_WINDOW_MS = 10_000;
const SAMPLE_EVERY_MS = 1_000;

export type TrafficRoute = "relay" | "lan";

/** 对端：准入认出来的那个人与设备。 */
export interface TrafficPeer {
  readonly kind: TrafficPeerKind;
  readonly peerId: string;
  readonly principalId: string;
  readonly linkId: string;
}

/** 准入交给计数器的身份；服务把它解析成 {@link TrafficPeer}（访客、链接）。 */
export interface PeerIdentity {
  readonly principalId: string;
  readonly deviceId: string;
  /** 经端到端通道来的：通道对端的设备钥（`trusted_devices.device_id`）。 */
  readonly channelDeviceId?: string;
}

export interface StreamScope {
  readonly route: TrafficRoute;
  readonly issuer: string;
  readonly kind: "http" | "ws";
  /** 只用于分类，不保存。 */
  readonly path: string;
}

export interface WireScope {
  readonly route: TrafficRoute;
  readonly issuer: string;
}

/** 一行桶：落库的就是它。 */
export interface TrafficBucketRow {
  readonly bucketStartMs: number;
  readonly route: TrafficRoute;
  readonly issuer: string;
  readonly peerKind: TrafficPeerKind;
  readonly peerId: string;
  readonly principalId: string;
  readonly linkId: string;
  readonly category: TrafficCategory;
  streams: number;
  bytesIn: number;
  bytesOut: number;
}

export interface LivePeer {
  readonly peer: TrafficPeer;
  readonly issuer: string;
  readonly since: number;
  readonly streams: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly rateIn: number;
  readonly rateOut: number;
}

export const ANONYMOUS_PEER: TrafficPeer = {
  kind: "anonymous",
  peerId: "",
  principalId: "",
  linkId: "",
};

export const TUNNEL_PEER: TrafficPeer = {
  kind: "tunnel",
  peerId: "",
  principalId: "",
  linkId: "",
};

export function bucketStart(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function rowKey(
  bucket: number,
  route: TrafficRoute,
  issuer: string,
  peer: TrafficPeer,
  category: TrafficCategory,
): string {
  return [
    bucket,
    route,
    issuer,
    peer.kind,
    peer.peerId,
    peer.principalId,
    peer.linkId,
    category,
  ].join(KEY_SEPARATOR);
}

function peerKey(issuer: string, peer: TrafficPeer): string {
  return [issuer, peer.kind, peer.peerId, peer.principalId, peer.linkId].join(
    KEY_SEPARATOR,
  );
}

interface Sample {
  readonly atMs: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
}

interface LiveEntry {
  readonly peer: TrafficPeer;
  readonly issuer: string;
  readonly opened: Map<StreamCounter, number>;
  bytesIn: number;
  bytesOut: number;
  samples: Sample[];
}

export interface TrafficMeterOptions {
  readonly now?: () => number;
  /** 把准入给的身份解析成对端（访客 / 链接）；不给时按会话设备记 `legacy`。 */
  readonly resolvePeer?: (issuer: string, who: PeerIdentity) => TrafficPeer;
}

export class TrafficMeter {
  private rows = new Map<string, TrafficBucketRow>();
  /** 每次 drain 加一：流缓存的那一行属于哪一代。 */
  private generation = 0;
  private readonly live = new Map<string, LiveEntry>();
  private readonly wireCache = new Map<
    string,
    { generation: number; bucket: number; row: TrafficBucketRow }
  >();
  readonly now: () => number;
  private readonly resolve: (issuer: string, who: PeerIdentity) => TrafficPeer;

  constructor(options: TrafficMeterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.resolve =
      options.resolvePeer ??
      ((_issuer, who) =>
        who.channelDeviceId === undefined
          ? {
              kind: "legacy",
              peerId: who.deviceId,
              principalId: who.principalId,
              linkId: "",
            }
          : {
              kind: "device",
              peerId: who.channelDeviceId,
              principalId: who.principalId,
              linkId: "",
            });
  }

  /** 一条内层流开始：拿一个计数器，读写都记到它上面。 */
  stream(scope: StreamScope): StreamCounter {
    return new StreamCounter(
      this,
      scope,
      trafficCategory(scope.kind, scope.path),
    );
  }

  /** 隧道级的线上字节（`transport`）：一条消息一次。 */
  wire(scope: WireScope, bytesIn: number, bytesOut: number): void {
    if (bytesIn === 0 && bytesOut === 0) return;
    const bucket = bucketStart(this.now());
    const cacheKey = `${scope.route}${KEY_SEPARATOR}${scope.issuer}`;
    const cached = this.wireCache.get(cacheKey);
    let row: TrafficBucketRow;
    if (
      cached !== undefined &&
      cached.generation === this.generation &&
      cached.bucket === bucket
    ) {
      row = cached.row;
    } else {
      row = this.row(
        bucket,
        scope.route,
        scope.issuer,
        TUNNEL_PEER,
        "transport",
      );
      this.wireCache.set(cacheKey, {
        generation: this.generation,
        bucket,
        row,
      });
    }
    row.bytesIn += bytesIn;
    row.bytesOut += bytesOut;
  }

  /**
   * 端到端通道的线上字节（`transport`，契约 §76）：记到通道对端的设备那一行。中继
   * 统计的 `e2e` 字节就是这些（每个单元 4 + 体长），两边对得上。
   */
  channelWire(
    scope: WireScope,
    deviceId: string,
    bytesIn: number,
    bytesOut: number,
  ): void {
    if (bytesIn === 0 && bytesOut === 0) return;
    const row = this.row(
      bucketStart(this.now()),
      scope.route,
      scope.issuer,
      { kind: "device", peerId: deviceId, principalId: "", linkId: "" },
      "transport",
    );
    row.bytesIn += bytesIn;
    row.bytesOut += bytesOut;
  }

  /** 取走累加到现在的全部行，内存清零（落库失败时由调用方 {@link restore}）。 */
  drain(): TrafficBucketRow[] {
    const taken = [...this.rows.values()];
    this.rows = new Map();
    this.generation += 1;
    return taken;
  }

  /** 落库失败：把取走的行加回去，下一轮再写。 */
  restore(rows: readonly TrafficBucketRow[]): void {
    for (const taken of rows) {
      const row = this.row(
        taken.bucketStartMs,
        taken.route,
        taken.issuer,
        {
          kind: taken.peerKind,
          peerId: taken.peerId,
          principalId: taken.principalId,
          linkId: taken.linkId,
        },
        taken.category,
      );
      row.streams += taken.streams;
      row.bytesIn += taken.bytesIn;
      row.bytesOut += taken.bytesOut;
    }
  }

  /** 内存里还没落库的行（拷贝），查询时与库里的合在一起答。 */
  snapshot(): TrafficBucketRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  /** 内存里还没落库的行数（测试与诊断）。 */
  get pendingRows(): number {
    return this.rows.size;
  }

  /** 当前开着流的对端。 */
  livePeers(): LivePeer[] {
    const now = this.now();
    const result: LivePeer[] = [];
    for (const entry of this.live.values()) {
      const recent = entry.samples.filter(
        (sample) => sample.atMs >= now - RATE_WINDOW_MS,
      );
      const first = recent[0];
      const seconds = first === undefined ? 0 : (now - first.atMs) / 1000;
      const rate = (current: number, then: number) =>
        seconds > 0 ? Math.max(0, (current - then) / seconds) : 0;
      result.push({
        peer: entry.peer,
        issuer: entry.issuer,
        since: Math.min(...entry.opened.values()),
        streams: entry.opened.size,
        bytesIn: entry.bytesIn,
        bytesOut: entry.bytesOut,
        rateIn: first === undefined ? 0 : rate(entry.bytesIn, first.bytesIn),
        rateOut: first === undefined ? 0 : rate(entry.bytesOut, first.bytesOut),
      });
    }
    return result.sort((a, b) => a.since - b.since);
  }

  /** `traffic.clear`：内存里的也一起清。开着的流之后的字节照常计。 */
  clear(): void {
    this.drain();
    for (const entry of this.live.values()) {
      entry.bytesIn = 0;
      entry.bytesOut = 0;
      entry.samples = [];
    }
  }

  /* ----------------------------- 给计数器用 ----------------------------- */

  /** @internal */
  row(
    bucket: number,
    route: TrafficRoute,
    issuer: string,
    peer: TrafficPeer,
    category: TrafficCategory,
  ): TrafficBucketRow {
    const key = rowKey(bucket, route, issuer, peer, category);
    let row = this.rows.get(key);
    if (row === undefined) {
      row = {
        bucketStartMs: bucket,
        route,
        issuer,
        peerKind: peer.kind,
        peerId: peer.peerId,
        principalId: peer.principalId,
        linkId: peer.linkId,
        category,
        streams: 0,
        bytesIn: 0,
        bytesOut: 0,
      };
      this.rows.set(key, row);
    }
    return row;
  }

  /** @internal */
  get currentGeneration(): number {
    return this.generation;
  }

  /** @internal */
  resolvePeer(issuer: string, who: PeerIdentity): TrafficPeer {
    return this.resolve(issuer, who);
  }

  /** @internal */
  attach(counter: StreamCounter, issuer: string, peer: TrafficPeer): LiveEntry {
    const key = peerKey(issuer, peer);
    let entry = this.live.get(key);
    if (entry === undefined) {
      entry = {
        peer,
        issuer,
        opened: new Map(),
        bytesIn: 0,
        bytesOut: 0,
        samples: [],
      };
      this.live.set(key, entry);
    }
    entry.opened.set(counter, this.now());
    return entry;
  }

  /** @internal */
  detach(counter: StreamCounter, entry: LiveEntry): void {
    entry.opened.delete(counter);
    if (entry.opened.size === 0) {
      this.live.delete(peerKey(entry.issuer, entry.peer));
    }
  }

  /** @internal */
  sample(entry: LiveEntry, bytesIn: number, bytesOut: number): void {
    entry.bytesIn += bytesIn;
    entry.bytesOut += bytesOut;
    const now = this.now();
    const last = entry.samples[entry.samples.length - 1];
    if (last === undefined || now - last.atMs >= SAMPLE_EVERY_MS) {
      entry.samples.push({
        atMs: now,
        bytesIn: entry.bytesIn,
        bytesOut: entry.bytesOut,
      });
      while (
        entry.samples.length > 1 &&
        (entry.samples[0] as Sample).atMs < now - RATE_WINDOW_MS
      ) {
        entry.samples.shift();
      }
    }
  }
}

/**
 * 一条内层流的计数器。读写字节先挂在自己身上，认出对端后并进桶表；之后的每一笔
 * 直接加到当前桶那一行（缓存行引用，跨桶或 drain 之后重新找）。
 */
export class StreamCounter {
  private peer: TrafficPeer | undefined;
  private pendingIn = 0;
  private pendingOut = 0;
  private closed = false;
  private live: LiveEntry | undefined;
  private cached:
    | { generation: number; bucket: number; row: TrafficBucketRow }
    | undefined;

  constructor(
    private readonly meter: TrafficMeter,
    private readonly scope: StreamScope,
    readonly category: StreamTrafficCategory,
  ) {}

  /** 对端 → 本机 `bytesIn`，本机 → 对端 `bytesOut`。 */
  add(bytesIn: number, bytesOut: number): void {
    if (bytesIn === 0 && bytesOut === 0) return;
    if (this.peer === undefined) {
      this.pendingIn += bytesIn;
      this.pendingOut += bytesOut;
      return;
    }
    const row = this.current();
    row.bytesIn += bytesIn;
    row.bytesOut += bytesOut;
    if (this.live !== undefined)
      this.meter.sample(this.live, bytesIn, bytesOut);
  }

  /**
   * 准入认出了这条流是谁的。同一条 HTTP/1.1 连接上的后续请求再认一次时，之后的
   * 字节记到新对端；条数只在第一次认出时计。
   */
  identify(who: PeerIdentity | undefined): void {
    if (this.closed) return;
    const peer =
      who === undefined || who.principalId === ""
        ? ANONYMOUS_PEER
        : this.meter.resolvePeer(this.scope.issuer, who);
    this.settle(peer);
  }

  /** 流结束：还没认出就记成匿名；从在线表里摘掉。可以调多次。 */
  close(): void {
    if (this.closed) return;
    if (this.peer === undefined) this.settle(ANONYMOUS_PEER);
    this.closed = true;
    if (this.live !== undefined) {
      this.meter.detach(this, this.live);
      this.live = undefined;
    }
  }

  private settle(peer: TrafficPeer): void {
    const first = this.peer === undefined;
    if (!first && samePeer(this.peer as TrafficPeer, peer)) return;
    this.peer = peer;
    this.cached = undefined;
    if (this.live !== undefined) this.meter.detach(this, this.live);
    this.live =
      peer.kind === "anonymous"
        ? undefined
        : this.meter.attach(this, this.scope.issuer, peer);
    const row = this.current();
    if (first) row.streams += 1;
    if (this.pendingIn > 0 || this.pendingOut > 0) {
      row.bytesIn += this.pendingIn;
      row.bytesOut += this.pendingOut;
      if (this.live !== undefined) {
        this.meter.sample(this.live, this.pendingIn, this.pendingOut);
      }
      this.pendingIn = 0;
      this.pendingOut = 0;
    }
  }

  private current(): TrafficBucketRow {
    const bucket = bucketStart(this.meter.now());
    const generation = this.meter.currentGeneration;
    const cached = this.cached;
    if (
      cached !== undefined &&
      cached.generation === generation &&
      cached.bucket === bucket
    ) {
      return cached.row;
    }
    const row = this.meter.row(
      bucket,
      this.scope.route,
      this.scope.issuer,
      this.peer as TrafficPeer,
      this.category,
    );
    this.cached = { generation, bucket, row };
    return row;
  }
}

function samePeer(a: TrafficPeer, b: TrafficPeer): boolean {
  return (
    a.kind === b.kind &&
    a.peerId === b.peerId &&
    a.principalId === b.principalId &&
    a.linkId === b.linkId
  );
}
