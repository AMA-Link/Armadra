import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { usePreferencesStore } from "../../../app/preferences-store";

const runtime = vi.hoisted(() => ({
  data: undefined as unknown,
  mutate: vi.fn(),
}));
vi.mock("../../../api/client", () => ({ runtimeApi: {} }));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: runtime.data },
    save: { mutate: runtime.mutate, isPending: false },
  }),
}));

import { TestProviders, installDomPolyfills } from "../../../app/test-harness";
import { BareLaunchRow } from "./AgentDetailPage";

installDomPolyfills();

function draw(id: string, label: string) {
  render(
    <TestProviders>
      <BareLaunchRow agent={{ id, label }} />
    </TestProviders>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  runtime.data = { agents: {} };
  runtime.mutate.mockReset();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("设置 → Agent 零注入开关（#975）", () => {
  it("默认关，说明不可用的是什么；打开写 agents.<id>.bareLaunch", () => {
    draw("claude", "Claude Code");
    const toggle = screen.getByRole("switch", {
      name: "Claude Code 零注入启动",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("审批、画布工具与协作消息不可用")).toBeTruthy();
    fireEvent.click(toggle);
    expect(runtime.mutate).toHaveBeenCalledWith({
      agents: { claude: { bareLaunch: true } },
    });
  });

  it("设置里是开就显示开，再点写回 false", () => {
    runtime.data = { agents: { codex: { bareLaunch: true } } };
    draw("codex", "Codex");
    const toggle = screen.getByRole("switch", { name: "Codex 零注入启动" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(runtime.mutate).toHaveBeenCalledWith({
      agents: { codex: { bareLaunch: false } },
    });
  });

  it("设置没读到时不可点；自定义 Agent 没有这一行", () => {
    runtime.data = undefined;
    draw("claude", "Claude Code");
    expect(
      screen
        .getByRole("switch", { name: "Claude Code 零注入启动" })
        .hasAttribute("disabled"),
    ).toBe(true);
    cleanup();
    draw("custom:x", "Mine");
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
