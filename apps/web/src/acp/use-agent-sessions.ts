import * as React from "react";
import type { AcpAgentSession } from "@armadra/shared";

import { acpApi } from "./api";

export type AgentSessionsPhase = "loading" | "ready" | "failed";

/** 翻页拼起来：同一个会话 id 只留第一次出现的。 */
export function mergeSessions(
  have: readonly AcpAgentSession[],
  next: readonly AcpAgentSession[],
): AcpAgentSession[] {
  const seen = new Set(have.map((session) => session.sessionId));
  return [...have, ...next.filter((session) => !seen.has(session.sessionId))];
}

/**
 * 读 Agent 自己历史里的会话（`session/list`）：打开时读第一页，`more` 按游标续读。
 * `agentId` 为 `null` 时什么也不读（对话框没开）。
 */
export function useAgentSessions(
  workspaceId: string | null,
  agentId: string | null,
  cwd: string | undefined,
) {
  const [phase, setPhase] = React.useState<AgentSessionsPhase>("loading");
  const [sessions, setSessions] = React.useState<AcpAgentSession[]>([]);
  const [cursor, setCursor] = React.useState<string | undefined>();
  const [paging, setPaging] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (workspaceId === null || agentId === null) return;
    let cancelled = false;
    setPhase("loading");
    setSessions([]);
    setCursor(undefined);
    acpApi
      .listAgentSessions(workspaceId, agentId, cwd ? { cwd } : {})
      .then((page) => {
        if (cancelled) return;
        setSessions(mergeSessions([], page.sessions));
        setCursor(page.nextCursor);
        setPhase("ready");
      })
      .catch(() => {
        if (!cancelled) setPhase("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, agentId, cwd, attempt]);

  const more = React.useCallback(() => {
    if (workspaceId === null || agentId === null || !cursor || paging) return;
    setPaging(true);
    acpApi
      .listAgentSessions(workspaceId, agentId, {
        ...(cwd ? { cwd } : {}),
        cursor,
      })
      .then((page) => {
        setSessions((have) => mergeSessions(have, page.sessions));
        setCursor(page.nextCursor);
      })
      .catch(() => setCursor(undefined))
      .finally(() => setPaging(false));
  }, [workspaceId, agentId, cwd, cursor, paging]);

  return {
    phase,
    sessions,
    hasMore: cursor !== undefined,
    paging,
    more,
    retry: () => setAttempt((value) => value + 1),
  };
}
