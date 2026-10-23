import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

const store = vi.hoisted(() => ({
  updateNodeData: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { StickyNode } from "./StickyNode";

const node = {
  id: "n1",
  boardId: "b1",
  type: "sticky",
  title: "便签",
  color: "#ffd60a",
  position: { x: 0, y: 0 },
  data: { kind: "sticky", content: "# 标题\n\n- [x] 完成" },
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
} as CanvasNode;

function renderSticky() {
  return render(
    <StickyNode
      id="n1"
      node={node}
      selected={false}
      collapsed={false}
      focused={false}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StickyNode", () => {
  it("便签色只做顶部 3px 色条和 10% 混入卡片色的底", () => {
    const { container } = renderSticky();
    const surface = container.querySelector(
      '[data-slot="sticky-node"]',
    ) as HTMLElement;
    expect(surface.style.getPropertyValue("--sticky-color")).toBe("#ffd60a");
    expect(surface.className).toContain(
      "bg-[color-mix(in_srgb,var(--sticky-color)_10%,var(--card))]",
    );
    expect(surface.style.boxShadow).toBe("");
    const bar = container.querySelector('[data-slot="sticky-bar"]');
    expect(bar?.className).toContain("h-[3px]");
    expect(bar?.className).toContain("bg-(--sticky-color)");
  });

  it("没有 role=button 的正文；编辑入口是底栏的 ghost xs 按钮", () => {
    const { container } = renderSticky();
    expect(container.querySelector('[role="button"]')).toBeNull();
    const edit = screen.getByRole("button", { name: "编辑" });
    expect(edit.getAttribute("data-variant")).toBe("ghost");
    expect(edit.getAttribute("data-size")).toBe("xs");
  });

  it("底栏用 text-caption 等宽", () => {
    const { container } = renderSticky();
    const footer = container.querySelector(
      '[data-slot="sticky-node"] > div:last-child',
    ) as HTMLElement;
    expect(footer.className).toContain("text-caption");
    expect(footer.className).toContain("font-mono");
  });

  it("renders the content as Markdown when idle", () => {
    const { container } = renderSticky();
    expect(container.querySelector("h1")?.textContent).toBe("标题");
    expect(container.querySelector("input[type=checkbox]")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("switches to a textarea on click and commits on blur", () => {
    renderSticky();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const textarea = screen.getByLabelText("便签") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# 标题\n\n- [x] 完成");

    fireEvent.change(textarea, { target: { value: "改过了" } });
    fireEvent.blur(textarea);
    expect(store.updateNodeData).toHaveBeenCalledWith("n1", {
      content: "改过了",
    });
  });

  it("keeps someone else's concurrent edit when committing (realtime board)", () => {
    const base = {
      ...node,
      data: { kind: "sticky", content: "hello" },
    } as CanvasNode;
    const view = (current: CanvasNode) => (
      <StickyNode
        id="n1"
        node={current}
        selected={false}
        collapsed={false}
        focused={false}
      />
    );
    const { rerender } = render(view(base));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const textarea = screen.getByLabelText("便签") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello world" } });
    // 编辑期间另一个人在前面加了字（实时板的远端灌入）。
    rerender(
      view({
        ...base,
        data: { kind: "sticky", content: "say hello" },
      } as CanvasNode),
    );
    fireEvent.blur(screen.getByLabelText("便签"));
    expect(store.updateNodeData).toHaveBeenCalledWith("n1", {
      content: "say hello world",
    });
  });

  it("does not write per keystroke", () => {
    renderSticky();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const textarea = screen.getByLabelText("便签");
    for (const char of "abcdefghij") {
      fireEvent.change(textarea, {
        target: { value: (textarea as HTMLTextAreaElement).value + char },
      });
    }
    expect(store.updateNodeData).not.toHaveBeenCalled();
  });

  it("commits the draft when it is unmounted mid-edit", () => {
    const { unmount } = renderSticky();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const textarea = screen.getByLabelText("便签");
    fireEvent.change(textarea, { target: { value: "没来得及失焦" } });
    unmount();
    expect(store.updateNodeData).toHaveBeenCalledWith("n1", {
      content: "没来得及失焦",
    });
  });

  it("drops the draft on Escape", () => {
    renderSticky();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const textarea = screen.getByLabelText("便签");
    fireEvent.change(textarea, { target: { value: "不要保存" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(store.updateNodeData).not.toHaveBeenCalled();
  });

  it("shows a relative timestamp instead of a character count", () => {
    const { container } = renderSticky();
    expect(container.textContent).not.toMatch(/字|characters/);
    expect(container.textContent).toMatch(/月|年|天|小时|分钟|刚刚/);
  });
});
