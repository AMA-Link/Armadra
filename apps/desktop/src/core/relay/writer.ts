/**
 * 隧道写端（core → 中继，armadra-cloud 设计 relay-fair-scheduling §6）：一个控制帧
 * 队列加一个按流的公平调度器（`./sched`），代替「谁先写谁先走」。
 *
 * - 控制帧（WINDOW、PING / PONG、RST、OPEN 的拒绝）每批先写完；
 * - DATA / END 从各流自己的出队列里按调度器取：稀疏流先于积压流，老流轮转，
 *   一批至多 {@link WRITE_BUDGET} 字节（至少一帧）；
 * - 取下一批之前看 `ws.bufferedAmount`：不超过低水位才取。`ws.send` 是异步缓冲，
 *   不设水位的话调度只是把 JS 队列换成 `ws` 的内部缓冲，后到的控制帧与稀疏流的帧
 *   仍排在已经交出去的字节后面。有了水位，一个新帧之前至多还有「低水位 + 一批 +
 *   一块」的字节，与就绪流的数量无关；
 * - 每帧写完的回调推动下一轮，不轮询。
 *
 * 线上协议与信用记账不变：调度只改已扣过信用的帧的出帧顺序。
 */

import {
  type Frame,
  LIMITS,
  encodeFrame,
} from "@armadra/platform-protocol/tunnel";

import { Sched, WRITE_BUDGET } from "./sched";
import type { TunnelDuplex } from "./streams";

/** 默认低水位：`ws` 里已缓冲、未写完的字节不超过它才取下一批（一块）。 */
export const LOW_WATER = LIMITS.maxDataChunk;

/** 写端需要的 WebSocket 的那一小块（`ws` 的 `WebSocket` 满足）。 */
export interface WriterSocket {
  readonly bufferedAmount: number;
  /** 只在已打开的连接上调。 */
  send(
    data: Uint8Array,
    options: { binary: true },
    callback: (error?: Error) => void,
  ): void;
}

export interface TunnelWriterOptions {
  /** 当前可写的 WebSocket；还没打开或已关闭答 `undefined`。 */
  readonly socket: () => WriterSocket | undefined;
  /** 每写出一帧记一次线上字节（契约 §76 的 `transport`，已扣掉端到端密文）。 */
  readonly onWire?: (bytes: number) => void;
  readonly lowWater?: number;
  readonly budget?: number;
}

export class TunnelWriter {
  private ctl: Uint8Array[] = [];
  private readonly sched = new Sched<TunnelDuplex>();
  private kicked = false;
  private closed = false;
  private inflight = 0;
  private retry: NodeJS.Timeout | undefined;
  private readonly lowWater: number;
  private readonly budget: number;

  constructor(private readonly options: TunnelWriterOptions) {
    this.lowWater = options.lowWater ?? LOW_WATER;
    this.budget = options.budget ?? WRITE_BUDGET;
  }

  /** 控制帧：下一批最先写。 */
  control(frame: Frame): void {
    if (this.closed) return;
    this.ctl.push(encodeFrame(frame));
    this.kick();
  }

  /** 流的出队列有了数据。 */
  schedule(stream: TunnelDuplex): void {
    if (this.closed) return;
    this.sched.add(stream, stream.flow, stream.queuedBytes);
    this.kick();
  }

  /** 还没写出去的控制帧与就绪流数（测试与诊断用）。 */
  get backlog(): number {
    return this.ctl.length + this.sched.size;
  }

  /** 不看水位，把排着的全部写出去（优雅关闭前，让最后的 RST / END 先走）。 */
  flushAll(): void {
    this.flush(true);
  }

  /** 清空并停用（连接结束）。 */
  reset(): void {
    this.closed = true;
    this.ctl = [];
    this.sched.reset();
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
  }

  /**
   * 在本轮微任务末尾写一次：同一个回合里排进来的帧凑成一批，稀疏流与控制帧才分得出
   * 先后；空闲链路上也不多等一个定时器。
   */
  private kick(): void {
    if (this.kicked || this.closed) return;
    this.kicked = true;
    queueMicrotask(() => {
      this.kicked = false;
      this.flush(false);
    });
  }

  private readonly written = (): void => {
    this.inflight -= 1;
    this.kick();
  };

  private flush(force: boolean): void {
    if (this.closed) return;
    const socket = this.options.socket();
    if (socket === undefined) return;
    while (this.ctl.length > 0 || this.sched.size > 0) {
      if (!force && socket.bufferedAmount > this.lowWater) {
        // 没有任何写入在途就不会有回调来叫醒：兜底定时重看。
        if (this.inflight === 0 && this.retry === undefined) {
          this.retry = setTimeout(() => {
            this.retry = undefined;
            this.kick();
          }, 5);
          this.retry.unref();
        }
        return;
      }
      this.writeBatch(socket);
    }
  }

  private writeBatch(socket: WriterSocket): void {
    const ctl = this.ctl;
    this.ctl = [];
    for (const frame of ctl) this.write(socket, frame, 0);
    this.sched.drain(this.budget, (stream) => {
      const next = stream.popFrame();
      if (next === undefined) return { size: -1, more: false };
      const sealed =
        next.frame.type === "data" && stream.tunnel?.open.kind === "e2e"
          ? next.size
          : 0;
      this.write(socket, encodeFrame(next.frame), sealed);
      return { size: next.size, more: next.more };
    });
  }

  private write(socket: WriterSocket, data: Uint8Array, sealed: number): void {
    this.options.onWire?.(data.length - sealed);
    this.inflight += 1;
    socket.send(data, { binary: true }, this.written);
  }
}
