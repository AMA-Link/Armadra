/**
 * 测试用：端到端通道的客户端一侧（Node）。在假中继的一条 `OPEN { kind: "e2e" }`
 * 外层流上跑协议包的 `ClientHandshake` 与记录层，内层复用与 core 用同一份
 * {@link TunnelDuplex}（对角色无感），经内层流发真的 HTTP 请求与 WebSocket 升级。
 *
 * 只有 `*.test.ts` import 它。
 */

import { request as httpRequest } from "node:http";

import {
  ClientHandshake,
  E2E_PATH,
  type E2eAccept,
  type E2eSession,
  type E2eSigner,
  LIMITS_E2E,
  type RecordLayer,
  UnitReader,
  createRecordLayer,
  decodeAccept,
  ed25519SignerFromSeed,
  encodeUnit,
  unitBody,
} from "@armadra/platform-protocol/e2e";
import type { Frame } from "@armadra/platform-protocol/tunnel";
import { WebSocket } from "ws";

import type { FakeTunnel, HttpAnswer } from "../fake-relay.fixture";
import { CreditPool, type StreamHost, TunnelDuplex } from "../streams";

export interface E2eClientOptions {
  readonly sourceId: string;
  /** 设备钥；缺省按 `seed` 派生。 */
  readonly device?: E2eSigner;
  /** 设备钥种子（32 字节）；缺省全 7。 */
  readonly seed?: Uint8Array;
  readonly pinned?: Uint8Array | null;
  readonly name?: string;
  readonly proofSecret?: Uint8Array;
  /** 外层流的客户端来源（中继给 OPEN 的那个）。 */
  readonly clientOrigin?: string | null;
}

export class E2eTestClient {
  readonly streams = new Map<number, TunnelDuplex>();
  private nextStreamId = 1;
  private readonly sendPool: CreditPool;
  private recvUnacked = 0;
  private readonly host: StreamHost;
  private outbox: Frame[] = [];
  private scheduled = false;
  /** 线上字节（外层流两个方向的单元长度之和）。 */
  wireIn = 0;
  wireOut = 0;
  /** 发出的单元（篡改与重放测试用）。 */
  readonly sentUnits: Uint8Array[] = [];
  closed = false;
  readonly closedPromise: Promise<void>;

  private constructor(
    readonly outer: TunnelDuplex,
    readonly accept: E2eAccept,
    readonly session: E2eSession,
    readonly coreIdentity: Uint8Array,
    private readonly records: RecordLayer,
    private readonly reader: UnitReader,
    readonly origin: string | null,
  ) {
    this.sendPool = new CreditPool(accept.limits.tunnelWindow);
    this.host = {
      sendFrame: (frame) => this.enqueue(frame),
      sendCredit: this.sendPool,
      consumed: (bytes) => {
        this.recvUnacked += bytes;
        if (this.recvUnacked >= accept.limits.tunnelWindow / 2) {
          const credit = this.recvUnacked;
          this.recvUnacked = 0;
          this.enqueue({ type: "window", streamId: 0, credit });
        }
      },
      closed: (stream) => {
        if (this.streams.get(stream.streamId) === stream)
          this.streams.delete(stream.streamId);
      },
    };
    this.closedPromise = new Promise((resolve) => {
      const done = () => {
        this.closed = true;
        for (const stream of [...this.streams.values()]) stream.receiveRst(3);
        resolve();
      };
      outer.once("close", done);
      outer.once("end", done);
    });
  }

  static async connect(
    tunnel: FakeTunnel,
    options: E2eClientOptions,
  ): Promise<E2eTestClient> {
    const origin =
      options.clientOrigin === undefined ? null : options.clientOrigin;
    const outer = tunnel.openStream({
      kind: "e2e",
      method: "GET",
      path: E2E_PATH,
      headers: [],
      clientOrigin: origin,
    });
    const reader = new UnitReader(LIMITS_E2E.maxHandshakeMessageBytes);
    const queue: Uint8Array[] = [];
    const waiters: ((unit: Uint8Array | null) => void)[] = [];
    let ended = false;
    const counters = { wireIn: 0, wireOut: 0 };
    const onData = (chunk: Buffer) => {
      for (const unit of reader.feed(new Uint8Array(chunk))) {
        counters.wireIn += unit.length;
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter(unit);
        else queue.push(unit);
      }
    };
    const onEnd = () => {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter(null);
    };
    outer.on("data", onData);
    outer.on("end", onEnd);
    outer.on("close", onEnd);
    const next = () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const ready = queue.shift();
        if (ready !== undefined) return resolve(ready);
        if (ended) return reject(new Error("通道已关"));
        waiters.push((unit) =>
          unit === null ? reject(new Error("通道已关")) : resolve(unit),
        );
      });
    const write = (unit: Uint8Array) => {
      counters.wireOut += unit.length;
      outer.write(Buffer.from(unit));
    };

    const handshake = await ClientHandshake.start({
      sourceId: options.sourceId,
      pinnedIdentity: options.pinned ?? null,
    });
    write(encodeUnit(handshake.m1));
    const { coreIdentity } = await handshake.readCore(unitBody(await next()));
    const device =
      options.device ??
      (await ed25519SignerFromSeed(options.seed ?? new Uint8Array(32).fill(7)));
    const { m3, session } = await handshake.finish({
      device,
      platform: "browser",
      name: options.name ?? "Test Browser",
      ...(options.proofSecret === undefined
        ? {}
        : { proofSecret: options.proofSecret }),
    });
    write(encodeUnit(m3));
    reader.setMaxBody(LIMITS_E2E.maxRecordCiphertext);
    const records = await createRecordLayer(session, "client");
    const accept = decodeAccept(await records.opener.open(await next()));
    outer.off("data", onData);
    const client = new E2eTestClient(
      outer,
      accept,
      session,
      coreIdentity,
      records,
      reader,
      origin,
    );
    client.wireIn = counters.wireIn;
    client.wireOut = counters.wireOut;
    // 握手之后剩下的单元按顺序交给记录层。
    for (const unit of queue.splice(0)) client.onUnit(unit);
    outer.on("data", (chunk: Buffer) => client.onData(chunk));
    return client;
  }

  private work: Promise<void> = Promise.resolve();

  private onData(chunk: Buffer): void {
    let units: Uint8Array[];
    try {
      units = this.reader.feed(new Uint8Array(chunk));
    } catch {
      this.outer.destroy();
      return;
    }
    for (const unit of units) this.onUnit(unit);
  }

  private onUnit(unit: Uint8Array): void {
    this.wireIn += unit.length;
    this.work = this.work
      .then(async () => {
        for (const frame of await this.records.opener.openFrames(unit))
          this.dispatch(frame);
      })
      .catch(() => {
        this.outer.destroy();
      });
  }

  private dispatch(frame: Frame): void {
    switch (frame.type) {
      case "data":
        this.streams.get(frame.streamId)?.receiveData(frame.bytes);
        if (!this.streams.has(frame.streamId))
          this.host.consumed(frame.bytes.length);
        return;
      case "end":
        this.streams.get(frame.streamId)?.receiveEnd();
        return;
      case "rst":
        this.streams.get(frame.streamId)?.receiveRst(frame.code);
        return;
      case "window":
        if (frame.streamId === 0) this.sendPool.add(frame.credit);
        else this.streams.get(frame.streamId)?.receiveWindow(frame.credit);
        return;
      default:
        return;
    }
  }

  private enqueue(frame: Frame): void {
    this.outbox.push(frame);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      const frames = this.outbox;
      this.outbox = [];
      let batch: Frame[] = [];
      let size = 0;
      const seal = () => {
        if (batch.length === 0) return;
        void this.records.sealer.sealFrames(batch).then((unit) => {
          this.sendUnit(unit);
        });
        batch = [];
        size = 0;
      };
      for (const item of frames) {
        const bytes =
          9 +
          (item.type === "data"
            ? item.bytes.length
            : item.type === "open"
              ? 4096
              : 8);
        if (size + bytes > LIMITS_E2E.maxRecordEntries) seal();
        batch.push(item);
        size += bytes;
      }
      seal();
    });
  }

  /** 原样发一个单元（重放测试用）。 */
  sendUnit(unit: Uint8Array): void {
    if (this.outer.destroyed) return;
    this.sentUnits.push(unit);
    this.wireOut += unit.length;
    this.outer.write(Buffer.from(unit));
  }

  /** 密封一组帧但不发，答单元（篡改测试用）。 */
  sealFrames(frames: Frame[]): Promise<Uint8Array> {
    return this.records.sealer.sealFrames(frames);
  }

  /** 开一条内层流。 */
  openStream(kind: "http" | "ws", method: string, path: string): TunnelDuplex {
    const streamId = this.nextStreamId;
    this.nextStreamId += 2;
    this.enqueue({
      type: "open",
      streamId,
      open: {
        kind,
        method,
        path,
        headers: [],
        clientOrigin: null,
        remoteIp: "",
        relayNode: "",
      },
    });
    const stream = new TunnelDuplex(streamId, this.host, {
      streamWindow: this.accept.limits.streamWindow,
      maxDataChunk: LIMITS_E2E.maxInnerDataChunk,
    });
    stream.on("error", () => undefined);
    this.streams.set(streamId, stream);
    return stream;
  }

  /** 经一条内层流发一个 HTTP 请求。 */
  request(input: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  }): Promise<HttpAnswer> {
    const method = input.method ?? "GET";
    const headers: Record<string, string> = {
      host: "source.e2e",
      ...(this.origin === null ? {} : { origin: this.origin }),
      ...input.headers,
      connection: "close",
    };
    const stream = this.openStream("http", method, input.path);
    return new Promise<HttpAnswer>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          createConnection: () => stream,
          method,
          path: input.path,
          headers,
          setHost: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body,
              json: <T>() => JSON.parse(body.toString("utf8")) as T,
            });
          });
          response.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      if (input.body !== undefined) outgoing.write(input.body);
      outgoing.end();
    });
  }

  /** 经一条内层流升级 WebSocket。 */
  websocket(path: string, protocols: string[] = []): WebSocket {
    const stream = this.openStream("ws", "GET", path);
    const socket = new WebSocket(`ws://source.e2e${path}`, protocols, {
      createConnection: () => stream as never,
      perMessageDeflate: false,
      ...(this.origin === null ? {} : { origin: this.origin }),
    });
    socket.on("error", () => undefined);
    return socket;
  }

  ping(): void {
    this.enqueue({ type: "ping", ts: Date.now() });
  }

  close(): void {
    this.outer.end();
  }
}
