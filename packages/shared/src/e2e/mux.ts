/**
 * 端到端通道里的内层复用，客户端一侧（中继端到端加密设计 §4.6）：与隧道同一套帧
 * （`OPEN / DATA / END / RST / WINDOW / PING / PONG`）、同一套两级信用——每条内层流
 * 一个窗口，整条通道一个窗口（`WINDOW(0, …)`）。
 *
 * 只用 Promise 与 `Uint8Array`，页面、手机 WebView 与 Node 同一份。客户端开的流用
 * 奇数 id。读是拉的：消费者每 `read()` 一块，这一块的字节才算交出去，累计到窗口
 * 一半时补 `WINDOW`——下载快过页面处理时，背压经窗口一路传回 core。
 */

import { LIMITS_E2E } from "@armadra/platform-protocol/e2e";
import type { Frame, OpenPayload } from "@armadra/platform-protocol/tunnel";

/** 隧道的 RST 码里客户端会用到的几个（协议包 `RST`）。 */
export const RST_CODE = {
  refused: 1,
  clientGone: 2,
  sourceGone: 3,
  protocol: 4,
  flowControl: 5,
} as const;

export class StreamReset extends Error {
  constructor(readonly code: number) {
    super(`stream reset ${code}`);
    this.name = "StreamReset";
  }
}

export interface MuxLimits {
  readonly streamWindow: number;
  readonly tunnelWindow: number;
  readonly maxStreams: number;
}

/** 一份共享的发送信用：不够时排队等 `add`。 */
class Credit {
  private readonly waiters: (() => void)[] = [];

  constructor(public available: number) {}

  take(max: number): number {
    const granted = Math.max(0, Math.min(max, this.available));
    this.available -= granted;
    return granted;
  }

  add(credit: number): void {
    this.available += credit;
    const waiting = this.waiters.splice(0);
    for (const wake of waiting) wake();
  }

  wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** 通道关了：叫醒所有等的人（他们会看到流已关）。 */
  release(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }
}

interface MuxHost {
  send(frame: Frame): void;
  readonly channelCredit: Credit;
  consumed(bytes: number): void;
  closed(stream: InnerStream): void;
}

/** 一条内层流：一个 HTTP/1.1 请求或一条 WebSocket。 */
export class InnerStream {
  private sendCredit: number;
  private recvRemaining: number;
  private unacked = 0;
  private readonly queue: Uint8Array[] = [];
  private reader: ((value: Uint8Array | null | Error) => void) | null = null;
  private remoteEnded = false;
  private localEnded = false;
  private failure: Error | null = null;
  private streamWaiters: (() => void)[] = [];
  private released = false;
  /** 已经写出去（扣过信用、交给记录层）的字节。 */
  written = 0;

  constructor(
    readonly id: number,
    private readonly host: MuxHost,
    private readonly window: number,
  ) {
    this.sendCredit = window;
    this.recvRemaining = window;
  }

  get closed(): boolean {
    return this.failure !== null || (this.remoteEnded && this.localEnded);
  }

  /* ---------------------------- 来自对端 ---------------------------- */

  receiveData(bytes: Uint8Array): boolean {
    if (bytes.length > this.recvRemaining) return false;
    this.recvRemaining -= bytes.length;
    if (this.failure !== null || this.remoteEnded) {
      this.host.consumed(bytes.length);
      return true;
    }
    if (this.reader !== null) {
      const deliver = this.reader;
      this.reader = null;
      this.acknowledge(bytes.length);
      deliver(bytes);
    } else {
      this.queue.push(bytes);
    }
    return true;
  }

  receiveEnd(): void {
    if (this.remoteEnded) return;
    this.remoteEnded = true;
    if (this.reader !== null && this.queue.length === 0) {
      const deliver = this.reader;
      this.reader = null;
      deliver(null);
    }
    this.maybeRelease();
  }

  receiveRst(code: number): void {
    this.fail(new StreamReset(code), false);
  }

  receiveWindow(credit: number): void {
    this.sendCredit += credit;
    for (const wake of this.streamWaiters.splice(0)) wake();
  }

  /* ------------------------------- 读 ------------------------------- */

  /** 下一块；对端 `END` 之后答 `null`，被重置抛 {@link StreamReset}。 */
  read(): Promise<Uint8Array | null> {
    const next = this.queue.shift();
    if (next !== undefined) {
      this.acknowledge(next.length);
      return Promise.resolve(next);
    }
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.remoteEnded) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.reader = (value) => {
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
    });
  }

  private acknowledge(bytes: number): void {
    this.host.consumed(bytes);
    if (this.remoteEnded) return;
    this.unacked += bytes;
    if (this.unacked >= this.window / 2) {
      const credit = this.unacked;
      this.unacked = 0;
      this.recvRemaining += credit;
      this.host.send({ type: "window", streamId: this.id, credit });
    }
  }

  /* ------------------------------- 写 ------------------------------- */

  /** 按信用切块写出；对端窗口满了就等 `WINDOW`。流关了抛错。 */
  async write(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.failure !== null) throw this.failure;
      if (this.localEnded) throw new StreamReset(RST_CODE.protocol);
      const want = Math.min(
        bytes.length - offset,
        LIMITS_E2E.maxInnerDataChunk,
        this.sendCredit,
      );
      if (want <= 0) {
        await new Promise<void>((resolve) => this.streamWaiters.push(resolve));
        continue;
      }
      const granted = this.host.channelCredit.take(want);
      if (granted === 0) {
        await this.host.channelCredit.wait();
        continue;
      }
      this.sendCredit -= granted;
      this.host.send({
        type: "data",
        streamId: this.id,
        bytes: bytes.subarray(offset, offset + granted),
      });
      this.written += granted;
      offset += granted;
    }
  }

  /** 本端写完了（`END`）。 */
  end(): void {
    if (this.localEnded || this.failure !== null) return;
    this.localEnded = true;
    this.host.send({ type: "end", streamId: this.id });
    this.maybeRelease();
  }

  /** 本端放弃（`RST`，缺省 `clientGone`）。 */
  reset(code: number = RST_CODE.clientGone): void {
    if (this.failure !== null) return;
    if (!(this.localEnded && this.remoteEnded))
      this.host.send({ type: "rst", streamId: this.id, code });
    this.fail(new StreamReset(code), true);
  }

  /** 通道关了或对端重置：读的人拿到错误，写的人被叫醒后抛错。 */
  fail(error: Error, local: boolean): void {
    if (this.failure !== null) return;
    this.failure = error;
    const dropped = this.queue.reduce((sum, chunk) => sum + chunk.length, 0);
    this.queue.length = 0;
    if (dropped > 0 && !local) this.host.consumed(dropped);
    if (this.reader !== null) {
      const deliver = this.reader;
      this.reader = null;
      deliver(error);
    }
    for (const wake of this.streamWaiters.splice(0)) wake();
    this.release();
  }

  private maybeRelease(): void {
    if (this.localEnded && this.remoteEnded && this.queue.length === 0)
      this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.host.closed(this);
  }
}

/**
 * 客户端的复用器：开流、分发收到的帧、把要发的帧同一轮合并交给 `send`（由通道
 * 密封成一条或几条记录）。对端超发窗口答 `false`（调用方关通道）。
 */
export class ClientMux {
  private readonly streams = new Map<number, InnerStream>();
  private nextId = 1;
  private readonly host: MuxHost;
  private readonly channelCredit: Credit;
  private recvRemaining: number;
  private recvUnacked = 0;
  private outbox: Frame[] = [];
  private scheduled = false;
  private closedError: Error | null = null;
  /** 收到 PONG 时（RTT 用）。 */
  onPong: ((ts: number) => void) | null = null;

  constructor(
    private readonly sendFrames: (frames: Frame[]) => void,
    readonly limits: MuxLimits,
  ) {
    this.channelCredit = new Credit(limits.tunnelWindow);
    this.recvRemaining = limits.tunnelWindow;
    this.host = {
      send: (frame) => this.enqueue(frame),
      channelCredit: this.channelCredit,
      consumed: (bytes) => this.consumed(bytes),
      closed: (stream) => {
        if (this.streams.get(stream.id) === stream)
          this.streams.delete(stream.id);
      },
    };
  }

  get size(): number {
    return this.streams.size;
  }

  open(kind: "http" | "ws", method: string, path: string): InnerStream {
    if (this.closedError !== null) throw this.closedError;
    if (this.streams.size >= this.limits.maxStreams)
      throw new StreamReset(RST_CODE.refused);
    const id = this.nextId;
    this.nextId += 2;
    const open: OpenPayload = {
      kind,
      method,
      path,
      headers: [],
      clientOrigin: null,
      remoteIp: "",
      relayNode: "",
    };
    this.enqueue({ type: "open", streamId: id, open });
    const stream = new InnerStream(id, this.host, this.limits.streamWindow);
    this.streams.set(id, stream);
    return stream;
  }

  ping(): void {
    this.enqueue({ type: "ping", ts: Date.now() });
  }

  /** 一个收到的帧；违规答 `false`。 */
  dispatch(frame: Frame): boolean {
    switch (frame.type) {
      case "data": {
        const length = frame.bytes.length;
        if (length > this.recvRemaining) return false;
        this.recvRemaining -= length;
        const stream = this.streams.get(frame.streamId);
        if (stream === undefined) {
          this.consumed(length);
          return true;
        }
        return stream.receiveData(frame.bytes);
      }
      case "end":
        this.streams.get(frame.streamId)?.receiveEnd();
        return true;
      case "rst":
        this.streams.get(frame.streamId)?.receiveRst(frame.code);
        return true;
      case "window":
        if (frame.streamId === 0) this.channelCredit.add(frame.credit);
        else this.streams.get(frame.streamId)?.receiveWindow(frame.credit);
        return true;
      case "ping":
        this.enqueue({ type: "pong", ts: frame.ts });
        return true;
      case "pong":
        this.onPong?.(frame.ts);
        return true;
      case "open":
      case "goaway":
        // core 不开流、也不发 GOAWAY。
        return false;
    }
  }

  /** 通道关了：每条流都以这个错误结束。 */
  close(error: Error): void {
    if (this.closedError !== null) return;
    this.closedError = error;
    this.outbox = [];
    for (const stream of [...this.streams.values()]) stream.fail(error, false);
    this.streams.clear();
    this.channelCredit.release();
  }

  private consumed(bytes: number): void {
    this.recvUnacked += bytes;
    if (this.recvUnacked >= this.limits.tunnelWindow / 2) {
      const credit = this.recvUnacked;
      this.recvUnacked = 0;
      this.recvRemaining += credit;
      this.enqueue({ type: "window", streamId: 0, credit });
    }
  }

  private enqueue(frame: Frame): void {
    if (this.closedError !== null) return;
    this.outbox.push(frame);
    if (this.scheduled) return;
    this.scheduled = true;
    // 同一轮里排队的帧合成一批（终端按键这类小帧不必一帧一条记录）。
    queueMicrotask(() => {
      this.scheduled = false;
      const frames = this.outbox;
      this.outbox = [];
      if (frames.length > 0 && this.closedError === null)
        this.sendFrames(frames);
    });
  }
}
