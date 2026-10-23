import * as React from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { listInvitations } from "@/api/accounts";
import { localRuntimeApi } from "@/api/client";
import { permits, resumeIdentity } from "@/api/identity";
import { usePreferencesStore } from "@/app/preferences-store";
import { useAgentsQuery } from "@/app/use-agents";
import { useHostConnection } from "@/host/use-host-connection";
import { selectNeedCount, useNeedsStore } from "@/notifications/needs-store";
import { agentState } from "./pages/AgentsPage";
import { integrationKey } from "./pages/integration/use-integration";

/** 导航行尾的徽标：计数（`Badge sm`）或一个提示点（`StatusDot 6`）。 */
export type NavBadge =
  | { kind: "count"; count: number }
  | { kind: "dot"; tone: "attention" };

export type NavBadges = Readonly<Record<string, NavBadge | undefined>>;

/**
 * 导航徽标（设计系统 §5.17）：只放已有 store / 查询给得出的数。
 *
 * - `notifications`：需要你处理的事（通知 store 的条数）；
 * - `agents`：需安装或需更新的 Agent CLI 数（与 Agent CLI 页的状态同一个判定）；
 * - `accounts`：待接受的邀请数（只给能管邀请的人：`identity:manage`，与账号页同一判定；
 *   成员拉邀请列表会吃 403）；
 * - `service`：本机服务连不上时一个提示点。
 *
 * 查询只对导航里真的列出的分区发（`visible`），键与对应页面一致，所以打开那一页时
 * 命中缓存。
 */
export function useSettingsNavBadges(visible: ReadonlySet<string>): NavBadges {
  const needs = useNeedsStore(selectNeedCount);
  const agentsVisible = visible.has("agents");
  const agents = useAgentsQuery("local");
  const modes = usePreferencesStore((state) => state.agentModes);
  const builtins = React.useMemo(
    () =>
      agentsVisible
        ? (agents.data ?? []).filter((agent) => !agent.baseAgent)
        : [],
    [agentsVisible, agents.data],
  );
  const integrations = useQueries({
    queries: builtins.map((agent) => ({
      queryKey: integrationKey(agent.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        localRuntimeApi.agentIntegration(agent.id, signal),
    })),
  });
  const accountsVisible = visible.has("accounts");
  const session = useQuery({
    queryKey: ["identity", "session"],
    queryFn: resumeIdentity,
    enabled: accountsVisible,
    staleTime: 30_000,
  });
  const canManage =
    session.data != null && permits(session.data, "identity:manage");
  const invitations = useQuery({
    queryKey: ["accounts", "invitations"],
    queryFn: listInvitations,
    enabled: accountsVisible && canManage,
  });
  const serviceVisible = visible.has("service");
  const { state, check } = useHostConnection();
  React.useEffect(() => {
    if (serviceVisible) void check();
  }, [serviceVisible, check]);

  return React.useMemo(() => {
    const badges: Record<string, NavBadge> = {};
    if (needs > 0) badges.notifications = { kind: "count", count: needs };
    const pendingAgents = builtins.reduce((total, agent, index) => {
      const integration = integrations[index]?.data ?? null;
      const status = agentState(
        agent,
        integration,
        modes[agent.id] ?? "default",
      );
      return status === "installNeeded" || status === "updateNeeded"
        ? total + 1
        : total;
    }, 0);
    if (pendingAgents > 0)
      badges.agents = { kind: "count", count: pendingAgents };
    const now = Date.now();
    const pendingInvites = (invitations.data ?? []).filter(
      (invitation) =>
        invitation.consumedAtMs === 0 && invitation.expiresAtMs > now,
    ).length;
    if (pendingInvites > 0)
      badges.accounts = { kind: "count", count: pendingInvites };
    if (state.status === "error")
      badges.service = { kind: "dot", tone: "attention" };
    return badges;
  }, [needs, builtins, integrations, modes, invitations.data, state.status]);
}
