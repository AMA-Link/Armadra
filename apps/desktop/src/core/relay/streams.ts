/**
 * 隧道流（契约 §32，平台规格 core 包 §4.3）：中继发来的一条 `OPEN` 在 core 里就是
 * 一个 {@link TunnelDuplex}，交给 `admittedServer.emit("connection", duplex)`，由
 * Node 自己解析里面的 HTTP/1.1 与 WebSocket 升级——与回环监听上的请求同一条路。
 *
 * 写（core → 中继）：按 `maxDataChunk` 切块，每块同时扣「流信用」与「隧道信用」，
 * 任一不足就挂起 `_write` 的回调，直到 `WINDOW` 补回。背压经 Duplex 的写缓冲传到
 * 上游：WebSocket 的 `bufferedAmount` 含这一段，所以五条流的发送队列（A3-0 的
 * `SendQueue`）照常按它判拥塞。
 *
 * 出帧顺序（公平调度，`./sched`）：扣过信用的 DATA / END 先进这条流自己的出队列，
 * 宿主（`StreamHost.schedule`）按调度器决定哪条流下一个出帧，而不是谁先写谁先走。
 * 宿主不给 `schedule`（端到端通道里的内层流、测试夹具）就直接 `sendFrame`，同以前。
 * 流在 RST（收到或发出）时丢弃出队列里没发出去的 DATA，并把它们占的隧道信用还回去：
 * 对端从没收到这些字节，不会为它们补 WINDOW。
 *
 * 读（中继 → core）：`DATA` 先进本地队列，`_read` 被调时才 `push`；交出去的字节
 * 累计到窗口一半时发 `WINDOW(streamId, 已消费)`，隧道级的由宿主同样补回。对端发得
 * 比授予的信用多 → `receiveData` 答 `false`，宿主发 `RST 5` 并以 4400 关隧道。
 *
 * 关闭：收 `END` → `push(null)`；本地 `end()` → 发 `END`；收 `RST` → `destroy`；
 * 本地 `destroy()` → 发 `RST`（无错误时 `clientGone`）。两端都 `END` 后从流表摘掉。
 *
 * 计数（契约 §76）：给了 {@link StreamTrafficCounter} 时，收到的每块 `DATA`（对端 →
 * 本机）与发出的每块（本机 → 对端）各报一次字节数，流从流表摘掉时 `close()`。
 * 准入认出请求是谁后调 `identify`。计数器只做加法，不碰库。
 *
 * 本类对角色无感：测试里的假中继用同一份。
 */

import { Duplex } from "node:stream";

import {
  type Frame,
  type OpenPayload,
  RST,
} from "@armadra/platform-protocol/tunnel";

import type { ChannelPeer } from "./e2e/peer";
import { type Flow, newFlow } from "./sched";

export class StreamResetError extends Error {
  constructor(readonly rstCode: number) {
    super(`tunnel stream reset ${rstCode}`);
    this.name = "StreamResetError";
  }
}

/** 隧道级发送信用：所有流共享；不够时登记等待者，`add` 时挨个叫醒。 */
export class CreditPool {
  private readonly waiters = new Set<() => void>();

  constructor(public available: number) {}

  take(max: number): number {
    const granted = Math.max(0, Math.min(max, this.available));
    this.available -= granted;
    return granted;
  }

  add(credit: number): void {
    this.available += credit;
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) {
      if (this.available <= 0) {
        this.waiters.add(wake);
        continue;
      }
      wake();
    }
  }

  wait(wake: () => void): void {
    this.waiters.add(wake);
  }

  cancel(wake: () => void): void {
    this.waiters.delete(wake);
  }
}

export interface StreamHost {
  /** 控制帧（WINDOW、RST）与不走调度时的 DATA / END。 */
  sendFrame(frame: Frame): void;
  /**
   * 流的出队列有了数据，请宿主的写调度器安排出帧（调度器之后调 `popFrame`）。
   * 不给就不走调度，流直接 `sendFrame`。
   */
  schedule?(stream: TunnelDuplex): void;
  /** 隧道级发送信用。 */
  readonly sendCredit: CreditPool;
  /** 本端交给消费者的字节数（隧道级补信用用）。 */
  consumed(bytes: number): void;
  /** 流不再需要留在流表里（两端都 END，或 RST）。可能被调多次。 */
  closed(stream: TunnelDuplex): void;
}

export interface TunnelStreamOptions {
  readonly streamWindow: number;
  readonly maxDataChunk: number;
}

/** 隧道流在 core 这一侧带的元数据（准入读它，不读请求头）。 */
export interface TunnelOrigin {
  /** 这条隧道登记到的远程服务。 */
  readonly issuer: string;
  /**
   * 中继给的 `OPEN`：`clientOrigin` / `remoteIp` 以它为准。端到端通道里的内层流
   * 用外层（通道那条边缘连接）的来源与地址，方法与路径是客户端自己填的。
   */
  readonly open: OpenPayload;
  /** 经端到端通道来的内层流：通道对端的设备钥（契约 §77）。明文路径没有。 */
  readonly channel?: ChannelPeer;
}

/**
 * 一条流的流量计数器（`core/traffic/meter.ts` 的 `StreamCounter` 实现它）。这里只
 * 声明形状，中继域不依赖统计域。
 */
export interface StreamTrafficCounter {
  add(bytesIn: number, bytesOut: number): void;
  /** 准入认出了请求主体；没认出（匿名面）给 `undefined`。 */
  identify(
    who:
      | {
          readonly principalId: string;
          readonly deviceId: string;
          /** 经端到端通道来的：通道对端的设备钥（契约 §77）。 */
          readonly channelDeviceId?: string;
        }
      | undefined,
  ): void;
  close(): void;
}

/**
 * 隧道一侧的流量计量（契约 §76）：每条 `OPEN` 拿一个流计数器；隧道 WebSocket 的
 * 每条消息记一次线上字节（`transport`）；隧道断开时 `flush`。
 */
export interface TunnelTrafficMeter {
  stream(scope: {
    readonly route: "relay";
    readonly issuer: string;
    readonly kind: Exclude<OpenPayload["kind"], "e2e">;
    readonly path: string;
  }): StreamTrafficCounter;
  wire(
    scope: { readonly route: "relay"; readonly issuer: string },
    bytesIn: number,
    bytesOut: number,
  ): void;
  flush?(): void;
}

interface PendingWrite {
  readonly chunk: Buffer;
  offset: number;
  readonly callback: (error?: Error | null) => void;
}

/** 出队列里的 END 标记；数字是排在尾巴后面的 RST 码。 */
const END = Symbol("end");

export class TunnelDuplex extends Duplex {
  /** 本端还能发的流信用。 */
  private sendCredit: number;
  /** 授予对端、对端还没用掉的信用。 */
  private recvRemaining: number;
  /** 已交给消费者、还没用 WINDOW 补回去的字节。 */
  private unacked = 0;
  private readonly queue: Buffer[] = [];
  private wantsRead = false;
  private pending: PendingWrite | null = null;
  private remoteEnded = false;
  private eofPushed = false;
  private localEnded = false;
  private peerReset = false;
  private released = false;
  /** 已扣过信用、等调度器出帧的 DATA / END；`outHead` 之前的已出队。 */
  private out: (Buffer | typeof END | number)[] = [];
  private outHead = 0;
  /** `out` 里的 DATA 字节（入队 / 出队时增减，调度器判断稀疏流不必遍历）。 */
  private outBytes = 0;
  /** 写端调度器里的状态。 */
  readonly flow: Flow = newFlow();

  /**
   * `net.Socket` 的几个字段：Node 的 HTTP 层与身份域按它们认来源地址与 TLS。
   * 地址是中继给的客户端地址（`OPEN.remoteIp`），不是中继自己；隧道一律是
   * TLS 上来的。
   */
  readonly remoteAddress: string | undefined;
  readonly encrypted = true;
  /** 准入用：客户端来源（`OPEN.clientOrigin`），以它为准，不信请求头。 */
  readonly armadraOrigin: string | null;
  readonly tunnel: TunnelOrigin | undefined;

  constructor(
    readonly streamId: number,
    private readonly host: StreamHost,
    private readonly options: TunnelStreamOptions,
    tunnel?: TunnelOrigin,
    /** 流量计数（契约 §76）；不给就不计。 */
    readonly counter?: StreamTrafficCounter,
  ) {
    super({
      allowHalfOpen: true,
      readableHighWaterMark: options.streamWindow,
      writableHighWaterMark: options.streamWindow,
    });
    this.sendCredit = options.streamWindow;
    this.recvRemaining = options.streamWindow;
    this.tunnel = tunnel;
    this.remoteAddress = tunnel?.open.remoteIp;
    this.armadraOrigin = tunnel?.open.clientOrigin ?? null;
  }

  /* ---------------------------- 来自对端的帧 ---------------------------- */

  /** 收到 DATA；超出授予的信用答 `false`（流控违规）。 */
  receiveData(bytes: Uint8Array): boolean {
    if (bytes.length > this.recvRemaining) return false;
    this.recvRemaining -= bytes.length;
    this.counter?.add(bytes.length, 0);
    if (this.remoteEnded || this.destroyed) {
      // 已经结束或本地已销毁：丢弃，但隧道级信用照样还回去。
      this.host.consumed(bytes.length);
      return true;
    }
    this.queue.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    this.drain();
    return true;
  }

  receiveEnd(): void {
    if (this.remoteEnded) return;
    this.remoteEnded = true;
    this.drain();
    this.maybeRelease();
  }

  receiveRst(code: number): void {
    this.peerReset = true;
    this.destroy(new StreamResetError(code));
  }

  receiveWindow(credit: number): void {
    this.sendCredit += credit;
    this.pump();
  }

  /* -------------------------------- 读 -------------------------------- */

  override _read(): void {
    this.wantsRead = true;
    this.drain();
  }

  private drain(): void {
    while (this.wantsRead && this.queue.length > 0) {
      const chunk = this.queue.shift() as Buffer;
      this.acknowledge(chunk.length);
      if (!this.push(chunk)) this.wantsRead = false;
    }
    if (this.queue.length === 0 && this.remoteEnded && !this.eofPushed) {
      this.eofPushed = true;
      this.push(null);
    }
  }

  private acknowledge(bytes: number): void {
    this.host.consumed(bytes);
    if (this.remoteEnded) return;
    this.unacked += bytes;
    if (this.unacked >= this.options.streamWindow / 2) {
      const credit = this.unacked;
      this.unacked = 0;
      this.recvRemaining += credit;
      this.host.sendFrame({ type: "window", streamId: this.streamId, credit });
    }
  }

  /* -------------------------------- 写 -------------------------------- */

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.pending = { chunk, offset: 0, callback };
    this.pump();
  }

  private readonly pump = (): void => {
    const pending = this.pending;
    if (pending === null || this.destroyed) return;
    while (pending.offset < pending.chunk.length) {
      const want = Math.min(
        pending.chunk.length - pending.offset,
        this.options.maxDataChunk,
        this.sendCredit,
      );
      if (want <= 0) return; // 等这条流的 WINDOW
      const granted = this.host.sendCredit.take(want);
      if (granted === 0) {
        this.host.sendCredit.wait(this.pump);
        return;
      }
      this.sendCredit -= granted;
      this.emitData(
        pending.chunk.subarray(pending.offset, pending.offset + granted),
      );
      pending.offset += granted;
    }
    this.pending = null;
    pending.callback();
  };

  /** 一块已扣过信用的 DATA：进出队列等调度，宿主不调度就直接发。 */
  private emitData(bytes: Buffer): void {
    if (this.host.schedule === undefined) {
      this.counter?.add(0, bytes.length);
      this.host.sendFrame({ type: "data", streamId: this.streamId, bytes });
      return;
    }
    this.out.push(bytes);
    this.outBytes += bytes.length;
    this.host.schedule(this);
  }

  private hasScheduler(): boolean {
    return this.host.schedule !== undefined;
  }

  /** 出队列里排着的 DATA 字节（调度器判断稀疏流用）。 */
  get queuedBytes(): number {
    return this.outBytes;
  }

  /**
   * 调度器取下一帧：答帧、它的载荷字节与出队列里是否还有；队列空答 `undefined`。
   * 计数在这里记：丢弃的字节没有发出去，不算。
   */
  popFrame(): { frame: Frame; size: number; more: boolean } | undefined {
    if (this.outHead >= this.out.length) return undefined;
    const item = this.out[this.outHead] as Buffer | typeof END | number;
    this.out[this.outHead] = END;
    this.outHead += 1;
    if (this.outHead >= this.out.length) {
      this.out = [];
      this.outHead = 0;
    } else if (this.outHead >= 1024 && this.outHead * 2 >= this.out.length) {
      this.out = this.out.slice(this.outHead);
      this.outHead = 0;
    }
    const more = this.outHead < this.out.length;
    if (typeof item === "number") {
      return {
        frame: { type: "rst", streamId: this.streamId, code: item },
        size: 0,
        more,
      };
    }
    if (item === END) {
      return {
        frame: { type: "end", streamId: this.streamId },
        size: 0,
        more,
      };
    }
    this.outBytes -= item.length;
    this.counter?.add(0, item.length);
    return {
      frame: { type: "data", streamId: this.streamId, bytes: item },
      size: item.length,
      more,
    };
  }

  /** 丢掉出队列里没发出去的帧，把 DATA 占的隧道信用还回去。 */
  private dropOut(): void {
    const dropped = this.outBytes;
    this.out = [];
    this.outHead = 0;
    this.outBytes = 0;
    if (dropped > 0) this.host.sendCredit.add(dropped);
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.peerReset) {
      this.localEnded = true;
      if (this.host.schedule === undefined) {
        this.host.sendFrame({ type: "end", streamId: this.streamId });
      } else {
        this.out.push(END);
        this.host.schedule(this);
      }
    }
    callback();
    this.maybeRelease();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.host.sendCredit.cancel(this.pump);
    this.pending = null;
    const resetting = !this.peerReset && !(this.localEnded && this.remoteEnded);
    // 对端复位或本端出错中止：排着的 DATA 作废（信用还回去），RST 走控制队列先行。
    // 本端平静地销毁（没有错误，或已经 END）：先 `write` 再 `destroy()` 是常见写法
    // （升级被拒绝时先写 401 再销毁），出队列里的尾巴照常发完，RST 排在后面，对端先
    // 看到完整的字节，与改成调度之前的出帧顺序相同。两端都正常结束后销毁：尾巴（含
    // END）也发完，不发 RST。
    const finishing =
      resetting && this.hasScheduler() && (this.localEnded || error === null);
    if (this.peerReset || (resetting && !finishing)) this.dropOut();
    if (resetting) {
      const code =
        error instanceof StreamResetError
          ? error.rstCode
          : error
            ? RST.internal
            : RST.clientGone;
      if (finishing) {
        this.out.push(code);
        this.host.schedule?.(this);
      } else {
        this.host.sendFrame({ type: "rst", streamId: this.streamId, code });
      }
    }
    // 队列里还没交出去的字节也要把隧道级信用还回去。
    const dropped = this.queue.reduce((sum, chunk) => sum + chunk.length, 0);
    this.queue.length = 0;
    if (dropped > 0) this.host.consumed(dropped);
    this.release();
    callback(error);
  }

  private maybeRelease(): void {
    if (this.localEnded && this.remoteEnded) this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.counter?.close();
    this.host.closed(this);
  }

  /* -------------------------- net.Socket 兼容 -------------------------- */

  // `http.Server.emit("connection")` 与 `ws` 会调这些；隧道流没有 TCP 选项可设。
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  setTimeout(_ms: number, callback?: () => void): this {
    if (callback !== undefined) this.once("timeout", callback);
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}
