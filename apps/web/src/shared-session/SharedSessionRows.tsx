import { useQuery } from "@tanstack/react-query";
import { SquareTerminal } from "lucide-react";

import { clientFor } from "@/api/client";
import { agentLabel } from "@/agent/launch";
import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import {
  type SharedSession,
  sourceNamed,
  useSessionShareQuery,
  useSharedSessionView,
} from "./sessions";

/**
 * 侧栏「他人分享」里一台没有工作空间的主机：列出分享给我的会话（契约 §79），
 * 点开是只读查看页。不是会话查看者时什么都不画。
 */
export function SharedSessionRows({
  sourceId,
  usable,
}: {
  sourceId: string;
  usable: boolean;
}) {
  const query = useSessionShareQuery(sourceId, usable);
  const share = query.data;
  if (!share || share.sessions.length === 0) return null;
  return (
    <ul data-shared-sessions={sourceId}>
      {share.sessions.map((session) => (
        <li key={session.sessionId}>
          <SessionRow sourceId={sourceId} session={session} />
        </li>
      ))}
    </ul>
  );
}

function SessionRow({
  sourceId,
  session,
}: {
  sourceId: string;
  session: SharedSession;
}) {
  const t = useT();
  const open = useSharedSessionView((state) => state.open);
  const current = useSharedSessionView(
    (state) =>
      state.target?.sourceId === sourceId &&
      state.target.sessionId === session.sessionId,
  );
  const row = useQuery({
    queryKey: ["shared-session", "row", sourceId, session.sessionId],
    queryFn: () =>
      clientFor(sourceNamed(sourceId)!).terminals.get({
        sessionId: session.sessionId,
      }),
    enabled: sourceNamed(sourceId) !== undefined,
    retry: false,
  });
  const label =
    agentLabel(row.data?.agentId ?? undefined) ||
    row.data?.command ||
    t("sharedSession.session");
  // 行标签先是通用名后换成 agent 名会跳：行没到之前用一条骨架占着。
  const pending = row.isLoading;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-shared-session={session.sessionId}
      aria-current={current || undefined}
      className="w-full justify-start gap-2 px-1.5 font-normal aria-[current]:bg-sidebar-accent"
      onClick={() => open({ sourceId, ...session })}
    >
      <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
      {pending ? (
        <Skeleton className="h-3 w-24" />
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
    </Button>
  );
}
