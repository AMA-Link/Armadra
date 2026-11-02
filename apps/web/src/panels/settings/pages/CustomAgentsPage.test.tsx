import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { usePreferencesStore } from "../../../app/preferences-store";

const runtime = vi.hoisted(() => ({
  custom: [] as unknown[],
  detected: [] as unknown[] | undefined,
  mutate: vi.fn(),
}));
vi.mock("../../../api/client", () => ({ runtimeApi: {} }));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: { agents: { custom: runtime.custom } } },
    save: { mutate: runtime.mutate, isPending: false },
  }),
}));
vi.mock("../../../app/use-agents", () => ({
  useAgentsQuery: () => ({ data: runtime.detected }),
}));

import { TestProviders, installDomPolyfills } from "../../../app/test-harness";
import { CustomAgentsPage } from "./CustomAgentsPage";

installDomPolyfills();

function draw() {
  render(
    <TestProviders>
      <CustomAgentsPage />
    </TestProviders>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN", settingsSubpage: null });
  runtime.custom = [];
  runtime.detected = [];
  runtime.mutate.mockReset();
  usePreferencesStore.setState({ agentModes: {} });
  window.localStorage.clear();
});
afterEach(cleanup);

describe("设置 → 自定义 Agent", () => {
  it("空态一句话加「添加」，点了推入新建子页", () => {
    draw();
    expect(screen.getByText("还没有自定义 Agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(usePreferencesStore.getState().settingsSubpage).toBe("agent:new");
  });

  it("空态只有一个「添加」；有数据时「添加」在页头，列表是表格卡", () => {
    draw();
    expect(screen.getAllByRole("button", { name: "添加" })).toHaveLength(1);
    expect(
      document.querySelector("[data-slot=settings-page-header] button"),
    ).toBeNull();
    cleanup();
    runtime.custom = [
      {
        id: "custom:abc",
        label: "我的 Agent",
        launchCmd: "my-agent",
        args: [],
        baseAgent: "claude",
      },
    ];
    draw();
    expect(
      document.querySelector("[data-slot=settings-page-header] button")
        ?.textContent,
    ).toBe("添加");
    const card = document.querySelector("[data-slot=settings-table-card]");
    expect(card?.getAttribute("data-variant")).toBe("table");
    expect(
      [...(card?.querySelectorAll("th") ?? [])].map((cell) => cell.textContent),
    ).toEqual(["名称", "基础 Agent", "命令", "编辑自定义 Agent", "启用"]);
    expect(card?.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("每条一个启用开关：探测到的默认开，关掉写进偏好，不改自定义配置", () => {
    runtime.custom = [
      {
        id: "custom:abc",
        label: "我的 Agent",
        launchCmd: "my-agent",
        args: [],
        baseAgent: "claude",
      },
      {
        id: "custom:def",
        label: "没装的",
        launchCmd: "nope",
        args: [],
        baseAgent: "codex",
      },
    ];
    runtime.detected = [
      { id: "custom:abc", installed: true },
      { id: "custom:def", installed: false },
    ];
    draw();
    const first = screen.getByRole("switch", { name: "我的 Agent 启用" });
    const second = screen.getByRole("switch", { name: "没装的 启用" });
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(second.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(first);
    fireEvent.click(second);
    expect(usePreferencesStore.getState().agentModes).toEqual({
      "custom:abc": "disabled",
      "custom:def": "enabled",
    });
    // 只改偏好：不写 Runtime 设置，自定义配置原样保留。
    expect(runtime.mutate).not.toHaveBeenCalled();
  });

  it("探测结果没到时开关不可点，点了也不写偏好（#734）", () => {
    runtime.custom = [
      {
        id: "custom:abc",
        label: "我的 Agent",
        launchCmd: "my-agent",
        args: [],
        baseAgent: "claude",
      },
    ];
    runtime.detected = undefined;
    draw();
    const toggle = screen.getByRole("switch", { name: "我的 Agent 启用" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(usePreferencesStore.getState().agentModes).toEqual({});
  });

  it("一条一行，点一行进编辑子页，删除放在子页页尾", () => {
    runtime.custom = [
      {
        id: "custom:abc",
        label: "我的 Agent",
        launchCmd: "my-agent",
        args: [],
        baseAgent: "claude",
      },
    ];
    draw();
    expect(screen.getByText("my-agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /我的 Agent/ }));
    expect(usePreferencesStore.getState().settingsSubpage).toBe(
      "agent:custom:abc",
    );
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "我的 Agent",
    );
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
  });
});
