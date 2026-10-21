/**
 * 时间线同步控制器（设计 §2.3、§2.6、§4）。每个 `(sourceId, timelineId)` 一个，
 * 引用计数共享：
 *
 *  1. 先订阅事件、缓存 `timeline.delta` 帧，再取基线；
 *  2. 有本地缓存：先用缓存渲染，只发 `sync(after = cache.seq)`，不发 `open`；
 *     没有缓存：`open` 只取尾部 3 个回合 + 回合索引；
 *  3. 帧按动画帧合并：一个帧内到的所有 `delta` 折成一次 store 提交；
 *  4. `from > 本地 seq` 是缺口：丢弃并 `sync(after = 本地 seq)`；重复帧丢弃；
 *  5. 断线重连发一次 `sync`；`head_seq` 回退（core 库回退过）清缓存、重新 `open`；
 *  6. 向上翻页：`loadMore()` 取 `oldestLoadedTurn` 之前的 5 个回合。
 *
 * 本地权威副本是 {@link TimelineState}（共享层 reducer 的状态）；store 只在提交时更新。
 */
import {
  applyTimelineFrame,
  applyTimelineSync,
  emptyTimelineState,
  timelineStateFrom,
  type SessionActivity,
  type TimelineDelta,
  type TimelineOp,
  type TimelineState,
  type TurnIndex,
} from "@armadra/shared";

import {
  PAGE_TURNS,
  TAIL_TURNS,
  isCursorAhead,
  isTimelineMissing,
  timelineTransportFor,
  type TimelineTransport,
} from "./api";
import { timelineCache, type TimelineCache } from "./cache";
import {
  EMPTY_ENTRY,
  entryFromState,
  timelineKey,
  useTimelineStore,
  type TimelineEntry,
} from "./store";

/** 缓存落盘的节流：流式输出期间不是每帧都写。 */
export const CACHE_SAVE_DELAY_MS = 2_000;
/** 页面在后台（rAF 暂停）时的兜底合并窗口。 */
export const FRAME_FALLBACK_MS = 250;
/** 积压的帧超过这个数就放弃它们，整体补同步。 */
export const MAX_PENDING_FRAMES = 1_000;
/** 失败后重试 `sync` / `open` 的间隔。 */
export const RETRY_DELAY_MS = 2_000;
/** 连续因缺口补同步的次数上限，超过后退避一次。 */
const MAX_GAP_SYNCS = 5;
/** 最后一个使用者走后保留控制器的时间，页面快速重挂不用重取。 */
export const RELEASE_GRACE_MS = 10_000;

export interface FrameScheduler {
  /** 下一帧调用 `run` 一次；返回取消函数。 */
  request(run: () => void): () => void;
}

const defaultScheduler: FrameScheduler = {
  request(run) {
    let done = false;
    let raf: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      done = true;
      if (raf !== undefined && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(raf);
      }
      if (timer !== undefined) clearTimeout(timer);
    };
    const fire = () => {
      if (done) return;
      cancel();
      run();
    };
    if (typeof requestAnimationFrame === "function") {
      raf = requestAnimationFrame(fire);
      timer = setTimeout(fire, FRAME_FALLBACK_MS);
    } else {
      timer = setTimeout(fire, 16);
    }
    return cancel;
  },
};

let scheduler: FrameScheduler = defaultScheduler;

/** 测试：换帧调度器；不传则复原。 */
export function setFrameScheduler(next?: FrameScheduler): void {
  scheduler = next ?? defaultScheduler;
}

export interface ControllerDeps {
  transport?: TimelineTransport;
  cache?: TimelineCache;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function minTurn(turns: readonly TurnIndex[], fallback: number): number {
  return turns.reduce((min, turn) => Math.min(min, turn.turn), fallback);
}

export class TimelineController {
  readonly key: string;
  private readonly transport: TimelineTransport;
  private readonly cache: TimelineCache;
  private state: TimelineState = emptyTimelineState();
  private entry: TimelineEntry = EMPTY_ENTRY;
  private ready = false;
  private disposed = false;
  private pending: TimelineDelta[] = [];
  private gapDetected = false;
  private cancelFrame: (() => void) | undefined;
  private syncing: Promise<void> | undefined;
  private syncAgain = false;
  private gapSyncs = 0;
  private generation = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private started: Promise<void> | undefined;
  private paging: Promise<number> | undefined;

  constructor(
    readonly sourceId: string,
    readonly timelineId: string,
    deps: ControllerDeps = {},
  ) {
    this.key = timelineKey(sourceId, timelineId);
    this.transport = deps.transport ?? timelineTransportFor(sourceId);
    this.cache = deps.cache ?? timelineCache();
  }

  /** 订阅 → 缓存 → 基线。幂等。 */
  start(): Promise<void> {
    this.started ??= this.boot();
    return this.started;
  }

  private async boot(): Promise<void> {
    // 先订阅：基线返回之前到的帧先缓存起来。
    this.unsubscribe = this.transport.subscribe({
      delta: (frame) => this.receive(frame),
      activity: (event) => {
        if (event.timelineId === this.timelineId) {
          useTimelineStore.getState().setActivity(this.key, event.activity);
        }
      },
      reconnected: () => this.onReconnected(),
    });
    this.publish({ phase: "loading" });
    const cached = await this.cache.load(this.sourceId, this.timelineId);
    if (this.disposed) return;
    if (cached !== undefined) {
      this.state = timelineStateFrom({
        headSeq: cached.seq,
        head: cached.head,
        headRev: cached.headRev,
        items: cached.items,
      });
      this.ready = true;
      this.publish({
        phase: "ready",
        fromCache: true,
        turns: cached.turns,
        oldestLoadedTurn: cached.oldestLoadedTurn,
      });
      await this.resync();
    } else {
      await this.openFresh();
    }
  }

  /* ------------------------------ 基线 ------------------------------ */

  private async openFresh(): Promise<void> {
    const generation = ++this.generation;
    try {
      const snapshot = await this.transport.open(this.timelineId, TAIL_TURNS);
      if (this.disposed || generation !== this.generation) return;
      this.state = timelineStateFrom({
        headSeq: snapshot.headSeq,
        head: snapshot.head,
        headRev: snapshot.headRev,
        items: snapshot.items,
      });
      this.ready = true;
      const oldest = snapshot.items.reduce(
        (min, item) => Math.min(min, item.turn),
        Number.POSITIVE_INFINITY,
      );
      if (snapshot.activity !== undefined) {
        useTimelineStore.getState().setActivity(this.key, snapshot.activity);
      }
      // 先折缓存的帧（`to <= headSeq` 的丢掉），再一次提交。
      this.drain();
      this.publish({
        phase: "ready",
        fromCache: false,
        error: undefined,
        missing: undefined,
        turns: snapshot.turns,
        oldestLoadedTurn: Number.isFinite(oldest)
          ? oldest
          : minTurn(snapshot.turns, Number.POSITIVE_INFINITY),
      });
      this.scheduleSave();
      this.afterDrain();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      if (isTimelineMissing(error)) {
        // 没有时间线不是故障：页面改走旧路径，这里不再轮询。
        this.publish({ phase: "error", error: message(error), missing: true });
        return;
      }
      this.publish({ phase: "error", error: message(error) });
      this.scheduleRetry();
    }
  }

  /** 从缓存的游标补同步。单飞：进行中再来一次只记一个“再同步”。 */
  resync(): Promise<void> {
    if (this.syncing !== undefined) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false;
          await this.syncOnce();
        } while (this.syncAgain && !this.disposed);
      } finally {
        this.syncing = undefined;
      }
    })();
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const generation = this.generation;
    try {
      const result = await this.transport.sync(this.timelineId, this.state.seq);
      if (this.disposed || generation !== this.generation) return;
      if (result.headSeq < this.state.seq) {
        await this.restart();
        return;
      }
      this.state = applyTimelineSync(this.state, result);
      this.drain();
      this.publish({
        phase: "ready",
        fromCache: false,
        error: undefined,
        missing: undefined,
      });
      this.scheduleSave();
      this.afterDrain();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      if (isTimelineMissing(error)) {
        await this.cache.remove(this.sourceId, this.timelineId);
        this.publish({ error: message(error), missing: true });
        return;
      }
      if (isCursorAhead(error)) {
        await this.restart();
        return;
      }
      this.publish({ error: message(error) });
      this.scheduleRetry();
    }
  }

  /** `head_seq` 回退（core 重启后库回退过）：清缓存，丢弃本地状态，重新 `open`。 */
  private async restart(): Promise<void> {
    this.ready = false;
    this.state = emptyTimelineState();
    this.cancelPendingFrame();
    await this.cache.remove(this.sourceId, this.timelineId);
    if (this.disposed) return;
    this.entry = EMPTY_ENTRY;
    this.publish({ phase: "loading", fromCache: false });
    await this.openFresh();
  }

  /** 页面手动重试 / 重连：没有基线就重新 `open`，否则补同步。 */
  refresh(): Promise<void> {
    if (!this.ready) return this.openFresh();
    return this.resync();
  }

  private onReconnected(): void {
    if (this.disposed || this.started === undefined) return;
    if (!this.ready && this.entry.phase !== "error") return;
    void this.refresh();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== undefined || this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.disposed) void this.refresh();
    }, RETRY_DELAY_MS);
  }

  /* ------------------------------ 帧缓冲 ------------------------------ */

  private receive(frame: TimelineDelta): void {
    if (this.disposed || frame.timelineId !== this.timelineId) return;
    this.pending.push(frame);
    if (this.pending.length > MAX_PENDING_FRAMES) {
      // 积压太多（后台页、慢设备）：与其逐帧回放不如整体补同步。
      this.pending = [];
      if (this.ready) void this.resync();
      return;
    }
    if (!this.ready || this.cancelFrame !== undefined) return;
    this.cancelFrame = scheduler.request(() => {
      this.cancelFrame = undefined;
      this.flush();
    });
  }

  private cancelPendingFrame(): void {
    this.cancelFrame?.();
    this.cancelFrame = undefined;
  }

  private flush(): void {
    if (this.disposed || !this.ready) return;
    if (this.drain()) {
      // `fromCache` 不动：还没被 core 确认的缓存内容，帧也不能让它冒充已确认。
      this.publish({ phase: "ready" });
      this.scheduleSave();
    }
    this.afterDrain();
  }

  /**
   * 把积压的帧折进本地状态（不提交）。连续的帧合成一次 `applyTimelineFrame`，所以
   * 100 帧只复制一次条目表。答是否有变化。
   */
  private drain(): boolean {
    this.gapDetected = false;
    if (this.pending.length === 0) return false;
    const frames = [...this.pending].sort(
      (a, b) => a.from - b.from || a.to - b.to,
    );
    let cursor = this.state.seq;
    const ops: TimelineOp[] = [];
    const rest: TimelineDelta[] = [];
    for (const frame of frames) {
      if (this.gapDetected) {
        rest.push(frame);
        continue;
      }
      if (frame.to <= cursor) continue;
      if (frame.from > cursor) {
        this.gapDetected = true;
        rest.push(frame);
        continue;
      }
      ops.push(...frame.ops);
      cursor = frame.to;
    }
    this.pending = rest;
    if (cursor === this.state.seq) return false;
    this.state = applyTimelineFrame(this.state, {
      from: this.state.seq,
      to: cursor,
      ops,
    }).state;
    return true;
  }

  /** 折完之后：还有缺口就补同步；干净了就清零退避计数。 */
  private afterDrain(): void {
    if (!this.gapDetected) {
      this.gapSyncs = 0;
      return;
    }
    this.gapDetected = false;
    if (this.syncing !== undefined) {
      // 进行中的同步结束后再折一次。
      this.syncAgain = true;
      return;
    }
    if (this.gapSyncs >= MAX_GAP_SYNCS) {
      this.gapSyncs = 0;
      this.scheduleRetry();
      return;
    }
    this.gapSyncs++;
    void this.resync();
  }

  /* ------------------------------ 翻页 ------------------------------ */

  /** 取 `oldestLoadedTurn` 之前的一页回合；答新加载的条目数。 */
  loadMore(turns = PAGE_TURNS): Promise<number> {
    if (this.paging !== undefined) return this.paging;
    if (!this.ready || !this.entry.hasMore) return Promise.resolve(0);
    this.paging = this.pageOnce(turns).finally(() => {
      this.paging = undefined;
    });
    return this.paging;
  }

  private async pageOnce(turns: number): Promise<number> {
    const generation = this.generation;
    const before = this.entry.oldestLoadedTurn;
    this.publish({ loadingMore: true });
    try {
      const result = await this.transport.page(this.timelineId, before, turns);
      if (this.disposed || generation !== this.generation) return 0;
      const known = Object.keys(this.state.items).length;
      this.state = applyTimelineSync(this.state, {
        headSeq: this.state.seq,
        items: result.items,
      });
      const oldest = result.items.reduce(
        (min, item) => Math.min(min, item.turn),
        Number.POSITIVE_INFINITY,
      );
      // 没有内容、或没往前推进：再往前没有可取的了，收住 `hasMore`。
      const exhausted = !Number.isFinite(oldest) || oldest >= before;
      this.publish({
        loadingMore: false,
        oldestLoadedTurn: exhausted
          ? minTurn(this.entry.turns, before)
          : oldest,
      });
      this.scheduleSave();
      return Object.keys(this.state.items).length - known;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return 0;
      this.publish({ loadingMore: false, error: message(error) });
      return 0;
    }
  }

  /* ------------------------------ 提交与缓存 ------------------------------ */

  private publish(fields: Partial<TimelineEntry>): void {
    this.entry = entryFromState(this.entry, this.state, fields);
    useTimelineStore.getState().commit(this.key, this.entry);
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined || this.disposed) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, CACHE_SAVE_DELAY_MS);
  }

  private saveNow(): void {
    if (!this.ready) return;
    void this.cache.save(this.sourceId, this.timelineId, {
      seq: this.state.seq,
      head: this.state.head,
      headRev: this.state.headRev,
      items: this.entry.order.map((id) => this.state.items[id]!),
      turns: this.entry.turns,
      oldestLoadedTurn: this.entry.oldestLoadedTurn,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.saveNow();
    }
    this.disposed = true;
    this.cancelPendingFrame();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.unsubscribe?.();
    useTimelineStore.getState().remove(this.key);
  }
}

/* ------------------------------ 共享与引用计数 ------------------------------ */

interface Slot {
  controller: TimelineController;
  refs: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

const slots = new Map<string, Slot>();

/**
 * 使用一条时间线；返回控制器与释放函数。同一条时间线的多个使用者共享一个控制器，
 * 最后一个走后保留 {@link RELEASE_GRACE_MS} 再销毁。
 */
export function acquireTimeline(
  sourceId: string,
  timelineId: string,
  deps?: ControllerDeps,
): { controller: TimelineController; release: () => void } {
  const key = timelineKey(sourceId, timelineId);
  let slot = slots.get(key);
  if (slot === undefined) {
    slot = {
      controller: new TimelineController(sourceId, timelineId, deps),
      refs: 0,
    };
    slots.set(key, slot);
    void slot.controller.start();
  }
  if (slot.releaseTimer !== undefined) {
    clearTimeout(slot.releaseTimer);
    delete slot.releaseTimer;
  }
  slot.refs++;
  const owned = slot;
  let released = false;
  return {
    controller: owned.controller,
    release() {
      if (released) return;
      released = true;
      owned.refs--;
      if (owned.refs > 0) return;
      owned.releaseTimer = setTimeout(() => {
        if (slots.get(key) === owned) slots.delete(key);
        owned.controller.dispose();
      }, RELEASE_GRACE_MS);
    },
  };
}

/** 把别处拿到的活动（`sessions.list` 的 `activity?`）灌进 store；旧版本不覆盖。 */
export function seedActivity(
  sourceId: string,
  timelineId: string,
  activity: SessionActivity,
): void {
  useTimelineStore
    .getState()
    .setActivity(timelineKey(sourceId, timelineId), activity);
}

/** 测试：销毁所有控制器并清空 store。 */
export function resetTimelines(): void {
  for (const slot of slots.values()) {
    if (slot.releaseTimer !== undefined) clearTimeout(slot.releaseTimer);
    slot.controller.dispose();
  }
  slots.clear();
  useTimelineStore.getState().reset();
}
