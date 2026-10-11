/**
 * 流量统计域的服务（契约 §76）：计量器、落库节奏、保留清理与查询。
 *
 *   * 每 30 秒 flush 一次（没有新行就不碰库，桌面空闲时零写入）；隧道断开时与
 *     core 退出前各再 flush 一次。
 *   * 保留：启动时与每 24 小时删一次 `traffic.retentionDays`（缺省 180）之前的桶。
 *   * 查询把库里的桶与内存里还没落库的行合在一起答，页面看到的不落后 30 秒。
 */

import type { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_TRAFFIC_RETENTION_DAYS,
  TRAFFIC_RETENTION_CHOICES,
  type TrafficCategory,
  type TrafficLive,
  type TrafficPoint,
  type TrafficRow,
  type TrafficSeries,
  type TrafficSeriesInput,
  type TrafficSummary,
  type TrafficSummaryInput,
} from "@armadra/shared";

import { cloudProvider } from "../identity/cloud/login";
import { IdentityTx } from "../identity/store";
import {
  type PeerIdentity,
  type TrafficBucketRow,
  TrafficMeter,
  type TrafficPeer,
} from "./meter";
import { e2eDevices } from "../relay/e2e/peer";
import { type StoredBucket, TrafficStore } from "./store";

export const FLUSH_INTERVAL_MS = 30_000;
export const PRUNE_INTERVAL_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** 解析过的对端缓存的上限；超了整张清掉重来（只是少一次查库）。 */
const PEER_CACHE_LIMIT = 1_000;

export interface TrafficServiceOptions {
  readonly database: DatabaseSync;
  readonly retentionDays?: () => number;
  readonly now?: () => number;
  readonly log?: {
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  /** 测试用：不起定时器。 */
  readonly timers?: boolean;
}

/** 设置里的保留天数：不在取值表里的按缺省。 */
export function retentionDaysOf(value: unknown): number {
  return typeof value === "number" &&
    (TRAFFIC_RETENTION_CHOICES as readonly number[]).includes(value)
    ? value
    : DEFAULT_TRAFFIC_RETENTION_DAYS;
}

interface Totals {
  streams: number;
  bytesIn: number;
  bytesOut: number;
  wireBytesIn: number;
  wireBytesOut: number;
}

function emptyTotals(): Totals {
  return {
    streams: 0,
    bytesIn: 0,
    bytesOut: 0,
    wireBytesIn: 0,
    wireBytesOut: 0,
  };
}

function addInto(totals: Totals, bucket: StoredBucket): void {
  if (bucket.category === "transport") {
    totals.wireBytesIn += bucket.bytesIn;
    totals.wireBytesOut += bucket.bytesOut;
    return;
  }
  totals.streams += bucket.streams;
  totals.bytesIn += bucket.bytesIn;
  totals.bytesOut += bucket.bytesOut;
}

/** 本地时区那一天开始的 UTC 毫秒。 */
function dayStart(ms: number, offsetMinutes: number): number {
  const shift = offsetMinutes * 60_000;
  return Math.floor((ms + shift) / DAY_MS) * DAY_MS - shift;
}

export class TrafficService {
  readonly meter: TrafficMeter;
  private readonly store: TrafficStore;
  /** 只读：解析访客链接与设备名（不开事务）。 */
  private readonly identity: IdentityTx;
  private readonly now: () => number;
  private readonly retention: () => number;
  private readonly peers = new Map<string, TrafficPeer>();
  private flushTimer: NodeJS.Timeout | undefined;
  private pruneTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly options: TrafficServiceOptions) {
    this.now = options.now ?? Date.now;
    this.retention = () =>
      retentionDaysOf(
        options.retentionDays?.() ?? DEFAULT_TRAFFIC_RETENTION_DAYS,
      );
    this.store = new TrafficStore(options.database);
    this.identity = new IdentityTx(options.database);
    this.meter = new TrafficMeter({
      now: this.now,
      resolvePeer: (issuer, who) => this.resolvePeer(issuer, who),
    });
    this.prune();
    if (options.timers !== false) {
      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref();
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
      this.pruneTimer.unref();
    }
  }

  /** 内存里的行写进库。写失败把行放回去，下一轮再试。 */
  flush(): void {
    if (this.meter.pendingRows === 0) return;
    const rows = this.meter.drain();
    try {
      this.store.upsert(rows);
    } catch (error) {
      this.meter.restore(rows);
      this.options.log?.warn("traffic flush failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  prune(): void {
    try {
      this.store.prune(this.now(), this.retention());
    } catch (error) {
      this.options.log?.warn("traffic prune failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  clear(): void {
    this.meter.clear();
    this.store.clear();
  }

  /** core 退出：停定时器，最后 flush 一次。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== undefined) clearInterval(this.flushTimer);
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer);
    this.flush();
  }

  /* -------------------------------- 查询 -------------------------------- */

  summary(input: TrafficSummaryInput): TrafficSummary {
    const buckets = this.buckets(input);
    const offset = input.utcOffsetMinutes ?? 0;
    const groups = new Map<
      string,
      { totals: Totals; peer: StoredBucket | undefined }
    >();
    for (const bucket of buckets) {
      const key =
        input.groupBy === "category"
          ? bucket.category
          : input.groupBy === "day"
            ? String(dayStart(bucket.bucketStartMs, offset))
            : peerGroupKey(bucket);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          totals: emptyTotals(),
          peer: input.groupBy === "peer" ? bucket : undefined,
        };
        groups.set(key, group);
      } else if (
        group.peer !== undefined &&
        group.peer.principalId === "" &&
        bucket.principalId !== ""
      ) {
        // 同一把设备钥：通道的线上字节那一行没有主体，用内层流那一行的主体与种类代表它。
        group.peer = bucket;
      }
      addInto(group.totals, bucket);
    }
    const rows: TrafficRow[] = [];
    for (const [key, group] of groups) {
      const peer = group.peer;
      rows.push({
        key: peer === undefined ? key : peer.peerId || peer.peerKind,
        label: peer === undefined ? "" : this.labelOf(peer),
        peerKind: peer?.peerKind ?? "",
        principalId: peer?.principalId ?? "",
        linkId: peer?.linkId ?? "",
        ...group.totals,
      });
    }
    if (input.groupBy === "day") {
      rows.sort((a, b) => Number(a.key) - Number(b.key));
    } else {
      rows.sort(
        (a, b) =>
          b.bytesIn +
          b.bytesOut +
          b.wireBytesIn +
          b.wireBytesOut -
          (a.bytesIn + a.bytesOut + a.wireBytesIn + a.wireBytesOut),
      );
    }
    return { rows, retentionDays: this.retention() };
  }

  series(input: TrafficSeriesInput): TrafficSeries {
    const buckets = this.buckets(input);
    const offset = input.utcOffsetMinutes ?? 0;
    const points = new Map<number, Totals>();
    for (const bucket of buckets) {
      const at =
        input.bucket === "day"
          ? dayStart(bucket.bucketStartMs, offset)
          : bucket.bucketStartMs;
      let totals = points.get(at);
      if (totals === undefined) {
        totals = emptyTotals();
        points.set(at, totals);
      }
      addInto(totals, bucket);
    }
    return {
      points: [...points.entries()]
        .sort(([a], [b]) => a - b)
        .map(
          ([bucketStartMs, totals]): TrafficPoint => ({
            bucketStartMs,
            ...totals,
          }),
        ),
    };
  }

  live(): TrafficLive {
    return {
      channels: this.meter.livePeers().map((entry) => ({
        peerId: entry.peer.peerId,
        peerKind: entry.peer.kind,
        label: this.labelOf({
          peerKind: entry.peer.kind,
          peerId: entry.peer.peerId,
          principalId: entry.peer.principalId,
        }),
        since: entry.since,
        streams: entry.streams,
        bytesIn: entry.bytesIn,
        bytesOut: entry.bytesOut,
        rateIn: entry.rateIn,
        rateOut: entry.rateOut,
      })),
    };
  }

  /** 库里的桶加上内存里还没落库的行，`[fromMs, toMs)`。 */
  private buckets(input: {
    fromMs: number;
    toMs: number;
    peerId?: string;
    linkId?: string;
    category?: TrafficCategory;
  }): StoredBucket[] {
    const fromMs = Math.floor(input.fromMs / HOUR_MS) * HOUR_MS;
    const filter = {
      fromMs,
      toMs: input.toMs,
      ...(input.peerId === undefined ? {} : { peerId: input.peerId }),
      ...(input.linkId === undefined ? {} : { linkId: input.linkId }),
      ...(input.category === undefined ? {} : { category: input.category }),
    };
    const stored = this.store.buckets(filter);
    const pending = this.meter
      .snapshot()
      .filter(
        (row: TrafficBucketRow) =>
          row.bucketStartMs >= fromMs &&
          row.bucketStartMs < input.toMs &&
          (input.peerId === undefined || row.peerId === input.peerId) &&
          (input.linkId === undefined || row.linkId === input.linkId) &&
          (input.category === undefined || row.category === input.category),
      );
    return [...stored, ...pending];
  }

  /* -------------------------------- 对端 -------------------------------- */

  private resolvePeer(issuer: string, who: PeerIdentity): TrafficPeer {
    const key = `${issuer}\u0000${who.principalId}\u0000${who.deviceId}\u0000${who.channelDeviceId ?? ""}`;
    const cached = this.peers.get(key);
    if (cached !== undefined) return cached;
    let linkId = "";
    try {
      const provider = cloudProvider(issuer);
      for (const credential of this.identity.accounts.credentialsOf(
        who.principalId,
      )) {
        if (
          credential.kind === "oauth" &&
          credential.provider === provider &&
          credential.revokedAtMs === 0 &&
          credential.subject.startsWith("guest:")
        ) {
          linkId = credential.subject.split(":")[1] ?? "";
          break;
        }
      }
    } catch {
      // 身份表读不到：按会话设备记，不挡流。
    }
    // 经端到端通道来的按设备钥记（契约 §77），访客仍标 guest。
    const peer: TrafficPeer = {
      kind:
        linkId !== ""
          ? "guest"
          : who.channelDeviceId === undefined
            ? "legacy"
            : "device",
      peerId: who.channelDeviceId ?? who.deviceId,
      principalId: who.principalId,
      linkId,
    };
    if (this.peers.size >= PEER_CACHE_LIMIT) this.peers.clear();
    this.peers.set(key, peer);
    return peer;
  }

  private labelOf(peer: {
    peerKind: string;
    peerId: string;
    principalId: string;
  }): string {
    if (peer.peerKind === "anonymous" || peer.peerKind === "tunnel") return "";
    try {
      // 经端到端通道来的对端是设备钥（契约 §77）：名字取已信任设备的那一行。
      const trusted =
        peer.peerId === ""
          ? undefined
          : e2eDevices()
              ?.list()
              .find(
                (row) =>
                  row.deviceId === peer.peerId &&
                  (peer.principalId === "" ||
                    row.principalId === peer.principalId),
              );
      if (trusted !== undefined) {
        const name = trusted.label;
        const owner = trusted.principalName ?? "";
        if (owner !== "" && name !== "" && owner !== name)
          return `${name} · ${owner}`;
        if (name !== "" || owner !== "") return name || owner;
      }
      const device =
        peer.peerId === "" ? undefined : this.identity.device(peer.peerId);
      const principal =
        peer.principalId === ""
          ? undefined
          : this.identity.accounts.principal(peer.principalId);
      const owner = principal?.displayName ?? "";
      const name = device?.name ?? "";
      if (owner !== "" && name !== "" && owner !== name) {
        return `${name} · ${owner}`;
      }
      return name || owner;
    } catch {
      return "";
    }
  }
}

/**
 * 按对端分组的键。经端到端通道来的对端（`device`，以及经通道来的访客 `guest`）按设备钥
 * 一组：通道的线上字节（没有主体）与内层流（有主体）落在同一行（契约 §76）。
 */
function peerGroupKey(bucket: StoredBucket): string {
  if (
    (bucket.peerKind === "device" || bucket.peerKind === "guest") &&
    bucket.peerId !== "" &&
    isDeviceKeyId(bucket)
  )
    return `device\u0000${bucket.peerId}`;
  return [
    bucket.peerKind,
    bucket.peerId,
    bucket.principalId,
    bucket.linkId,
  ].join("\u0000");
}

/** 这一行的对端是不是一把端到端设备钥（访客经明文来时 `peerId` 是会话设备，不并）。 */
function isDeviceKeyId(bucket: StoredBucket): boolean {
  if (bucket.peerKind === "device") return true;
  return (
    e2eDevices()
      ?.list()
      .some((row) => row.deviceId === bucket.peerId) ?? false
  );
}
