import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AgentInfo } from "@armadra/shared";

const fetchAgents = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: { agents: () => fetchAgents() },
  localRuntimeApi: { agents: () => fetchAgents() },
}));

import { TestProviders } from "./test-harness";
import {
  agentIsEnabled,
  agentSwitchMode,
  usePreferencesStore,
} from "./preferences-store";
import { useEnabledAgents } from "./use-agents";

afterEach(cleanup);

const base: AgentInfo = {
  id: "claude",
  label: "Claude Code",
  color: "#d97757",
  launchCmd: "claude",
  promptMode: "argv",
  args: [],
  capabilities: ["hooks"],
  resolvedPath: "/usr/local/bin/claude",
  installed: true,
  clientRevision: 1,
};
const agents: AgentInfo[] = [
  base,
  { ...base, id: "codex", label: "Codex", installed: false },
  {
    ...base,
    id: "custom:abc",
    label: "My Claude",
    baseAgent: "claude",
  } as AgentInfo,
];

function wrapper({ children }: { children: ReactNode }) {
  return <TestProviders>{children}</TestProviders>;
}

async function enabledIds(): Promise<string[]> {
  const { result } = renderHook(() => useEnabledAgents(), { wrapper });
  await waitFor(() => expect(fetchAgents).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return result.current.map((agent) => agent.id);
}

describe("agent enable switch", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchAgents.mockReset().mockResolvedValue(agents);
    usePreferencesStore.setState({ agentModes: {} });
  });

  it("默认：已安装的开、没装的关，自定义 Agent 同一规则", async () => {
    expect(await enabledIds()).toEqual(["claude", "custom:abc"]);
  });

  it("关掉的不出现，其余不受影响；再打开回来", async () => {
    usePreferencesStore.getState().setAgentEnabled("custom:abc", false, true);
    expect(await enabledIds()).toEqual(["claude"]);
    usePreferencesStore.getState().setAgentEnabled("custom:abc", true, true);
    expect(await enabledIds()).toEqual(["claude", "custom:abc"]);
  });

  it("没装的打开后写「启用」，留在菜单里", async () => {
    usePreferencesStore.getState().setAgentEnabled("codex", true, false);
    expect(usePreferencesStore.getState().agentModes.codex).toBe("enabled");
    expect(await enabledIds()).toEqual(["claude", "codex", "custom:abc"]);
  });

  it("全部关掉：列表为空，不强留任何一家", async () => {
    const store = usePreferencesStore.getState();
    store.setAgentEnabled("claude", false, true);
    store.setAgentEnabled("custom:abc", false, true);
    expect(await enabledIds()).toEqual([]);
  });

  it("开关写本设备偏好并持久化；已装的再打开不落键", () => {
    const store = usePreferencesStore.getState();
    store.setAgentEnabled("claude", false, true);
    expect(window.localStorage.getItem("armadra.agentModes")).toBe(
      JSON.stringify({ claude: "disabled" }),
    );
    store.setAgentEnabled("claude", true, true);
    expect(usePreferencesStore.getState().agentModes).toEqual({});
    expect(window.localStorage.getItem("armadra.agentModes")).toBe("{}");
  });

  it("纯函数：开关到三态的映射与判定", () => {
    expect(agentSwitchMode(false, true)).toBe("disabled");
    expect(agentSwitchMode(false, false)).toBe("disabled");
    expect(agentSwitchMode(true, true)).toBe("default");
    expect(agentSwitchMode(true, false)).toBe("enabled");
    expect(agentIsEnabled(undefined, true)).toBe(true);
    expect(agentIsEnabled(undefined, false)).toBe(false);
    expect(agentIsEnabled("enabled", false)).toBe(true);
    expect(agentIsEnabled("disabled", true)).toBe(false);
  });
});
