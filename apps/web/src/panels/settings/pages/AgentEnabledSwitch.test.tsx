import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "../../../app/preferences-store";
import { installDomPolyfills } from "../../../app/test-harness";
import { AgentEnabledSwitch } from "./AgentDetailPage";

installDomPolyfills();

function draw(current: unknown[] | undefined, installed: boolean | undefined) {
  const client = new QueryClient();
  if (current) client.setQueryData(["agents"], current);
  render(
    <QueryClientProvider client={client}>
      <AgentEnabledSwitch agent={{ id: "codex", label: "Codex", installed }} />
    </QueryClientProvider>,
  );
  return screen.getByRole("switch", { name: "Codex 启用" });
}

beforeEach(() => {
  window.localStorage.clear();
  usePreferencesStore.setState({ locale: "zh-CN", agentModes: {} });
});
afterEach(cleanup);

describe("AgentEnabledSwitch（#734）", () => {
  it("本机装了、当前来源（远端工作空间）没装：从关到开写「启用」，才进得了它的菜单", () => {
    usePreferencesStore.setState({ agentModes: { codex: "disabled" } });
    const toggle = draw([{ id: "codex", installed: false }], true);
    fireEvent.click(toggle);
    expect(usePreferencesStore.getState().agentModes.codex).toBe("enabled");
  });

  it("本机与当前来源都装了：写回「默认」，继续跟随检测", () => {
    usePreferencesStore.setState({ agentModes: { codex: "disabled" } });
    const toggle = draw([{ id: "codex", installed: true }], true);
    fireEvent.click(toggle);
    expect(usePreferencesStore.getState().agentModes).toEqual({});
  });

  it("当前来源的清单没取到：只信本机检测", () => {
    usePreferencesStore.setState({ agentModes: { codex: "disabled" } });
    const toggle = draw(undefined, true);
    fireEvent.click(toggle);
    expect(usePreferencesStore.getState().agentModes).toEqual({});
  });

  it("检测结果没到：开关不可点", () => {
    const toggle = draw(undefined, undefined);
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(usePreferencesStore.getState().agentModes).toEqual({});
  });
});
