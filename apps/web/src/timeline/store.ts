/**
 * 时间线的读模型（设计 §4「增量渲染」）：按 `(sourceId, timelineId)` 分键，条目以
 * `id → item` 的表加有序 id 数组存放，行组件以 `item.rev` 做 memo。
 *
 * 写入只经 `sync.ts`：一个动画帧内的 `timeline.delta` 合并成一次 {@link
 * TimelineStoreState.commit}。没有新增 / 删除 / 挪位的帧复用上一次的 `order`
 * 数组，所以流式文本不触发列表重排。
 */
import {
  compareActivityRev,
  compareTimelineItems,
  turnIndexOf,
  type SessionActivity,
  type TimelineHead,
  type TimelineItem,
  type TimelineState,
  type TurnIndex,
} from "@armadra/shared";
import { create } from "zustand";

import { cacheKey } from "./cache";

export type TimelinePhase = "idle" | "loading" | "ready" | "error";

export interface TimelineEntry {
  readonly phase: TimelinePhase;
  /** 当前内容来自本地缓存，还没有被 core 确认。 */
  readonly fromCache: boolean;
  readonly seq: number;
  readonly head: TimelineHead;
  readonly headRev: number;
  /** 条目表；键是条目 id。 */
  readonly byId: Readonly<Record<string, TimelineItem>>;
  /** 按显示顺序排好的 id；没有结构变化时与上一次是同一个数组。 */
  readonly order: readonly string[];
  /** 全部回合的索引（含没加载的）。 */
  readonly turns: readonly TurnIndex[];
  /** 已加载的最早回合。 */
  readonly oldestLoadedTurn: number;
  /** 还有更早的回合没加载。 */
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly error?: string;
  /** core 答这条会话没有时间线（或主机太旧不认识）：页面退回旧路径，不再重试。 */
  readonly missing?: boolean;
}

export const EMPTY_ENTRY: TimelineEntry = {
  phase: "idle",
  fromCache: false,
  seq: 0,
  head: {},
  headRev: 0,
  byId: {},
  order: [],
  turns: [],
  oldestLoadedTurn: 0,
  hasMore: false,
  loadingMore: false,
};

export function hasEarlierTurns(
  turns: readonly TurnIndex[],
  oldestLoadedTurn: number,
): boolean {
  return turns.some((turn) => turn.turn < oldestLoadedTurn);
}

/** 有序 id：结构没变（同一批 id、同样的 turn / ord）就沿用 `prev`。 */
export function nextOrder(
  prev: readonly string[],
  prevItems: Readonly<Record<string, TimelineItem>>,
  next: Readonly<Record<string, TimelineItem>>,
): readonly string[] {
  let dirty = Object.keys(next).length !== prev.length;
  if (!dirty) {
    for (const id of prev) {
      const after = next[id];
      const before = prevItems[id];
      if (after === undefined || before === undefined) {
        dirty = true;
        break;
      }
      if (
        after !== before &&
        (after.turn !== before.turn || after.ord !== before.ord)
      ) {
        dirty = true;
        break;
      }
    }
  }
  if (!dirty) return prev;
  return Object.values(next)
    .sort(compareTimelineItems)
    .map((item) => item.id);
}

/** 回合索引补上快照里没有的新回合（流式中新开的回合）。 */
export function extendTurns(
  turns: readonly TurnIndex[],
  items: readonly TimelineItem[],
): readonly TurnIndex[] {
  const known = new Set(turns.map((turn) => turn.turn));
  const extra = turnIndexOf(items).filter((turn) => !known.has(turn.turn));
  if (extra.length === 0) return turns;
  return [...turns, ...extra].sort((a, b) => a.turn - b.turn);
}

export interface TimelineStoreState {
  readonly entries: Readonly<Record<string, TimelineEntry>>;
  readonly activities: Readonly<Record<string, SessionActivity>>;
  /** 整条换上；`sync.ts` 每个动画帧至多调一次。 */
  commit(key: string, entry: TimelineEntry): void;
  patch(key: string, patch: Partial<TimelineEntry>): void;
  /** `timeline.activity` / `open` / `sessions.list` 带来的活动；版本旧的不覆盖。 */
  setActivity(key: string, activity: SessionActivity): void;
  remove(key: string): void;
  reset(): void;
}

/** 由本地状态（`sync.ts` 持有的权威副本）生成要提交的条目。 */
export function entryFromState(
  prev: TimelineEntry,
  state: TimelineState,
  fields: Partial<TimelineEntry> = {},
): TimelineEntry {
  const order = nextOrder(prev.order, prev.byId, state.items);
  const turns = fields.turns ?? prev.turns;
  const oldestLoadedTurn = fields.oldestLoadedTurn ?? prev.oldestLoadedTurn;
  const nextTurns =
    order === prev.order
      ? turns
      : extendTurns(
          turns,
          order.map((id) => state.items[id]!),
        );
  return {
    ...prev,
    ...fields,
    seq: state.seq,
    head: state.head,
    headRev: state.headRev,
    byId: state.items,
    order,
    turns: nextTurns,
    oldestLoadedTurn,
    hasMore: hasEarlierTurns(nextTurns, oldestLoadedTurn),
  };
}

export const useTimelineStore = create<TimelineStoreState>((set, get) => ({
  entries: {},
  activities: {},
  commit: (key, entry) =>
    set((state) => ({ entries: { ...state.entries, [key]: entry } })),
  patch: (key, patch) =>
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: { ...(state.entries[key] ?? EMPTY_ENTRY), ...patch },
      },
    })),
  setActivity: (key, activity) => {
    const current = get().activities[key];
    if (current !== undefined) {
      const order = compareActivityRev(activity.rev, current.rev);
      // 同一个 bootId 下旧的丢掉；bootId 不同（core 重启过）取后到的。
      if (order !== null && order <= 0) return;
    }
    set((state) => ({ activities: { ...state.activities, [key]: activity } }));
  },
  remove: (key) =>
    set((state) => {
      if (!(key in state.entries)) return state;
      const entries = { ...state.entries };
      delete entries[key];
      return { entries };
    }),
  reset: () => set({ entries: {}, activities: {} }),
}));

/** store 键：与缓存键同一个。 */
export const timelineKey = cacheKey;
