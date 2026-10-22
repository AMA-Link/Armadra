import * as React from "react";

import { connectWorkspaceEvents } from "@/api/events";
import type { Source } from "@/api/source";
import { useT } from "@/app/preferences-store";
import { createBlobLoader } from "@/timeline/blobs";
import { useActivity } from "@/timeline/use-activity";
import { useTimeline } from "@/timeline/use-timeline";
import { TimelineView } from "@/timeline/view/TimelineView";
import { Loadable } from "@/loading/Loadable";
import { SharedSessionBodySkeleton } from "./SharedSessionSkeleton";

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
  const items = timeline.items;
  const ready = timeline.phase === "ready" || timeline.missing;
  const failed = timeline.phase === "error" && items.length === 0;
  if (items.length === 0 && !ready) {
    return failed ? (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">{t("sharedSession.failed")}</p>
      </div>
    ) : (
      <Loadable
        loading
        className="h-full"
        skeleton={<SharedSessionBodySkeleton />}
      >
        {null}
      </Loadable>
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
        activity={activity}
        services={services}
        resetKey={sessionId}
        onLoadOlder={hasMore ? loadOlder : undefined}
      />
    </div>
  );
}
