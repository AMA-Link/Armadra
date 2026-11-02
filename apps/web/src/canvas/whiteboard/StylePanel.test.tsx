import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { TooltipProvider } from "@/ui/tooltip";

/**
 * 样式面板：语义圆角与字号、没有原生 `title`（提示走 Tooltip）。
 * canvas-store 与白板 store 换成最小替身，这里只看渲染结构。
 */
const canvasState = vi.hoisted(() => ({
  selectedItemIds: [] as string[],
  whiteboard: { items: [] as unknown[] },
}));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: <T,>(selector: (state: typeof canvasState) => T) =>
    selector(canvasState),
}));
vi.mock("./store", () => ({ updateItems: vi.fn() }));

const { CanvasStylePanel } = await import("./StylePanel");
const { resetToolStore, setTool } = await import("../interaction/tool-store");

installDomPolyfills();

beforeEach(() => {
  canvasState.selectedItemIds = [];
  canvasState.whiteboard.items = [];
  resetToolStore();
  act(() => setTool("draw"));
});
afterEach(cleanup);

describe("白板样式面板", () => {
  it("面板是语义圆角，不再写任意值", () => {
    render(
      <TooltipProvider>
        <CanvasStylePanel />
      </TooltipProvider>,
    );
    const panel = document.querySelector(".canvas-style-panel");
    expect(panel).not.toBeNull();
    expect(panel?.className).toContain("rounded-panel");
    expect(panel?.className).not.toMatch(/rounded-lg|var\(--panel\)/);
  });

  it("分组标签用 text-caption，控件不带原生 title", () => {
    render(
      <TooltipProvider>
        <CanvasStylePanel />
      </TooltipProvider>,
    );
    const panel = document.querySelector(".canvas-style-panel")!;
    expect(panel.querySelector("[title]")).toBeNull();
    expect(panel.innerHTML).not.toContain("text-[length:");
  });

  it("粗细档按钮可选，点击后切换选中态", () => {
    render(
      <TooltipProvider>
        <CanvasStylePanel />
      </TooltipProvider>,
    );
    const large = screen.getByRole("radio", { name: /\bL$/ });
    fireEvent.click(large);
    expect(large.getAttribute("aria-checked")).toBe("true");
  });

  it("单行条：锚在 Dock 上方那一行里，是 toolbar，没有可见的分组标题", () => {
    render(
      <TooltipProvider>
        <CanvasStylePanel />
      </TooltipProvider>,
    );
    const panel = document.querySelector(".canvas-style-panel")!;
    expect(panel.parentElement?.className).toBe("canvas-style-row");
    expect(panel.getAttribute("role")).toBe("toolbar");
    // 标题只在 aria-label 与提示里，条里没有文字节点。
    expect(panel.textContent).toBe("");
    // 颜色是一个按钮（色板在 Popover 里，没点开就不渲染），不再平铺一整片。
    expect(screen.queryByRole("radiogroup", { name: "颜色" })).toBeNull();
    expect(screen.getByRole("button", { name: "颜色" })).toBeTruthy();
  });

  it("选中的是文字：有对齐，没有线型与填充", () => {
    canvasState.selectedItemIds = ["wb:t"];
    canvasState.whiteboard.items = [
      { id: "t", kind: "text", text: "你好", style: { align: "middle" } },
    ];
    render(
      <TooltipProvider>
        <CanvasStylePanel />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("radio", { name: "居中" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("radio", { name: "实线" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "无填充" })).toBeNull();
  });

  it("选中的只有空文字（双击空白刚建出来）：不显示", () => {
    canvasState.selectedItemIds = ["wb:t"];
    canvasState.whiteboard.items = [
      { id: "t", kind: "text", text: "", style: {} },
    ];
    render(
      <TooltipProvider>
        <CanvasStylePanel />
      </TooltipProvider>,
    );
    expect(document.querySelector(".canvas-style-panel")).toBeNull();
  });
});
