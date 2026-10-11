import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentInfo } from "@armadra/shared";
import { localRuntimeApi, runtimeApi } from "../api/client";
import { LOCAL_SOURCE_ID } from "../api/source";
import { srcKey } from "../sources/scope";
import { setAgentRegistry } from "../agent/launch";
import { ensureCoreHost } from "./core-host";
import { agentIsEnabled, usePreferencesStore } from "./preferences-store";

/**
 * `GET /api/agents` 的共享查询。Dock 的新建菜单、命令面板与设置页都读它，
 * react-query 保证只发一次请求。
 *
 * 拿到结果后同步推给 `agent/launch`：自定义 Agent 的名字、颜色与启动程序
 * 只有这个接口知道，而查显示名的地方（节点头、画布卡、会话卡）都是同步的。
 */
export function useAgentsQuery(scope: "current" | "local" = "current") {
  const local = scope === "local";
  const query = useQuery({
    // 设置页（除「当前工作空间」外）看的是本机的 Agent 清单，不随打开的工作空间变。
    queryKey: local ? srcKey(LOCAL_SOURCE_ID, "agents") : ["agents"],
    queryFn: local ? localRuntimeApi.agents : runtimeApi.agents,
    staleTime: 60_000,
    retry: false,
  });
  const agents = query.data;
  useEffect(() => {
    // 注册表是启动用的：只由当前源的清单推。
    if (agents && !local) setAgentRegistry(agents);
  }, [agents, local]);
  // 启动行按 core 的缺省 shell 引用（`agent/launch.ts::launchDialect`），在
  // 第一个节点要敲行之前先问到。
  useEffect(() => {
    ensureCoreHost();
  }, []);
  return query;
}

/**
 * 新建菜单里该出现的 Agent（§24.1 Agent 页的三态）。
 *
 * `default` 跟随本机检测，`enabled` 即使没检测到也保留（配合自定义启动命令），
 * `disabled` 一律不列。
 */
export function useEnabledAgents(): AgentInfo[] {
  const agents = useAgentsQuery();
  const modes = usePreferencesStore((state) => state.agentModes);
  return useMemo(
    () =>
      (agents.data ?? []).filter((agent) =>
        agentIsEnabled(modes[agent.id], agent.installed),
      ),
    [agents.data, modes],
  );
}
