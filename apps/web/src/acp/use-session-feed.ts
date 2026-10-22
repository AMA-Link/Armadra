/**
 * 会话视图读到的内容：只走时间线（`useTimeline`，契约 §82）。条目、头部值（模式与
 * 模型目录、提示能力、标题……由 core 写进头部）、活动，渲染和投递对账都认这个形状。
 *
 * 主机没有 `timeline.*`、或这条会话还没写过时间线时，内容就是空的：不再退回旧的
 * `acp.log` + `acp.update`（B10 已下线）。
 */
import * as React from "react";
import type {
  AcpPromptCapabilities,
  SessionActivity,
  TimelineHead,
  TimelineItem,
} from "@armadra/shared";

import { activeSourceId } from "@/sources/scope";
import { createBlobLoader } from "@/timeline/blobs";
import { timelineKey, useTimelineStore } from "@/timeline/store";
import { useActivity } from "@/timeline/use-activity";
import { useTimeline } from "@/timeline/use-timeline";

export type FeedPhase = "loading" | "ready" | "failed";

export interface SessionFeed {
  phase: FeedPhase;
  items: readonly TimelineItem[];
  byId: Readonly<Record<string, TimelineItem>>;
  head: TimelineHead;
  activity: SessionActivity | undefined;
  promptCapabilities: AcpPromptCapabilities | null;
  hasMore: boolean;
  /** 正在取更早的一页（列表顶部显示占位条）。 */
  loadingMore: boolean;
  /** 滚到顶部附近：取更早的一页。 */
  loadMore(): void;
  loadBlob: (blobId: string) => Promise<Blob>;
  retry(): void;
  /**
   * 对账（契约 §39.9）：这一轮 core 收到了吗？读不到抛错；`true` = 收到了。
   * 补一次同步，看有没有带这个 `clientTurnId` 的用户条目回显。
   */
  confirm(clientTurnId: string): Promise<boolean>;
}

const NO_ITEMS: readonly TimelineItem[] = [];
const NO_BY_ID: Readonly<Record<string, TimelineItem>> = {};

export function useSessionFeed(options: {
  sessionId: string | null;
  /** 为 `false` 时都不取（节点不在视口等）。 */
  enabled?: boolean;
}): SessionFeed {
  const { sessionId } = options;
  const enabled = options.enabled !== false && sessionId !== null;
  const sourceId = activeSourceId();

  const timeline = useTimeline(sessionId ?? undefined, { sourceId, enabled });
  const activity = useActivity(sessionId ?? undefined, { sourceId });
  const loadBlob = React.useMemo(
    () => createBlobLoader(sourceId, sessionId ?? ""),
    [sourceId, sessionId],
  );

  const { refresh } = timeline;
  const confirm = React.useCallback(
    async (clientTurnId: string): Promise<boolean> => {
      if (sessionId === null) return false;
      await refresh();
      const entry =
        useTimelineStore.getState().entries[timelineKey(sourceId, sessionId)];
      return Object.values(entry?.byId ?? {}).some(
        (item) => item.kind === "user" && item.clientTurnId === clientTurnId,
      );
    },
    [refresh, sessionId, sourceId],
  );

  const retry = React.useCallback(() => {
    void refresh();
  }, [refresh]);

  const loadMoreTimeline = timeline.loadMore;
  const loadMore = React.useCallback(() => {
    void loadMoreTimeline();
  }, [loadMoreTimeline]);

  const hasContent = timeline.items.length > 0;
  return {
    phase:
      timeline.phase === "ready" || hasContent || timeline.missing
        ? "ready"
        : timeline.phase === "error"
          ? "failed"
          : "loading",
    items: hasContent ? timeline.items : NO_ITEMS,
    byId: hasContent ? timeline.byId : NO_BY_ID,
    head: timeline.head,
    activity,
    promptCapabilities: timeline.head.promptCapabilities ?? null,
    hasMore: timeline.hasMore,
    loadingMore: timeline.loadingMore,
    loadMore,
    loadBlob,
    retry,
    confirm,
  };
}
