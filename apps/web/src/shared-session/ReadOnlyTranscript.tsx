import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { acpLogResponseSchema } from "@armadra/shared";

import { clientFor } from "@/api/client";
import { connectWorkspaceEvents } from "@/api/events";
import type { Source } from "@/api/source";
import { useT } from "@/app/preferences-store";
import { createBlobLoader } from "@/timeline/blobs";
import { useActivity } from "@/timeline/use-activity";
import { useTimeline } from "@/timeline/use-timeline";
import { emptyLegacyState, fromLog, itemsOf } from "@/timeline/legacy-acp";
import { TimelineView } from "@/timeline/view/TimelineView";
import { Spinner } from "@/ui/spinner";

/** 旧主机（没有 `timeline.*`）才用：多久重读一次镜像。新主机靠推送，不轮询。 */
const LEGACY_POLL_MS = 2_000;

/**
 * ACP 会话的只读转录（契约 §43.1、§79）：订阅这条会话的时间线，画同一个
 * `TimelineView`——没有输入框、审批与 elicitation 按钮，消息上只有复制。
 *
 * 访客没有画布，也就没有工作空间的事件流：这里自己订那一块工作空间的事件
 * （`timeline.delta` / `timeline.activity`），断线重连由数据层补同步。旧主机没有
 * 时间线，退回按 `acp.log` 读镜像（那一条仍是定时读，B10 随旧接口下线）。
 */
export function ReadOnlyTranscript({
  source,
  sessionId,
  workspaceId,
}: {
  source: Source;
  sessionId: string;
  workspaceId?: string | undefined;
}) {
  const t = useT();
  const sourceId = source.sourceId;
  React.useEffect(
    () =>
      workspaceId === undefined || workspaceId === ""
        ? undefined
        : connectWorkspaceEvents(workspaceId, source),
    [source, workspaceId],
  );

  const timeline = useTimeline(sessionId, { sourceId });
  const activity = useActivity(sessionId, { sourceId });
  const loadBlob = React.useMemo(
    () => createBlobLoader(sourceId, sessionId),
    [sourceId, sessionId],
  );
  const services = React.useMemo(() => ({ loadBlob }), [loadBlob]);

  const { loadMore, hasMore } = timeline;
  const loadOlder = React.useCallback(() => void loadMore(), [loadMore]);
  const legacy = timeline.missing;
  const log = useQuery({
    queryKey: ["shared-session", "acp-log", sourceId, sessionId],
    queryFn: async () =>
      acpLogResponseSchema.parse(
        await clientFor(source).acp.log({ sessionId, after: 0 }),
      ),
    enabled: legacy,
    refetchInterval: LEGACY_POLL_MS,
    retry: false,
  });
  const legacyItems = React.useMemo(
    () =>
      log.data
        ? itemsOf(fromLog(log.data, emptyLegacyState(), Date.now()))
        : [],
    [log.data],
  );

  const items = legacy ? legacyItems : timeline.items;
  const ready = legacy ? log.data !== undefined : timeline.phase === "ready";
  const failed = legacy
    ? log.isError && log.data === undefined
    : timeline.phase === "error" && items.length === 0;
  if (items.length === 0 && !ready) {
    return (
      <div className="flex h-full items-center justify-center">
        {failed ? (
          <p className="text-muted-foreground">{t("sharedSession.failed")}</p>
        ) : (
          <Spinner
            aria-label={t("sharedSession.loading")}
            className="size-4 text-muted-foreground"
          />
        )}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-center text-muted-foreground">
          {t("sharedSession.empty")}
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
      <TimelineView
        items={items}
        activity={legacy ? undefined : activity}
        services={services}
        resetKey={sessionId}
        onLoadOlder={hasMore ? loadOlder : undefined}
      />
    </div>
  );
}
