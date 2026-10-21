/**
 * 会话视图读到的内容：优先走时间线（`useTimeline`），主机没有 `timeline.*`、或这条
 * 会话还没写过时间线时退回旧的 `acp.log` + `acp.update` 适配层（`useLegacyAcp`）。
 * 两条路给出同一种东西——条目、头部值、活动——渲染和投递对账都只认这个形状。
 *
 * 退路是按会话判的：`timeline.open` 答 `not_found`（或旧主机不认识）就进旧路径；旧路径
 * 里一旦收到这条会话的 `timeline.delta`，说明 core 开始写时间线了，退回新路径。旧路径
 * 在 B10 下线。
 */
import * as React from "react";
import type {
  AcpPromptCapabilities,
  SessionActivity,
  TimelineHead,
  TimelineItem,
} from "@armadra/shared";

import { onWorkspaceEvent } from "@/api/events";
import { activeSourceId } from "@/sources/scope";
import { createBlobLoader } from "@/timeline/blobs";
import { timelineKey, useTimelineStore } from "@/timeline/store";
import { useActivity } from "@/timeline/use-activity";
import {
  turnRecordOf,
  useLegacyAcp,
  useLegacyAcpStore,
} from "@/timeline/use-legacy-acp";
import { useTimeline } from "@/timeline/use-timeline";
import { acpApi } from "./api";
import type { PendingPrompt } from "./store";

export type FeedMode = "timeline" | "legacy";
export type FeedPhase = "loading" | "ready" | "failed";

export interface SessionFeed {
  mode: FeedMode;
  phase: FeedPhase;
  items: readonly TimelineItem[];
  byId: Readonly<Record<string, TimelineItem>>;
  head: TimelineHead;
  activity: SessionActivity | undefined;
  promptCapabilities: AcpPromptCapabilities | null;
  hasMore: boolean;
  /** 滚到顶部附近：取更早的一页；旧路径没有分页。 */
  loadMore(): void;
  loadBlob: (blobId: string) => Promise<Blob>;
  retry(): void;
  /**
   * 对账（契约 §39.9）：这一轮 core 收到了吗？读不到抛错；`true` = 收到了。
   * 时间线路径补一次同步看有没有回显；旧路径重读镜像看回合记录。
   */
  confirm(clientTurnId: string): Promise<boolean>;
  /** 本页发出了一句：旧路径要把它写进自己的状态；时间线路径等 core 回显。 */
  begin(sessionId: string, prompt: Omit<PendingPrompt, "at">): void;
  /** 需要附件能力时再取（时间线里没有它，只能从 `acp.log` 读）。 */
  ensureCapabilities(): void;
}

const NO_ITEMS: readonly TimelineItem[] = [];
const NO_BY_ID: Readonly<Record<string, TimelineItem>> = {};

export function useSessionFeed(options: {
  sessionId: string | null;
  nodeId: string;
  workspaceId: string | null;
  /** 为 `false` 时都不取（节点不在视口等）。 */
  enabled?: boolean;
  /**
   * 没有时间线时能不能退回 `acp.log`。终端驱动节点的只读会话内容不能：那条会话
   * 没有 ACP 镜像，没有时间线就是没有结构化内容。
   */
  legacy?: boolean;
}): SessionFeed {
  const { sessionId, nodeId, workspaceId } = options;
  const allowLegacy = options.legacy !== false;
  const enabled = options.enabled !== false && sessionId !== null;
  const sourceId = activeSourceId();

  // 判为旧路径的那条会话；会话换了自然作废。
  const [legacyFor, setLegacyFor] = React.useState<string | null>(null);
  const legacyMode = sessionId !== null && legacyFor === sessionId;

  const timeline = useTimeline(sessionId ?? undefined, {
    sourceId,
    enabled: enabled && !legacyMode,
  });
  React.useEffect(() => {
    if (timeline.missing && allowLegacy && sessionId !== null) {
      setLegacyFor(sessionId);
    }
  }, [timeline.missing, allowLegacy, sessionId]);

  // 旧路径里等时间线出现：core 开始写了就切回去，并让控制器重新 `open`。
  React.useEffect(() => {
    if (!legacyMode || sessionId === null) return;
    return onWorkspaceEvent(
      "timeline.delta",
      (event) => {
        if (event.timelineId === sessionId) setLegacyFor(null);
      },
      { allSources: true },
    );
  }, [legacyMode, sessionId]);
  const wasLegacy = React.useRef(false);
  const { refresh } = timeline;
  React.useEffect(() => {
    if (wasLegacy.current && !legacyMode) void refresh();
    wasLegacy.current = legacyMode;
  }, [legacyMode, refresh]);

  const legacy = useLegacyAcp({
    sessionId,
    nodeId,
    workspaceId,
    enabled: enabled && legacyMode,
  });
  const activity = useActivity(sessionId ?? undefined, { sourceId });
  const legacyById = React.useMemo(() => byIdOf(legacy.items), [legacy.items]);

  const [capabilities, setCapabilities] =
    React.useState<AcpPromptCapabilities | null>(null);
  const capabilitiesFor = React.useRef<string | null>(null);
  const ensureCapabilities = React.useCallback(() => {
    if (sessionId === null || capabilitiesFor.current === sessionId) return;
    capabilitiesFor.current = sessionId;
    acpApi.log(sessionId).then(
      (log) => setCapabilities(log.promptCapabilities ?? null),
      () => {
        capabilitiesFor.current = null;
      },
    );
  }, [sessionId]);

  const loadBlob = React.useMemo(
    () => createBlobLoader(sourceId, sessionId ?? ""),
    [sourceId, sessionId],
  );

  const { reread } = legacy;
  const confirm = React.useCallback(
    async (clientTurnId: string): Promise<boolean> => {
      if (sessionId === null) return false;
      if (legacyMode) {
        const log = await reread();
        return turnRecordOf(log.turns, clientTurnId) !== undefined;
      }
      await refresh();
      const entry =
        useTimelineStore.getState().entries[timelineKey(sourceId, sessionId)];
      return Object.values(entry?.byId ?? {}).some(
        (item) => item.kind === "user" && item.clientTurnId === clientTurnId,
      );
    },
    [legacyMode, reread, refresh, sessionId, sourceId],
  );

  const begin = React.useCallback(
    (id: string, prompt: Omit<PendingPrompt, "at">) => {
      if (!legacyMode) return;
      useLegacyAcpStore.getState().begin(id, {
        clientTurnId: prompt.clientTurnId,
        text: prompt.text,
        attachments: prompt.attachments,
      });
    },
    [legacyMode],
  );

  const legacyRetry = legacy.retry;
  const retry = React.useCallback(() => {
    if (legacyMode) legacyRetry();
    else void refresh();
  }, [legacyMode, legacyRetry, refresh]);

  const loadMoreTimeline = timeline.loadMore;
  const loadMore = React.useCallback(() => {
    if (!legacyMode) void loadMoreTimeline();
  }, [legacyMode, loadMoreTimeline]);

  if (legacyMode) {
    return {
      mode: "legacy",
      phase:
        legacy.phase === "ready"
          ? "ready"
          : legacy.phase === "failed"
            ? "failed"
            : "loading",
      items: legacy.items,
      byId: legacyById,
      head: legacy.head,
      activity: legacy.activity,
      promptCapabilities: legacy.promptCapabilities ?? capabilities,
      hasMore: false,
      loadMore,
      loadBlob,
      retry,
      confirm,
      begin,
      ensureCapabilities,
    };
  }
  const hasContent = timeline.items.length > 0;
  return {
    mode: "timeline",
    phase:
      timeline.phase === "ready" || hasContent
        ? "ready"
        : timeline.missing && !allowLegacy
          ? "ready"
          : timeline.phase === "error" && !timeline.missing
            ? "failed"
            : "loading",
    items: timeline.items.length === 0 ? NO_ITEMS : timeline.items,
    byId: timeline.items.length === 0 ? NO_BY_ID : timeline.byId,
    head: timeline.head,
    activity,
    promptCapabilities: capabilities,
    hasMore: timeline.hasMore,
    loadMore,
    loadBlob,
    retry,
    confirm,
    begin,
    ensureCapabilities,
  };
}

/** 旧路径的条目表：随条目数组变，供审批卡找工具。 */
function byIdOf(
  items: readonly TimelineItem[],
): Readonly<Record<string, TimelineItem>> {
  const out: Record<string, TimelineItem> = {};
  for (const item of items) out[item.id] = item;
  return out;
}
