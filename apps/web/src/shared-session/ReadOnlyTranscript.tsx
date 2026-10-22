import * as React from "react";

import type {
  TimelineApprovalItem,
  TimelineElicitationItem,
} from "@armadra/shared";
import { connectWorkspaceEvents } from "@/api/events";
import type { Source } from "@/api/source";
import { useT } from "@/app/preferences-store";
import { createBlobLoader } from "@/timeline/blobs";
import { useActivity } from "@/timeline/use-activity";
import { useTimeline } from "@/timeline/use-timeline";
import { TimelineView } from "@/timeline/view/TimelineView";
import { Spinner } from "@/ui/spinner";
import {
  ApprovalCard,
  ElicitationItemCard,
  ToolLookupProvider,
} from "@/acp/TimelineCards";

/**
 * ACP 会话的只读转录（契约 §43.1、§79）：订阅这条会话的时间线，画同一个
 * `TimelineView`——没有输入框、审批与 elicitation 按钮，消息上只有复制。
 *
 * 访客没有画布，也就没有工作空间的事件流：这里自己订那一块工作空间的事件
 * （`timeline.delta` / `timeline.activity`），断线重连由数据层补同步。旧主机没有
 * 时间线，退回按 `acp.log` 读镜像（那一条仍是定时读，B10 随旧接口下线）。
 */
/** 只读：同一张卡，按钮换成「等待接管」（没有答复权限的人看到的就是这样）。 */
const renderApproval = (approval: TimelineApprovalItem) => (
  <ApprovalCard approval={approval} canAnswer={false} />
);
const renderElicitation = (item: TimelineElicitationItem) => (
  <ElicitationItemCard item={item} canAnswer={false} />
);

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
  const byId = React.useMemo(
    () => Object.fromEntries(items.map((item) => [item.id, item])),
    [items],
  );
  const ready = timeline.phase === "ready" || timeline.missing;
  const failed = timeline.phase === "error" && items.length === 0;
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
      <ToolLookupProvider value={byId}>
        <TimelineView
          items={items}
          activity={activity}
          services={services}
          resetKey={sessionId}
          onLoadOlder={hasMore ? loadOlder : undefined}
          renderApproval={renderApproval}
          renderElicitation={renderElicitation}
        />
      </ToolLookupProvider>
    </div>
  );
}
