/**
 * 端到端通道的客户端一侧（中继端到端加密设计 §4，契约 §78）：一条 WebSocket 连到
 * 中继的 `_relay/e2e`，上面跑 `armadra-e2e/1`——协议包的握手与记录层，记录里是内层
 * 隧道帧（{@link ClientMux}）。中继只看得到这一条 WebSocket 与密文。
 *
 * ```text
 * wss://<中继>/s/<sourceId>/_relay/e2e   子协议 armadra-e2e.1 + armadra-relay.<令牌>
 *   m1 → ← m2（core 身份，钉住的或首次记下）→ m3（设备钥签转录）← r0 accept → 记录…
 * ```
 *
 * 一个客户端对一个源只开一条通道，所有请求与 WebSocket 都复用它；断了、到了 1 小时
 * 或记录数上限由使用方（`apps/web` 的通道管理）重建。
 */

import {
  ClientHandshake,
  E2E_SUBPROTOCOL,
  type E2eAccept,
  type E2eSigner,
  LIMITS_E2E,
  type RecordLayer,
  UnitReader,
  createRecordLayer,
  decodeAccept,
  encodeUnit,
  unitBody,
} from "@armadra/platform-protocol/e2e";
import { RELAY_SUBPROTOCOL_PREFIX } from "@armadra/platform-protocol";
import { type Frame, encodeFrame } from "@armadra/platform-protocol/tunnel";

import { ClientMux } from "./mux.js";

export type E2eChannelErrorCode =
  /** 连不上中继，或中继在握手前就关了（源不支持、离线、令牌被拒）。 */
  | "unreachable"
  /** 握手里 core 的身份公钥与钉住的不同（或钉住的不是这台，core 不答 m2）。 */
  | "identity_mismatch"
  /** 握手消息不对、签名不对、超时。 */
  | "handshake"
  /** 通道已关。 */
  | "closed";

export class E2eChannelError extends Error {
  constructor(
    readonly code: E2eChannelErrorCode,
    message: string = code,
    /** 中继关 WebSocket 时给的关闭码（有的话）。 */
    readonly closeCode?: number,
    /** 中继关 WebSocket 时给的原因（4404 靠它分「源离线」与「源没有 e2e」）。 */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "E2eChannelError";
  }
}

/**
 * 中继在握手前后关通道的缘由：4409 与「4404 + `e2e_unsupported`」是源没有端到端
 * 通道（旧 core），其余 4404 是源不在线（隧道断了、对端重启），别的码或没有码答
 * `null`（令牌失效、限流、网络……由调用方按 `code` / `closeCode` 判）。
 */
export function relayRefusal(error: unknown): "offline" | "unsupported" | null {
  if (!(error instanceof E2eChannelError)) return null;
  if (error.closeCode === 4409) return "unsupported";
  if (error.closeCode !== 4404) return null;
  return error.reason === "e2e_unsupported" ? "unsupported" : "offline";
}

export type DevicePlatform = "ios" | "android" | "desktop" | "browser";

export interface E2eChannelOptions {
  /** `wss://…/_relay/e2e`（中继给的源基址 + `/_relay/e2e`）。 */
  readonly url: string;
  readonly relayToken: string;
  readonly sourceId: string;
  /** 设备钥（签握手转录）。 */
  readonly device: E2eSigner;
  readonly platform: DevicePlatform;
  readonly name: string;
  /** 钉住的 core 身份公钥；没有（首次）时由调用方在 `coreIdentity` 上 TOFU。 */
  readonly pinned?: Uint8Array | null;
  /** 首次配对的秘密 / 访客邀请令牌（字节），有就带 `proof`。 */
  readonly proofSecret?: Uint8Array;
  readonly WebSocket?: typeof WebSocket;
  readonly handshakeTimeoutMs?: number;
  /** 内层 PING 间隔；缺省 20 秒，`0` = 不发。 */
  readonly pingIntervalMs?: number;
  readonly now?: () => number;
}

export interface ChannelCounters {
  /** 线上字节：每个单元 4 + 体长（设计 §6.1 的 `wire_bytes`）。 */
  wireIn: number;
  wireOut: number;
}

type Listener = (error: E2eChannelError) => void;

export class E2eClientChannel {
  readonly counters: ChannelCounters;
  readonly openedAtMs: number;
  private closedWith: E2eChannelError | null = null;
  private readonly listeners = new Set<Listener>();
  private work: Promise<void> = Promise.resolve();
  private pinger: ReturnType<typeof setInterval> | undefined;
  /** 最近一次 PING 的往返（毫秒）；还没量过是 `null`。 */
  rttMs: number | null = null;

  private constructor(
    private readonly socket: WebSocket,
    private readonly records: RecordLayer,
    private readonly reader: UnitReader,
    readonly mux: ClientMux,
    readonly accept: E2eAccept,
    /** 握手推出来的 6 位校验码（待确认时给人看）。 */
    readonly sas: string,
    readonly coreIdentity: Uint8Array,
    readonly devicePublicKey: Uint8Array,
    counters: ChannelCounters,
    private readonly options: E2eChannelOptions,
  ) {
    this.counters = counters;
    this.openedAtMs = (options.now ?? Date.now)();
  }

  /** 连上、握手、读 r0。失败抛 {@link E2eChannelError}，不留任何连接。 */
  static async open(options: E2eChannelOptions): Promise<E2eClientChannel> {
    const Socket = options.WebSocket ?? globalThis.WebSocket;
    const counters: ChannelCounters = { wireIn: 0, wireOut: 0 };
    const reader = new UnitReader(LIMITS_E2E.maxHandshakeMessageBytes);
    let socket: WebSocket;
    try {
      socket = new Socket(options.url, [
        E2E_SUBPROTOCOL,
        `${RELAY_SUBPROTOCOL_PREFIX}${options.relayToken}`,
      ]);
    } catch (error) {
      throw new E2eChannelError("unreachable", String(error));
    }
    socket.binaryType = "arraybuffer";
    const units: Uint8Array[] = [];
    let waiting: ((unit: Uint8Array | E2eChannelError) => void) | null = null;
    let failure: E2eChannelError | null = null;
    let opened = false;
    const fail = (error: E2eChannelError) => {
      if (failure !== null) return;
      failure = error;
      const resolve = waiting;
      waiting = null;
      resolve?.(error);
    };
    const onMessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) {
        fail(new E2eChannelError("handshake", "握手期间收到文本帧"));
        return;
      }
      try {
        for (const unit of reader.feed(new Uint8Array(event.data))) {
          counters.wireIn += unit.length;
          const resolve = waiting;
          if (resolve !== null) {
            waiting = null;
            resolve(unit);
          } else units.push(unit);
        }
      } catch (error) {
        fail(new E2eChannelError("handshake", String(error)));
      }
    };
    const onClose = (event: CloseEvent) =>
      fail(
        new E2eChannelError(
          opened ? "handshake" : "unreachable",
          `中继关闭了连接（${event.code}）`,
          event.code,
          event.reason,
        ),
      );
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    const next = (): Promise<Uint8Array> => {
      const ready = units.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      if (failure !== null) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiting = (value) =>
          value instanceof E2eChannelError ? reject(value) : resolve(value);
      });
    };
    const send = (unit: Uint8Array) => {
      counters.wireOut += unit.length;
      socket.send(unit);
    };
    const timeout = setTimeout(
      () => fail(new E2eChannelError("handshake", "握手超时")),
      options.handshakeTimeoutMs ?? LIMITS_E2E.handshakeTimeoutMs,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        if (socket.readyState === 1) return resolve();
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
          "close",
          (event) =>
            reject(
              new E2eChannelError(
                "unreachable",
                `中继拒绝了连接（${event.code}）`,
                event.code,
                event.reason,
              ),
            ),
          { once: true },
        );
      });
      opened = true;
      const handshake = await ClientHandshake.start({
        sourceId: options.sourceId,
        pinnedIdentity: options.pinned ?? null,
      });
      send(encodeUnit(handshake.m1));
      let m2: Uint8Array;
      try {
        m2 = unitBody(await next());
      } catch (error) {
        // 钉住了而 core 不答 m2：钉住的不是这台（core 直接重置，不泄露公钥）。
        // 中继自己的关闭码（4xxx：令牌失效 4401、限流 4429、离线 4404……）不是
        // 身份问题，原样抛出，调用方按码处理。
        if (
          options.pinned &&
          error instanceof E2eChannelError &&
          error.code === "handshake" &&
          (error.closeCode === undefined || error.closeCode < 4000)
        )
          throw new E2eChannelError("identity_mismatch", "这台电脑的身份变了");
        throw error;
      }
      let coreIdentity: Uint8Array;
      try {
        ({ coreIdentity } = await handshake.readCore(m2));
      } catch (error) {
        const code = (error as { code?: string }).code;
        throw new E2eChannelError(
          code === "identity_mismatch" ? "identity_mismatch" : "handshake",
          String(error),
        );
      }
      const { m3, session } = await handshake.finish({
        device: options.device,
        platform: options.platform,
        name: options.name,
        ...(options.proofSecret === undefined
          ? {}
          : { proofSecret: options.proofSecret }),
      });
      send(encodeUnit(m3));
      reader.setMaxBody(LIMITS_E2E.maxRecordCiphertext);
      const records = await createRecordLayer(session, "client");
      let accept: E2eAccept;
      try {
        accept = decodeAccept(await records.opener.open(await next()));
      } catch (error) {
        if (error instanceof E2eChannelError) throw error;
        throw new E2eChannelError("handshake", String(error));
      }
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      const mux: { current: ClientMux | null } = { current: null };
      const channel = new E2eClientChannel(
        socket,
        records,
        reader,
        new ClientMux(
          (frames) => mux.current !== null && channel.sendFrames(frames),
          accept.limits,
        ),
        accept,
        session.sas,
        coreIdentity,
        options.device.publicKey,
        counters,
        options,
      );
      mux.current = channel.mux;
      channel.attach(units.splice(0));
      return channel;
    } catch (error) {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      try {
        socket.close();
      } catch {
        /* 已经关了。 */
      }
      if (error instanceof E2eChannelError) throw error;
      throw new E2eChannelError("handshake", String(error));
    }
  }

  get closed(): boolean {
    return this.closedWith !== null;
  }

  /** 通道到了该重建的时候（1 小时）。 */
  get expired(): boolean {
    return (
      (this.options.now ?? Date.now)() - this.openedAtMs >=
      LIMITS_E2E.maxChannelAgeMs
    );
  }

  /** 关了时叫（只叫一次）；已经关了立刻叫。答退订函数。 */
  onClose(listener: Listener): () => void {
    if (this.closedWith !== null) {
      const error = this.closedWith;
      queueMicrotask(() => listener(error));
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.shutdown(new E2eChannelError("closed", "通道已关"));
    try {
      this.socket.close(1000);
    } catch {
      /* 已经关了。 */
    }
  }

  private attach(pending: Uint8Array[]): void {
    this.socket.addEventListener("message", (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) {
        this.fatal("记录层收到文本帧");
        return;
      }
      let units: Uint8Array[];
      try {
        units = this.reader.feed(new Uint8Array(event.data));
      } catch (error) {
        this.fatal(String(error));
        return;
      }
      for (const unit of units) this.unit(unit);
    });
    this.socket.addEventListener("close", (event: CloseEvent) =>
      this.shutdown(
        new E2eChannelError(
          "closed",
          `通道关闭（${event.code}）`,
          event.code,
          event.reason,
        ),
      ),
    );
    for (const unit of pending) this.unit(unit);
    const interval = this.options.pingIntervalMs ?? LIMITS_E2E.pingIntervalMs;
    if (interval > 0) {
      this.mux.onPong = (ts) => {
        this.rttMs = Math.max(0, Date.now() - ts);
      };
      this.pinger = setInterval(() => this.mux.ping(), interval);
      (this.pinger as { unref?: () => void }).unref?.();
    }
  }

  private unit(unit: Uint8Array): void {
    this.counters.wireIn += unit.length;
    this.work = this.work.then(async () => {
      if (this.closedWith !== null) return;
      let frames: Frame[];
      try {
        frames = await this.records.opener.openFrames(unit);
      } catch (error) {
        this.fatal(`记录解不开：${String(error)}`);
        return;
      }
      for (const frame of frames) {
        if (!this.mux.dispatch(frame)) {
          this.fatal("内层帧违规");
          return;
        }
      }
    });
  }

  /** 把一批帧按 64 KiB 明文切成记录，按顺序发出。 */
  private sendFrames(frames: Frame[]): void {
    if (this.closedWith !== null) return;
    const { sealer } = this.records;
    let batch: Uint8Array[] = [];
    let size = 0;
    const seal = () => {
      if (batch.length === 0) return;
      const entries = batch;
      batch = [];
      size = 0;
      sealer.seal(entries).then(
        (unit) => {
          if (this.closedWith !== null) return;
          this.counters.wireOut += unit.length;
          this.socket.send(unit);
        },
        (error: unknown) => this.fatal(`记录封不上：${String(error)}`),
      );
    };
    for (const frame of frames) {
      let entry: Uint8Array;
      try {
        entry = encodeFrame(frame);
      } catch (error) {
        this.fatal(String(error));
        return;
      }
      if (size + 4 + entry.length > LIMITS_E2E.maxRecordEntries) seal();
      batch.push(entry);
      size += 4 + entry.length;
    }
    seal();
  }

  private fatal(message: string): void {
    this.shutdown(new E2eChannelError("closed", message));
    try {
      this.socket.close(4400, "e2e");
    } catch {
      /* 已经关了。 */
    }
  }

  private shutdown(error: E2eChannelError): void {
    if (this.closedWith !== null) return;
    this.closedWith = error;
    if (this.pinger !== undefined) clearInterval(this.pinger);
    this.mux.close(error);
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener(error);
  }
}
