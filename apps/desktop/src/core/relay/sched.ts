/**
 * 隧道写端的公平调度（armadra-cloud 设计 relay-fair-scheduling §2、§6，Go 中继
 * `go/internal/tunnel/sched.go` 的移植）。同一条 WebSocket 上的多条流共用一个写端，
 * 调度器决定下一帧给谁：
 *
 * - 轮转：每条就绪的流每批至多出一帧，大流量流不会把别的流挡在整段积压后面；
 * - 稀疏流优先：刚从空闲转为就绪、排着的字节不多的流进 `fresh`，先于持续有数据的
 *   老流出帧；上一帧还没写出就又就绪的流进老流队列，抢在帧与帧之间反复补数据换不到
 *   额外优先。写端用 {@link Sched.noteSent} 逐帧报告已写出的进度（同中继的
 *   `NoteSent`，cloud#133）：慢链路上一批要写很久，按批判定会让按键间隔短于一批写出
 *   时间的交互流失去优先；不报告进度的调用方退化为「上一批开始之后」；
 * - 字节预算：一批至多 `budget` 字节（老流至少出一帧），后到的控制帧与稀疏流的帧
 *   最多等「当前批剩下的 + 一块」，与就绪流的数量无关。
 *
 * 线上协议不变：调度只决定已经扣过信用的帧的出帧顺序。纯数据结构，不碰 I/O。
 */

import { LIMITS } from "@armadra/platform-protocol/tunnel";

/** 一批最多交给传输层的 DATA 字节（两个最大块，至少一帧）。 */
export const WRITE_BUDGET = 2 * LIMITS.maxDataChunk;

/** 稀疏流排着的字节上限：超过它的（文件传输、刷屏输出）按老流轮转。 */
export const SPARSE_MAX = 16 << 10;

const NONE = 0;
const FRESH = 1;
const OLD = 2;

/** 流在调度器里的状态，嵌在流对象里。 */
export interface Flow {
  /** 在哪条就绪队列里（调度器内部用）。 */
  queued: number;
  /** 最近一次出的帧的全局序号（调度器内部用）。 */
  seq: number;
}

export function newFlow(): Flow {
  return { queued: NONE, seq: 0 };
}

export interface SchedOptions {
  /**
   * 写端逐帧调 {@link Sched.noteSent} 报告写出进度。不报告（默认）时每批开始把
   * 「已写出」追到上一批末尾，判定退化为「上一批开始之后」。
   */
  readonly reportsSent?: boolean;
}

interface Entry<T> {
  readonly v: T;
  readonly f: Flow;
}

/** `step` 的答案：这一帧的载荷字节数（负数 = 这条流没有可出的帧，摘掉），流里是否还有数据。 */
export interface Step {
  readonly size: number;
  readonly more: boolean;
}

export class Sched<T> {
  private fresh: Entry<T>[] = [];
  private old: Entry<T>[] = [];
  /** 已出帧的全局序号。 */
  private seq = 0;
  /** 其中已写出（交给传输层）的序号。 */
  private sent = 0;

  constructor(private readonly options: SchedOptions = {}) {}

  get size(): number {
    return this.fresh.length + this.old.length;
  }

  /** 把有数据的流排进就绪队列；已经在队列里的忽略。`bytes` 是它排着的字节数。 */
  add(v: T, f: Flow, bytes: number): void {
    if (f.queued !== NONE) return;
    if (bytes <= SPARSE_MAX && f.seq <= this.sent) {
      f.queued = FRESH;
      this.fresh.push({ v, f });
      return;
    }
    f.queued = OLD;
    this.old.push({ v, f });
  }

  /** 清空（连接关闭时）。 */
  reset(): void {
    for (const e of this.fresh) e.f.queued = NONE;
    for (const e of this.old) e.f.queued = NONE;
    this.fresh = [];
    this.old = [];
    this.sent = this.seq;
  }

  /**
   * 写端在帧写出后调：`seq` 是 `drain` 交给 `step` 的那一帧的序号。这条流的上一帧
   * 写出之后再就绪，才算稀疏流。
   */
  noteSent(seq: number): void {
    if (seq > this.sent) this.sent = seq;
  }

  /**
   * 取出一批：先给稀疏流各一帧，再按轮转给老流各一帧，超过 `budget` 字节就停（老流
   * 每批至少一帧，稀疏流再多也饿不死它们）；没轮到的留在队首，下一批先出。`step` 给
   * 流出一帧，第二个参数是这一帧出了的话的序号（写出后交给 `noteSent`）。返回这一批
   * 之前的帧序号 `base`，批里第 k 个帧（从 1 数）的序号是 `base + k`。
   */
  drain(budget: number, step: (v: T, seq: number) => Step): number {
    const base = this.seq;
    if (this.options.reportsSent !== true) this.sent = base;
    let size = 0;
    const take = (e: Entry<T>): { more: boolean; ok: boolean } => {
      e.f.queued = NONE;
      const r = step(e.v, this.seq + 1);
      if (r.size < 0) return { more: false, ok: false };
      this.seq += 1;
      e.f.seq = this.seq;
      size += r.size;
      return { more: r.more, ok: true };
    };
    const fresh = this.fresh;
    const old = this.old;
    this.fresh = [];
    this.old = [];
    const promoted: Entry<T>[] = [];

    // 稀疏流：每条一帧；发完一帧后还有数据的转入老流。预算用完时剩下的留在 fresh 队首。
    let i = 0;
    for (; i < fresh.length; i += 1) {
      if (size >= budget) break;
      const e = fresh[i] as Entry<T>;
      const r = take(e);
      if (r.ok && r.more) {
        e.f.queued = OLD;
        promoted.push(e);
      }
    }
    for (; i < fresh.length; i += 1) this.fresh.push(fresh[i] as Entry<T>);

    // 老流：轮转；没轮到的排在最前，其次是本批发过帧的，稀疏流转入的在最后。
    let served = 0;
    let j = 0;
    const again: Entry<T>[] = [];
    for (; j < old.length; j += 1) {
      if (served > 0 && size >= budget) break;
      const e = old[j] as Entry<T>;
      const r = take(e);
      if (!r.ok) continue;
      served += 1;
      if (r.more) {
        e.f.queued = OLD;
        again.push(e);
      }
    }
    const next: Entry<T>[] = [];
    for (let k = j; k < old.length; k += 1) next.push(old[k] as Entry<T>);
    for (const e of again) next.push(e);
    for (const e of promoted) next.push(e);
    this.old = next;
    return base;
  }
}
