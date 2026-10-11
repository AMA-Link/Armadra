import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 工具粘住（2026-10-11 用户反馈）：画笔、形状、线、文字用一次之后不能自己
 * 跳回选择，连续用下去一直是同一个工具；换工具只认用户的显式动作。
 *
 * React Flow 与白板 store 换成最小替身：这里只盯「落成之后工具是谁」，
 * 落成规则本身由 `draft.test.ts` 管。
 */

const dom = document.createElement("div");

// 与真实的 React Flow 一样返回稳定引用，否则每次重渲染都会重挂指针监听。
const flow = {
  screenToFlowPosition: (point: { x: number; y: number }) => point,
  getZoom: () => 1,
};
const storeApi = { getState: () => ({ domNode: dom }) };
vi.mock("@xyflow/react", () => ({
  useReactFlow: () => flow,
  useStoreApi: () => storeApi,
}));

const added: unknown[] = [];
vi.mock("../store", () => ({
  addItems: (items: unknown[]) => {
    added.push(...items);
    return [];
  },
  createItemId: () => crypto.randomUUID(),
  select: () => undefined,
}));

const { getTool, resetToolStore, setTool } = await import(
  "../../interaction/tool-store"
);
const { useToolPointer } = await import("./use-tool-pointer");
const { registerEscapeToSelect } = await import("../../escape-to-select");
const { setCanvasLocked } = await import("../../canvas-lock");

function pointer(type: string, x: number, y: number): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  return event;
}

/** 在画布上按下、拖一段、松手——一次完整的绘制手势。 */
function stroke(from: number, to: number): void {
  act(() => {
    dom.dispatchEvent(pointer("pointerdown", from, from));
  });
  act(() => {
    window.dispatchEvent(pointer("pointermove", to, to));
    window.dispatchEvent(pointer("pointerup", to, to));
  });
}

beforeEach(() => {
  document.body.append(dom);
  added.length = 0;
});

afterEach(() => {
  cleanup();
  dom.remove();
  setCanvasLocked(false);
  resetToolStore();
});

describe("工具粘住", () => {
  it.each(["draw", "highlight", "geo", "line", "arrow"] as const)(
    "%s：连画三次，每次都落成，工具一直不变",
    (tool) => {
      act(() => setTool(tool));
      renderHook(() => useToolPointer());

      for (let index = 0; index < 3; index += 1) {
        stroke(10 + index * 200, 120 + index * 200);
        expect(getTool()).toBe(tool);
      }
      expect(added).toHaveLength(3);
    },
  );

  it("文字：连点三处放三段文字，工具一直是文字", () => {
    act(() => setTool("text"));
    renderHook(() => useToolPointer());

    for (let index = 0; index < 3; index += 1) {
      act(() => {
        dom.dispatchEvent(pointer("pointerdown", index * 100, 0));
      });
      expect(getTool()).toBe("text");
    }
    expect(added).toHaveLength(3);
  });

  it("手形与选择不经过工具层，用多少次都还是自己", () => {
    for (const tool of ["hand", "select"] as const) {
      act(() => setTool(tool));
      renderHook(() => useToolPointer());
      stroke(0, 100);
      stroke(200, 300);
      expect(getTool()).toBe(tool);
    }
    expect(added).toHaveLength(0);
  });

  it("显式切换照常生效：换工具、Esc 回选择", () => {
    act(() => setTool("draw"));
    renderHook(() => useToolPointer());
    stroke(0, 100);
    expect(getTool()).toBe("draw");

    act(() => setTool("geo"));
    stroke(200, 300);
    expect(getTool()).toBe("geo");

    const dispose = registerEscapeToSelect({ container: dom });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    dispose();
    expect(getTool()).toBe("select");
    expect(added).toHaveLength(2);
  });

  it("画布重新挂载不重置当前工具", () => {
    act(() => setTool("arrow"));
    const first = renderHook(() => useToolPointer());
    stroke(0, 100);
    first.unmount();

    renderHook(() => useToolPointer());
    expect(getTool()).toBe("arrow");
    stroke(200, 300);
    expect(getTool()).toBe("arrow");
  });
});
