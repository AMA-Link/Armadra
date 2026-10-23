import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import type { AgentInfo, Workspace } from "@armadra/shared";

const fetchAgents = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: { agents: () => fetchAgents() },
}));
const zoomByStep = vi.hoisted(() => vi.fn());
vi.mock("../canvas/flow/use-flow-viewport", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../canvas/flow/use-flow-viewport")
  >()),
  zoomByStep,
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { usePreferencesStore } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { initialPanels } from "../store/canvas/internal";
import { MAX_ZOOM, MIN_ZOOM } from "../canvas/zoom";
import { setFlow } from "../canvas/flow/flow-context";
import { Dock, TidyButton, ZoomControls } from "./Dock";

installDomPolyfills();
afterEach(cleanup);

const now = new Date().toISOString();
const workspace: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "alpha",
  rootPath: "/tmp/alpha",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: now,
  createdAt: now,
  updatedAt: now,
};

const claude: AgentInfo = {
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

describe("Dock", () => {
  beforeEach(() => {
    fetchAgents.mockReset().mockResolvedValue([claude]);
    usePreferencesStore.setState({ agentModes: {} });
    useCanvasStore.setState({ workspace, saveState: "saved" });
  });

  it("没有工作空间时不渲染", () => {
    useCanvasStore.setState({ workspace: null });
    const { container } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    expect(container.querySelector("[data-slot='dock']")).toBeNull();
  });

  it("点开 `+` 会展开新建菜单", async () => {
    render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    const add = screen.getByLabelText("新建");
    fireEvent.keyDown(add, { key: "Enter" });
    expect(await screen.findByText("新建终端")).toBeTruthy();
  });

  it("选区有 ≥ 2 个顶层单元时「整理」改叫「整理选中」", () => {
    useCanvasStore.setState({ selectedNodeIds: ["a"], selectedItemIds: [] });
    const { rerender } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    expect(screen.getByLabelText("一键整理")).toBeTruthy();
    useCanvasStore.setState({
      selectedNodeIds: ["a"],
      selectedItemIds: ["wb:b"],
    });
    rerender(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    expect(screen.getByLabelText("整理选中")).toBeTruthy();
    useCanvasStore.setState({ selectedNodeIds: [], selectedItemIds: [] });
  });

  it("撤销/重做在画布未挂载时禁用", () => {
    render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    expect(screen.getByLabelText("撤销").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("重做").hasAttribute("disabled")).toBe(true);
  });

  it("保存状态只用一个点表示", () => {
    const { container } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    const dot = container.querySelector("[data-slot='save-dot']");
    expect(dot?.getAttribute("data-state")).toBe("saved");
    expect(dot?.textContent).toBe("");
  });

  it("Dock 是 12 圆角、1px 强边、浮层阴影", () => {
    const { container } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    const dock = container.querySelector("[data-slot='dock']")!;
    for (const name of [
      "rounded-panel",
      "border-border-strong",
      "shadow-overlay",
    ])
      expect(dock.classList.contains(name)).toBe(true);
  });

  it("保存点是 6px 的状态点，未保存为注意色、已保存为完成色", () => {
    useCanvasStore.setState({ saveState: "dirty" });
    const { container, rerender } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    const dot = () => container.querySelector("[data-slot='save-dot']")!;
    expect(dot().getAttribute("data-size")).toBe("6");
    expect(dot().getAttribute("aria-label")).toBe("未保存");
    useCanvasStore.setState({ saveState: "saved" });
    rerender(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    expect(dot().getAttribute("aria-label")).toBe("已保存");
  });

  it("保存指示灯报的是保存态本身", () => {
    useCanvasStore.setState({ saveState: "dirty" });
    const { container } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    const dot = container.querySelector("[data-slot='save-dot']");
    expect(dot?.getAttribute("data-state")).toBe("dirty");
  });
});

/** §58：右侧抽屉盖住 Dock 右端，底部那一行要让开它。 */
describe("Dock 让开右侧工作面板", () => {
  beforeEach(() => {
    fetchAgents.mockReset().mockResolvedValue([claude]);
    useCanvasStore.setState({ workspace, saveState: "saved" });
  });
  afterEach(() => {
    useCanvasStore.setState({ panels: initialPanels });
  });

  const row = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".canvas-dock-row");

  it("没有面板时不改位置", () => {
    useCanvasStore.setState({ panels: initialPanels });
    const { container } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    expect(row(container)?.style.right).toBe("");
    expect(row(container)?.hasAttribute("data-panel-inset")).toBe(false);
  });

  it("开着抽屉时右端让到抽屉左边", () => {
    useCanvasStore.setState({
      panels: { ...initialPanels, explorer: "drawer" },
    });
    const { container } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    expect(row(container)?.style.right).toBe(
      "calc(14px + min(100vw, var(--drawer-w)))",
    );
    expect(row(container)?.getAttribute("data-panel-inset")).toBe("true");
  });
});

describe("缩放段 [−] [NN%] [+]", () => {
  beforeEach(() => zoomByStep.mockClear());

  it("− / + 按一档缩放，中间是当前百分比", () => {
    render(
      <TestProviders>
        <ZoomControls zoom={0.8} />
      </TestProviders>,
    );
    expect(screen.getByLabelText("适应").textContent).toBe("80%");
    fireEvent.click(screen.getByLabelText("缩小"));
    expect(zoomByStep).toHaveBeenLastCalledWith(-1);
    fireEvent.click(screen.getByLabelText("放大"));
    expect(zoomByStep).toHaveBeenLastCalledWith(1);
  });

  it("到最小 / 最大缩放时对应一侧禁用", () => {
    const { rerender } = render(
      <TestProviders>
        <ZoomControls zoom={MIN_ZOOM} />
      </TestProviders>,
    );
    expect(screen.getByLabelText("缩小").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("放大").hasAttribute("disabled")).toBe(false);
    rerender(
      <TestProviders>
        <ZoomControls zoom={MAX_ZOOM} />
      </TestProviders>,
    );
    expect(screen.getByLabelText("缩小").hasAttribute("disabled")).toBe(false);
    expect(screen.getByLabelText("放大").hasAttribute("disabled")).toBe(true);
  });

  it("Dock 里挂着这一段", () => {
    useCanvasStore.setState({ workspace, saveState: "saved" });
    render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    expect(screen.getByLabelText("缩小")).toBeTruthy();
    expect(screen.getByLabelText("放大")).toBeTruthy();
  });
});

describe("工具组与缩放百分比", () => {
  beforeEach(() => {
    fetchAgents.mockReset().mockResolvedValue([claude]);
    useCanvasStore.setState({ workspace, saveState: "saved" });
  });
  afterEach(() => setFlow(null));

  it("画布挂载后工具组里有一块共享指示器", () => {
    setFlow({} as ReactFlowInstance);
    const { container } = render(
      <TestProviders>
        <Dock />
      </TestProviders>,
    );
    const expanded = container.querySelector(".dock-tools-expanded")!;
    expect(expanded.querySelectorAll("[data-slot='indicator']")).toHaveLength(
      1,
    );
  });

  it("缩放百分比用 TextSwap 渲染，数字等宽", () => {
    render(
      <TestProviders>
        <ZoomControls zoom={0.8} />
      </TestProviders>,
    );
    const fit = screen.getByLabelText("适应");
    expect(fit.querySelector("[data-slot='text-swap']")?.textContent).toBe(
      "80%",
    );
    expect(fit.classList.contains("tabular-nums")).toBe(true);
  });
});

describe("整理钮的右键菜单（ui-wave2 §4.2）", () => {
  it("纵向 / 横向整理各跑一次 canvas.tidy，期间方向被覆盖、之后复原", async () => {
    const { registerCanvasCommand } = await import("../canvas/commands");
    const { layoutDirection, setLayoutDirectionForTest } = await import(
      "../canvas/layout-direction"
    );
    setLayoutDirectionForTest("vertical");
    const seen: string[] = [];
    const off = registerCanvasCommand("canvas.tidy", () => {
      seen.push(layoutDirection());
    });
    render(
      <TestProviders>
        <TidyButton label="整理画布" />
      </TestProviders>,
    );
    const button = screen.getByLabelText("整理画布");
    fireEvent.click(button);
    fireEvent.contextMenu(button);
    fireEvent.click(await screen.findByText("横向整理"));
    fireEvent.contextMenu(button);
    fireEvent.click(await screen.findByText("纵向整理"));
    expect(seen).toEqual(["vertical", "horizontal", "vertical"]);
    expect(layoutDirection()).toBe("vertical");
    off();
  });
});
