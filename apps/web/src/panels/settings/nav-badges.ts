import * as React from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { listInvitations } from "@/api/accounts";
import { localRuntimeApi } from "@/api/client";
import { usePreferencesStore } from "@/app/preferences-store";
import { useAccess } from "@/app/use-access";
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
 * - `accounts`：待接受的邀请数（只有能管理账号的人才查）；
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
  // 账号分区成员也看得到，但邀请列表要 `identity:manage`：没有这条权限的人
  // 发了必然 403，所以不发（账号页对没有它的人同样不列邀请）。
  const access = useAccess();
  const accountsVisible = visible.has("accounts");
  const invitations = useQuery({
    queryKey: ["accounts", "invitations"],
    queryFn: listInvitations,
    enabled: accountsVisible && access.can("identity:manage"),
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
