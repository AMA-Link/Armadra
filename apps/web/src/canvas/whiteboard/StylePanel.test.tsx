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
    const large = screen.getByRole("radio", { name: "L" });
    fireEvent.click(large);
    expect(large.getAttribute("aria-checked")).toBe("true");
  });
});
