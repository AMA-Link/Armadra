/**
 * 页面使用一条会话时间线（设计 §4）。挂载时 `acquireTimeline`（缓存先显示、订阅、
 * 补同步），卸载时释放；多处同时看同一条时间线共享一个控制器。
 */
import * as React from "react";
import type { TimelineHead, TimelineItem, TurnIndex } from "@armadra/shared";

import { activeSourceId } from "@/sources/scope";

import { acquireTimeline } from "./sync";
import {
  timelineKey,
  useTimelineStore,
  type TimelineEntry,
  type TimelinePhase,
} from "./store";

export interface UseTimelineOptions {
  /** 缺省当前源。 */
  sourceId?: string;
  /** 为 `false` 时不取（节点不在视口等）。 */
  enabled?: boolean;
}

export interface TimelineView {
  phase: TimelinePhase;
  /** 内容来自本地缓存，还没被 core 确认。 */
  fromCache: boolean;
  /** 按显示顺序排好的 id；结构不变时引用不变。 */
  ids: readonly string[];
  byId: Readonly<Record<string, TimelineItem>>;
  /** 按显示顺序排好的条目；行组件以 `item.rev` 做 memo。 */
  items: readonly TimelineItem[];
  /** 全部回合的索引，包括还没加载的。 */
  turns: readonly TurnIndex[];
  head: TimelineHead;
  seq: number;
  hasMore: boolean;
  loadingMore: boolean;
  error?: string;
  /** 滚到顶部附近时调：取更早的一页回合；答新加载的条目数。 */
  loadMore(): Promise<number>;
  /** 重试 / 重新补同步。 */
  refresh(): Promise<void>;
}

const NONE: Promise<number> = Promise.resolve(0);
const NO_REFRESH: Promise<void> = Promise.resolve();
const EMPTY_IDS: readonly string[] = [];
const EMPTY_BY_ID: Readonly<Record<string, TimelineItem>> = {};
const EMPTY_TURNS: readonly TurnIndex[] = [];
const EMPTY_HEAD: TimelineHead = {};

export function useTimeline(
  timelineId: string | undefined,
  options: UseTimelineOptions = {},
): TimelineView {
  const fallbackSource = activeSourceId();
  const sourceId = options.sourceId ?? fallbackSource;
  const enabled = options.enabled !== false && timelineId !== undefined;
  const key =
    timelineId === undefined ? undefined : timelineKey(sourceId, timelineId);

  const handle = React.useRef<ReturnType<typeof acquireTimeline> | null>(null);
  // 控制器在 effect 里取；render 期间只读 store。
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!enabled || timelineId === undefined) return;
    const acquired = acquireTimeline(sourceId, timelineId);
    handle.current = acquired;
    bump();
    return () => {
      acquired.release();
      if (handle.current === acquired) handle.current = null;
    };
  }, [enabled, sourceId, timelineId]);

  const entry: TimelineEntry | undefined = useTimelineStore((state) =>
    key === undefined ? undefined : state.entries[key],
  );

  const order = entry?.order;
  const byId = entry?.byId;
  const items = React.useMemo(
    () =>
      order === undefined || byId === undefined
        ? []
        : order.flatMap((id) => {
            const item = byId[id];
            return item === undefined ? [] : [item];
          }),
    [order, byId],
  );

  const loadMore = React.useCallback(
    () => handle.current?.controller.loadMore() ?? NONE,
    [],
  );
  const refresh = React.useCallback(
    () => handle.current?.controller.refresh() ?? NO_REFRESH,
    [],
  );

  return {
    phase: entry?.phase ?? "idle",
    fromCache: entry?.fromCache ?? false,
    ids: entry?.order ?? EMPTY_IDS,
    byId: entry?.byId ?? EMPTY_BY_ID,
    items,
    turns: entry?.turns ?? EMPTY_TURNS,
    head: entry?.head ?? EMPTY_HEAD,
    seq: entry?.seq ?? 0,
    hasMore: entry?.hasMore ?? false,
    loadingMore: entry?.loadingMore ?? false,
    ...(entry?.error === undefined ? {} : { error: entry.error }),
    loadMore,
    refresh,
  };
}
