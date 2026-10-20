/**
 * 时间线的唯一写入口（设计 §2.3）：合并刷写。
 *
 * 生产者（ACP 会话、转录尾读、hook、core 自己）每来一帧就调一次 {@link
 * TimelineWriter.write}：写入器在内存里持有这条时间线的状态（序号、头部值、尾部几个
 * 回合），先把生产者给的操作应用到内存状态上——所以下一帧看到的是前一帧的结果，
 * 序号也始终连续——再把操作攒进「刷写窗口」。窗口到期时：
 *
 *   1. 窗口里的操作过一遍 `compactTimelineOps`（同一条目相邻的 `append` 合并、被后面
 *      `put` 盖掉的丢弃）；
 *   2. **同一份**压实结果写库（一个 SQLite 事务）并发 `timeline.delta` 帧
 *      （`from` = 上一次的 `headSeq`，`to` = 窗口最后一个序号），所以库、帧与内存
 *      三边的 `rev` 一致；
 *
 * 节奏：一个回合的第一次刷写最多等 {@link FIRST_FLUSH_MS}，之后每 {@link
 * FLUSH_INTERVAL_MS} 一次；条目切换（文本之后来了工具调用）、审批 / 提问出现、回合
 * 结束立刻刷写（切换刷写两次之间至少隔 {@link SWITCH_GAP_MS}，所以工具更新再密也不会
 * 把刷写次数顶上去）。
 */

import {
  type AcpOpsContext,
  type AcpPrompt,
  type AcpTurnEnd,
  type TimelineHead,
  type TimelineItem,
  type TimelineNoticeCode,
  type TimelineOp,
  type TimelineSource,
  type TimelineState,
  acpTurnBeginOps,
  acpTurnEndOps,
  acpUpdateToOps,
  applyTimelineOps,
  compactTimelineOps,
  timelineNoticeOps,
} from "@armadra/shared";

import type { BlobStore } from "./blobs";
import type { TimelineStore } from "./store";

/** 回合的第一次刷写最多等多久。 */
export const FIRST_FLUSH_MS = 30;
/** 之后每隔多久刷一次。 */
export const FLUSH_INTERVAL_MS = 80;
/** 条目切换触发的刷写，两次之间最短隔多久。 */
export const SWITCH_GAP_MS = 25;
/** 内存里留几个回合；更老的回合只在库里。 */
export const MEMORY_TURNS = 3;
/** 窗口里最多攒多少个操作就强制刷写，防止一帧里灌进海量操作。 */
export const MAX_PENDING_OPS = 2_000;

export interface WriterTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: WriterTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** 一次刷写发出去的东西：`timeline.delta` 帧的内容。 */
export interface TimelineFrame {
  readonly timelineId: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly from: number;
  readonly to: number;
  readonly ops: TimelineOp[];
}

export interface TimelineWriterOptions {
  readonly store: TimelineStore;
  readonly blobs?: BlobStore;
  /** 发帧；写入器不关心谁在听。 */
  readonly publish: (frame: TimelineFrame) => void;
  readonly timers?: WriterTimers;
  /** 每个操作写进内存状态之后（刷写之前）通知：活动状态机据此即时更新。 */
  readonly onWrite?: (event: WriteEvent) => void;
  readonly log?: {
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface WriteEvent {
  readonly timelineId: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  /** 应用之后的内存状态。 */
  readonly state: TimelineState;
  readonly ops: readonly TimelineOp[];
}

export interface OpenTimeline {
  readonly timelineId: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly source?: TimelineSource;
}

export interface WriteOptions {
  /** `now`：同步刷写；`soon`：按切换间隔尽快刷写；缺省按窗口节奏。 */
  readonly flush?: "now" | "soon";
}

interface Entry {
  readonly timelineId: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  state: TimelineState;
  /** 已写库、已发帧的最后一个序号。 */
  committedSeq: number;
  pending: TimelineOp[];
  timer: unknown;
  /** 当前挂着的定时器是不是「切换」那一种（可以被更紧的 `now` 取代）。 */
  timerDueAt: number;
  lastFlushAt: number;
  /** 上一个被写的条目的种类，判断「条目切换」。 */
  lastKind: string | undefined;
}

/** 立刻刷写的条目种类：人在等它们。 */
const URGENT_KINDS: ReadonlySet<string> = new Set([
  "approval",
  "elicitation",
  "turn",
]);

export class TimelineWriter {
  private readonly entries = new Map<string, Entry>();
  private readonly timers: WriterTimers;
  private stopped = false;
  /** 已刷写的次数（测试与诊断用）。 */
  flushes = 0;

  constructor(private readonly options: TimelineWriterOptions) {
    this.timers = options.timers ?? realTimers;
  }

  /* -------------------------------- 打开 -------------------------------- */

  /**
   * 登记一条时间线（没有就建行）并把它的尾部载入内存。幂等；归属（工作空间、节点）
   * 以第一次登记为准。
   */
  open(input: OpenTimeline): void {
    if (this.entries.has(input.timelineId)) return;
    const row = this.options.store.ensure(
      {
        id: input.timelineId,
        workspaceId: input.workspaceId,
        nodeId: input.nodeId,
        ...(input.source !== undefined ? { source: input.source } : {}),
      },
      this.timers.now(),
    );
    const state = this.options.store.loadState(input.timelineId, MEMORY_TURNS);
    this.entries.set(input.timelineId, {
      timelineId: input.timelineId,
      workspaceId: row.workspaceId,
      nodeId: row.nodeId,
      state,
      committedSeq: state.seq,
      pending: [],
      timer: undefined,
      timerDueAt: 0,
      lastFlushAt: 0,
      lastKind: undefined,
    });
  }

  has(timelineId: string): boolean {
    return this.entries.has(timelineId);
  }

  /** 内存里的状态（含还没刷写的部分）。 */
  state(timelineId: string): TimelineState | undefined {
    return this.entries.get(timelineId)?.state;
  }

  /** 下一个回合的序号：内存里最大回合 +1，空的从 1 起。 */
  nextTurn(timelineId: string): number {
    const entry = this.require(timelineId);
    let max = this.options.store.maxTurn(timelineId) ?? 0;
    for (const item of Object.values(entry.state.items)) {
      if (item.turn > max) max = item.turn;
    }
    return max + 1;
  }

  /** 当前（最大）回合的序号；还没有回合是 `undefined`。 */
  currentTurn(timelineId: string): number | undefined {
    const entry = this.require(timelineId);
    let max = this.options.store.maxTurn(timelineId);
    for (const item of Object.values(entry.state.items)) {
      if (max === undefined || item.turn > max) max = item.turn;
    }
    return max;
  }

  /* -------------------------------- 写入 -------------------------------- */

  /**
   * 通用写入：`produce` 拿到当前内存状态，交回从 `state.seq + 1` 起编号的操作
   * （共享层的 `acpUpdateToOps` / `acpTurnBeginOps` 等都是这个形状）。操作立刻应用到
   * 内存状态，并入刷写窗口。返回实际入窗的操作。
   */
  write(
    timelineId: string,
    produce: (state: TimelineState) => readonly TimelineOp[],
    options: WriteOptions = {},
  ): TimelineOp[] {
    const entry = this.require(timelineId);
    const ops = produce(entry.state);
    if (ops.length === 0) return [];
    const before = entry.state;
    entry.state = applyTimelineOps(entry.state, ops).state;
    entry.pending.push(...ops);
    this.options.onWrite?.({
      timelineId,
      workspaceId: entry.workspaceId,
      nodeId: entry.nodeId,
      state: entry.state,
      ops,
    });
    this.schedule(entry, ops, before, options.flush);
    return [...ops];
  }

  /** ACP `session/update` 一帧；`storeBlob` 缺省接到这条时间线的 blob 仓。 */
  acpUpdate(
    timelineId: string,
    update: unknown,
    ctx: AcpOpsContext,
    options?: WriteOptions,
  ): TimelineOp[] {
    const full = this.withBlobs(timelineId, ctx);
    return this.write(
      timelineId,
      (state) => acpUpdateToOps(state, update, full),
      options,
    );
  }

  /** 回合开始（回合条目 + 用户消息）；立刻刷写，页面马上看到自己发的话。 */
  turnBegin(
    timelineId: string,
    ctx: AcpOpsContext,
    prompt?: AcpPrompt,
  ): TimelineOp[] {
    return this.write(
      timelineId,
      (state) => acpTurnBeginOps(state, ctx, prompt),
      { flush: "now" },
    );
  }

  /** 回合结束；立刻刷写。 */
  turnEnd(
    timelineId: string,
    ctx: AcpOpsContext,
    end?: AcpTurnEnd,
  ): TimelineOp[] {
    return this.write(timelineId, (state) => acpTurnEndOps(state, ctx, end), {
      flush: "now",
    });
  }

  /** 一条提示（驱动切换、休眠、退出、出错…）；立刻刷写。 */
  notice(
    timelineId: string,
    ctx: AcpOpsContext,
    code: TimelineNoticeCode,
    params?: Record<string, string | number | boolean | null>,
  ): TimelineOp[] {
    return this.write(
      timelineId,
      (state) => timelineNoticeOps(state, ctx, code, params),
      { flush: "soon" },
    );
  }

  /** 直接放一条完整的条目（转录尾读、hook 的快速条目用）。 */
  put(
    timelineId: string,
    item: TimelineItem,
    options?: WriteOptions,
  ): TimelineOp[] {
    return this.write(
      timelineId,
      (state) => [{ seq: state.seq + 1, op: "put", item }],
      options,
    );
  }

  /** 合并头部值（`null` 清掉一项）。 */
  head(
    timelineId: string,
    patch: TimelineHead,
    options?: WriteOptions,
  ): TimelineOp[] {
    return this.write(
      timelineId,
      (state) => [{ seq: state.seq + 1, op: "head", head: patch }],
      options,
    );
  }

  /** 删一个条目（留墓碑）。 */
  remove(
    timelineId: string,
    itemId: string,
    options?: WriteOptions,
  ): TimelineOp[] {
    return this.write(
      timelineId,
      (state) =>
        state.items[itemId] === undefined
          ? []
          : [{ seq: state.seq + 1, op: "remove", itemId }],
      options,
    );
  }

  /** 给 ACP 转换用的 blob 存法：落到这条时间线的 blob 仓。 */
  withBlobs(timelineId: string, ctx: AcpOpsContext): AcpOpsContext {
    const blobs = this.options.blobs;
    if (blobs === undefined || ctx.storeBlob !== undefined) return ctx;
    return {
      ...ctx,
      storeBlob: ({ mimeType, data }) => {
        const stored = blobs.store(timelineId, mimeType, data);
        return stored === null
          ? null
          : { blobId: stored.blobId, bytes: stored.bytes };
      },
    };
  }

  /* -------------------------------- 刷写 -------------------------------- */

  /** 立刻刷写一条（缺省全部）时间线。 */
  flush(timelineId?: string): void {
    if (timelineId !== undefined) {
      const entry = this.entries.get(timelineId);
      if (entry !== undefined) this.flushEntry(entry);
      return;
    }
    for (const entry of this.entries.values()) this.flushEntry(entry);
  }

  /** 刷空并停止；之后的写入被丢弃。关库之前调。 */
  close(): void {
    this.flush();
    this.stopped = true;
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) this.timers.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    this.entries.clear();
  }

  /** 把一条时间线的内存状态丢掉（节点删除、会话终结后）；先刷空。 */
  release(timelineId: string): void {
    const entry = this.entries.get(timelineId);
    if (entry === undefined) return;
    this.flushEntry(entry);
    if (entry.timer !== undefined) this.timers.clearTimeout(entry.timer);
    this.entries.delete(timelineId);
  }

  private require(timelineId: string): Entry {
    const entry = this.entries.get(timelineId);
    if (entry === undefined) {
      throw new Error(`timeline ${timelineId} is not open`);
    }
    return entry;
  }

  private schedule(
    entry: Entry,
    ops: readonly TimelineOp[],
    before: TimelineState,
    flush: WriteOptions["flush"],
  ): void {
    if (this.stopped) return;
    const now = this.timers.now();
    let urgent = flush === "now";
    let soon = flush === "soon";
    for (const op of ops) {
      if (op.op !== "put") continue;
      const kind = op.item.kind;
      if (URGENT_KINDS.has(kind)) urgent = true;
      else if (
        before.items[op.item.id] === undefined &&
        entry.lastKind !== undefined &&
        entry.lastKind !== kind
      ) {
        soon = true;
      }
      entry.lastKind = kind;
    }
    if (entry.pending.length >= MAX_PENDING_OPS) urgent = true;
    if (urgent) {
      this.flushEntry(entry);
      return;
    }
    const wait = soon
      ? Math.max(0, entry.lastFlushAt + SWITCH_GAP_MS - now)
      : entry.lastFlushAt === 0 || now - entry.lastFlushAt >= FLUSH_INTERVAL_MS
        ? FIRST_FLUSH_MS
        : Math.max(FIRST_FLUSH_MS, entry.lastFlushAt + FLUSH_INTERVAL_MS - now);
    const due = now + wait;
    if (entry.timer !== undefined) {
      // 已经有更早的定时器就不动它；更紧的（切换）取代较晚的。
      if (entry.timerDueAt <= due) return;
      this.timers.clearTimeout(entry.timer);
    }
    entry.timerDueAt = due;
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = undefined;
      this.flushEntry(entry);
    }, wait);
  }

  private flushEntry(entry: Entry): void {
    if (entry.timer !== undefined) {
      this.timers.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.pending.length === 0 || this.stopped) return;
    const compacted = compactTimelineOps(entry.pending);
    const to = entry.state.seq;
    const from = entry.committedSeq;
    try {
      this.options.store.apply(
        entry.timelineId,
        compacted,
        to,
        this.timers.now(),
      );
    } catch (error) {
      // 库写不进去（关库中、磁盘满）：留着窗口，下一次再试；内存状态不回退。
      this.options.log?.warn("timeline flush failed", {
        timelineId: entry.timelineId,
        error: error instanceof Error ? error.message : String(error),
      });
      entry.timerDueAt = this.timers.now() + FLUSH_INTERVAL_MS * 4;
      entry.timer = this.timers.setTimeout(() => {
        entry.timer = undefined;
        this.flushEntry(entry);
      }, FLUSH_INTERVAL_MS * 4);
      return;
    }
    entry.pending = [];
    entry.committedSeq = to;
    entry.lastFlushAt = this.timers.now();
    this.flushes++;
    this.options.publish({
      timelineId: entry.timelineId,
      workspaceId: entry.workspaceId,
      nodeId: entry.nodeId,
      from,
      to,
      ops: compacted,
    });
    this.trim(entry);
  }

  /** 内存里只留最近 {@link MEMORY_TURNS} 个回合；更老的回合已经在库里。 */
  private trim(entry: Entry): void {
    let max = -1;
    let min = Number.MAX_SAFE_INTEGER;
    for (const item of Object.values(entry.state.items)) {
      if (item.turn > max) max = item.turn;
      if (item.turn < min) min = item.turn;
    }
    if (max - min < MEMORY_TURNS * 2) return;
    const keepFrom = max - (MEMORY_TURNS - 1);
    const items: Record<string, TimelineItem> = {};
    for (const [id, item] of Object.entries(entry.state.items)) {
      if (item.turn >= keepFrom) items[id] = item;
    }
    entry.state = { ...entry.state, items, tombstones: {} };
  }
}
