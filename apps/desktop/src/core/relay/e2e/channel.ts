/**
 * 端到端通道在 core 这一侧（契约 §78，中继端到端加密设计 §4）：中继给的一条
 * `OPEN { kind: "e2e" }` 隧道流上跑 `armadra-e2e/1`。
 *
 * ```text
 * 外层 TunnelDuplex（中继看得见，只有密文）
 *   └─ 单元：m1 → m2 → m3 → 记录 r0（accept）→ 记录…
 *        └─ 记录明文 = 一个或多个内层隧道帧（OPEN / DATA / END / RST / WINDOW / PING / PONG）
 *             └─ 每条内层流 = 一个 TunnelDuplex，交给与隧道相同的 `admittedServer.emit("connection")`
 * ```
 *
 * - 握手与记录层全部来自协议包 `./e2e`（WebCrypto，与页面、手机同一份）；这里只管
 *   字节流、复用与流控。
 * - 内层流用外层流的来源与地址（`OPEN.clientOrigin` / `remoteIp`，中继给的），方法与
 *   路径是客户端自己填的；准入另看通道对端的设备钥（`tunnel.channel`）。
 * - 流控与隧道相同：每条内层流有自己的窗口，通道有一个总窗口（内层 `WINDOW(0, …)`）。
 *   内层 `DATA` 上限比隧道小（`LIMITS_E2E.maxInnerDataChunk`），整帧才装得进一条记录。
 * - 发送：同一轮事件循环里排队的帧合并成一条记录（上限 64 KiB 明文），终端回显这类小帧
 *   因此不会一帧一条记录。
 * - 任何解密、解析、流控违规都关闭整条通道（外层流 `RST`），不尝试恢复。
 */

import {
  CoreHandshake,
  E2eError,
  type E2eSigner,
  LIMITS_E2E,
  type RecordLayer,
  UnitReader,
  createRecordLayer,
  encodeAccept,
  encodeUnit,
  unitBody,
} from "@armadra/platform-protocol/e2e";
import {
  type Frame,
  LIMITS,
  type OpenPayload,
  RST,
} from "@armadra/platform-protocol/tunnel";

import {
  CreditPool,
  type StreamHost,
  type StreamTrafficCounter,
  TunnelDuplex,
} from "../streams";
import type { DeviceRegistry } from "./devices";
import { type ChannelPeer, markChannelSocket } from "./peer";

/** 通道里的复用限制（r0 报给客户端，与隧道同形）。 */
export const CHANNEL_LIMITS = {
  maxStreams: LIMITS.maxStreams,
  streamWindow: LIMITS.streamWindow,
  tunnelWindow: LIMITS.tunnelWindow,
  maxFrameBytes: LIMITS_E2E.maxInnerFrameBytes,
} as const;

/** 线上字节计数（流量统计的 `wire_bytes`，设计 §6.1）：每个单元 4 + 体长。 */
export interface ChannelMeter {
  wireIn(bytes: number): void;
  wireOut(bytes: number): void;
}

export interface ChannelOptions {
  readonly sourceId: string;
  readonly issuer: string;
  /** 这台 core 的身份签名方（源钥）。 */
  readonly identity: () => Promise<E2eSigner>;
  readonly devices: DeviceRegistry;
  /** 内层流交给它（与隧道流同一个监听）。 */
  readonly listener: {
    emit(event: "connection", socket: TunnelDuplex): boolean;
  };
  readonly channelId: number;
  readonly handshakeTimeoutMs?: number;
  readonly meter?: ChannelMeter;
  /** 内层流的流量计数器（契约 §76，按内层 `OPEN` 分类）；不给不计。 */
  readonly streamCounter?: (
    open: OpenPayload & { readonly kind: "http" | "ws" },
  ) => StreamTrafficCounter | undefined;
  readonly log?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  /** 通道关了（从通道表摘掉）。 */
  readonly onClose?: (channel: E2eChannel) => void;
  /** 握手完成（测试与计量用）。 */
  readonly onReady?: (channel: E2eChannel) => void;
}

type Phase = "m1" | "m3" | "open" | "closed";

export class E2eChannel {
  private phase: Phase = "m1";
  private readonly reader = new UnitReader(LIMITS_E2E.maxHandshakeMessageBytes);
  /** 单元按到达顺序串行处理（握手是异步的，记录的打开也是）。 */
  private work: Promise<void> = Promise.resolve();
  private handshake: CoreHandshake | undefined;
  private records: RecordLayer | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private peerValue: ChannelPeer | undefined;

  /* ------------------------------ 内层复用 ------------------------------ */
  private readonly streams = new Map<number, TunnelDuplex>();
  private readonly sendPool = new CreditPool(CHANNEL_LIMITS.tunnelWindow);
  private recvRemaining: number = CHANNEL_LIMITS.tunnelWindow;
  private recvUnacked = 0;
  private outbox: Frame[] = [];
  private flushScheduled = false;
  private readonly host: StreamHost;

  constructor(
    private readonly outer: TunnelDuplex,
    private readonly options: ChannelOptions,
  ) {
    this.host = {
      sendFrame: (frame) => this.enqueue(frame),
      sendCredit: this.sendPool,
      consumed: (bytes) => this.consumed(bytes),
      closed: (stream) => this.release(stream),
    };
  }

  get channelId(): number {
    return this.options.channelId;
  }

  /** 握手完成之后才有。 */
  get peer(): ChannelPeer | undefined {
    return this.peerValue;
  }

  get streamCount(): number {
    return this.streams.size;
  }

  get ready(): boolean {
    return this.phase === "open";
  }

  start(): void {
    this.handshakeTimer = setTimeout(
      () => this.fail("handshake_timeout"),
      this.options.handshakeTimeoutMs ?? LIMITS_E2E.handshakeTimeoutMs,
    );
    this.handshakeTimer.unref();
    this.outer.on("data", (chunk: Buffer) => this.receive(chunk));
    this.outer.on("end", () => this.close());
    this.outer.on("close", () => this.close());
    this.outer.on("error", () => this.close());
  }

  /** 主动关（撤销、core 退出）：内层流以 `RST sourceGone` 结束，外层流 `END`。 */
  close(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer);
    for (const stream of [...this.streams.values()]) {
      stream.receiveRst(RST.sourceGone);
    }
    this.streams.clear();
    this.outbox = [];
    if (!this.outer.destroyed) this.outer.end();
    this.options.onClose?.(this);
  }

  /* -------------------------------- 收 -------------------------------- */

  private receive(chunk: Buffer): void {
    if (this.phase === "closed") return;
    let units: Uint8Array[];
    try {
      units = this.reader.feed(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    } catch (error) {
      this.fail(errorCode(error));
      return;
    }
    for (const unit of units) {
      this.options.meter?.wireIn(unit.length);
      this.work = this.work
        .then(() => this.unit(unit))
        .catch((error: unknown) => this.fail(errorCode(error)));
    }
  }

  private async unit(unit: Uint8Array): Promise<void> {
    if (this.phase === "closed") return;
    switch (this.phase) {
      case "m1":
        await this.onHello(unitBody(unit));
        return;
      case "m3":
        await this.onDevice(unitBody(unit));
        return;
      case "open": {
        const frames = await (this.records as RecordLayer).opener.openFrames(
          unit,
        );
        for (const frame of frames) this.dispatch(frame);
        return;
      }
    }
  }

  private async onHello(m1: Uint8Array): Promise<void> {
    let handshake: CoreHandshake;
    try {
      handshake = await CoreHandshake.accept(m1, {
        sourceId: this.options.sourceId,
        identity: await this.options.identity(),
      });
    } catch (error) {
      // 客户端钉住的不是这台：不发 m2（不泄露公钥），直接拒绝。
      if (error instanceof E2eError && error.code === "pin_mismatch") {
        this.refuse("pin_mismatch");
        return;
      }
      throw error;
    }
    if (this.phase !== "m1") return;
    this.handshake = handshake;
    this.phase = "m3";
    this.writeUnit(encodeUnit(handshake.m2));
  }

  private async onDevice(m3: Uint8Array): Promise<void> {
    const result = await (this.handshake as CoreHandshake).readDevice(m3);
    this.handshake = undefined;
    const records = await createRecordLayer(result.session, "core");
    if (this.phase !== "m3") return;
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer);
    this.records = records;
    this.reader.setMaxBody(LIMITS_E2E.maxRecordCiphertext);
    const { device } = result;
    const peer: ChannelPeer = {
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      label: device.name,
      platform: device.platform,
      sas: result.session.sas,
      ...(result.hasProof
        ? { verifyProof: (secret: Uint8Array) => result.verifyProof(secret) }
        : {}),
      channelId: this.options.channelId,
    };
    this.peerValue = peer;
    const deviceStatus = this.options.devices.channelStatus(device.deviceId);
    this.phase = "open";
    // r0：第一条记录是 accept，之后才是内层帧。
    const unit = await records.sealer.seal([
      encodeAccept({ type: "accept", deviceStatus, limits: CHANNEL_LIMITS }),
    ]);
    this.writeUnit(unit);
    this.options.onReady?.(this);
  }

  private dispatch(frame: Frame): void {
    switch (frame.type) {
      case "open":
        this.accept(frame.streamId, frame.open);
        return;
      case "data": {
        const length = frame.bytes.length;
        if (length > this.recvRemaining) {
          this.fail("flow_control");
          return;
        }
        this.recvRemaining -= length;
        const stream = this.streams.get(frame.streamId);
        if (stream === undefined) {
          this.consumed(length);
          return;
        }
        if (!stream.receiveData(frame.bytes)) this.fail("flow_control");
        return;
      }
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
      case "ping":
        this.enqueue({ type: "pong", ts: frame.ts });
        return;
      case "pong":
        return;
      case "goaway":
        // 客户端不发 GOAWAY；当成协议错误。
        this.fail("bad_frame");
        return;
    }
  }

  private accept(streamId: number, open: OpenPayload): void {
    if (this.streams.has(streamId) || open.kind === "e2e") {
      this.enqueue({ type: "rst", streamId, code: RST.protocol });
      return;
    }
    if (this.streams.size >= CHANNEL_LIMITS.maxStreams) {
      this.enqueue({ type: "rst", streamId, code: RST.refused });
      return;
    }
    const outerOpen = this.outer.tunnel?.open;
    const stream = new TunnelDuplex(
      streamId,
      this.host,
      {
        streamWindow: CHANNEL_LIMITS.streamWindow,
        maxDataChunk: LIMITS_E2E.maxInnerDataChunk,
      },
      {
        issuer: this.options.issuer,
        open: {
          ...open,
          // 来源与地址以中继给外层流的为准（客户端填的内层元数据不可信）。
          clientOrigin: outerOpen?.clientOrigin ?? null,
          remoteIp: outerOpen?.remoteIp ?? "",
          relayNode: outerOpen?.relayNode ?? "",
        },
        channel: this.peerValue as ChannelPeer,
      },
      this.options.streamCounter?.({ ...open, kind: open.kind }),
    );
    markChannelSocket(stream);
    stream.on("error", () => undefined);
    this.streams.set(streamId, stream);
    this.options.listener.emit("connection", stream);
  }

  /* -------------------------------- 发 -------------------------------- */

  private enqueue(frame: Frame): void {
    if (this.phase !== "open") return;
    this.outbox.push(frame);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flush());
  }

  /** 把排队的帧按 64 KiB 明文一条记录密封，按顺序写到外层流。 */
  private flush(): void {
    this.flushScheduled = false;
    if (this.phase !== "open" || this.records === undefined) return;
    const frames = this.outbox;
    this.outbox = [];
    const { sealer } = this.records;
    let batch: Frame[] = [];
    let size = 0;
    const seal = () => {
      if (batch.length === 0) return;
      const sealing = sealer.sealFrames(batch);
      batch = [];
      size = 0;
      // 密封按调用顺序完成（协议包里串成一条链），写也就按顺序。
      sealing.then(
        (unit) => this.writeUnit(unit),
        (error: unknown) => this.fail(errorCode(error)),
      );
    };
    for (const frame of frames) {
      const bytes = frameSize(frame);
      if (size + bytes > LIMITS_E2E.maxRecordEntries) seal();
      batch.push(frame);
      size += bytes;
    }
    seal();
  }

  private writeUnit(unit: Uint8Array): void {
    if (this.outer.destroyed || this.outer.writableEnded) return;
    this.options.meter?.wireOut(unit.length);
    this.outer.write(
      Buffer.from(unit.buffer, unit.byteOffset, unit.byteLength),
    );
  }

  private consumed(bytes: number): void {
    this.recvUnacked += bytes;
    if (this.recvUnacked >= CHANNEL_LIMITS.tunnelWindow / 2) {
      const credit = this.recvUnacked;
      this.recvUnacked = 0;
      this.recvRemaining += credit;
      this.enqueue({ type: "window", streamId: 0, credit });
    }
  }

  private release(stream: TunnelDuplex): void {
    if (this.streams.get(stream.streamId) === stream)
      this.streams.delete(stream.streamId);
  }

  /* ------------------------------- 失败 ------------------------------- */

  private refuse(code: string): void {
    this.options.log?.info("端到端通道被拒", { code });
    this.phase = "closed";
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer);
    this.outer.destroy();
    this.options.onClose?.(this);
  }

  private fail(code: string): void {
    if (this.phase === "closed") return;
    this.options.log?.warn("端到端通道出错，已关闭", { code });
    this.phase = "closed";
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer);
    for (const stream of [...this.streams.values()]) {
      stream.receiveRst(RST.sourceGone);
    }
    this.streams.clear();
    this.outbox = [];
    // 外层流 RST：中继据此关掉客户端那条边缘连接。
    this.outer.destroy();
    this.options.onClose?.(this);
  }
}

/** 一个内层帧在记录明文里占多少字节（条目长度 4 + 帧头 5 + 载荷）。 */
function frameSize(frame: Frame): number {
  const header = 4 + 5;
  switch (frame.type) {
    case "data":
      return header + frame.bytes.length;
    case "open":
      // OPEN 的载荷是 JSON，按上限估；客户端才发 OPEN，core 不发，这里只为完整。
      return header + LIMITS.openHeadersMaxBytes;
    case "rst":
      return header + 2;
    case "window":
      return header + 4;
    case "ping":
    case "pong":
      return header + 8;
    case "end":
      return header;
    case "goaway":
      return header + 64;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof E2eError) return error.code;
  if (error instanceof Error && "code" in error)
    return String((error as { code: unknown }).code);
  return "internal";
}
