import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 触屏上绘图工具下的捏合（#731）：两根手指不是两笔，更不是一笔杂线。
 * React Flow 与白板 store 换成最小替身，只数落进文档（与撤销栈）的对象。
 */

const dom = document.createElement("div");
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

const { resetToolStore, setTool } = await import(
  "../../interaction/tool-store"
);
const { useToolPointer } = await import("./use-tool-pointer");

function touch(
  type: string,
  id: number,
  x: number,
  y: number,
  primary: boolean,
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, "pointerId", { value: id });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  Object.defineProperty(event, "isPrimary", { value: primary });
  return event;
}

const down = (id: number, x: number, y: number, primary = id === 1) =>
  act(() => {
    dom.dispatchEvent(touch("pointerdown", id, x, y, primary));
  });
const move = (id: number, x: number, y: number, primary = id === 1) =>
  act(() => {
    window.dispatchEvent(touch("pointermove", id, x, y, primary));
  });
const up = (id: number, x: number, y: number, primary = id === 1) =>
  act(() => {
    window.dispatchEvent(touch("pointerup", id, x, y, primary));
  });

beforeEach(() => {
  document.body.append(dom);
  added.length = 0;
});

afterEach(() => {
  cleanup();
  dom.remove();
  resetToolStore();
});

describe("触屏双指捏合不留对象", () => {
  it.each(["draw", "highlight", "geo", "line", "arrow"] as const)(
    "%s：第二根手指按下就丢掉第一根已经开始的一笔",
    (tool) => {
      act(() => setTool(tool));
      renderHook(() => useToolPointer());
      down(1, 100, 100);
      move(1, 120, 130);
      down(2, 220, 200);
      move(1, 90, 90);
      move(2, 260, 240);
      up(2, 260, 240);
      up(1, 90, 90);
      expect(added).toHaveLength(0);
    },
  );

  it("文字：捏合不建文字，单指点一下才建一条", () => {
    act(() => setTool("text"));
    renderHook(() => useToolPointer());
    down(1, 100, 100);
    down(2, 220, 200);
    up(2, 220, 200);
    up(1, 100, 100);
    expect(added).toHaveLength(0);

    down(1, 100, 100);
    expect(added).toHaveLength(0);
    up(1, 101, 100);
    expect(added).toHaveLength(1);
  });

  it("文字：手指拖开不算点一下", () => {
    act(() => setTool("text"));
    renderHook(() => useToolPointer());
    down(1, 100, 100);
    move(1, 160, 100);
    up(1, 160, 100);
    expect(added).toHaveLength(0);
  });

  it("单指一笔照常落成；浏览器接管（pointercancel）的一笔丢弃", () => {
    act(() => setTool("draw"));
    renderHook(() => useToolPointer());
    down(1, 100, 100);
    move(1, 160, 160);
    up(1, 160, 160);
    expect(added).toHaveLength(1);

    down(1, 100, 100);
    move(1, 160, 160);
    act(() => {
      window.dispatchEvent(touch("pointercancel", 1, 160, 160, true));
    });
    expect(added).toHaveLength(1);
  });

  it("已经有一笔在画时再来的主指针不覆盖它", () => {
    act(() => setTool("draw"));
    renderHook(() => useToolPointer());
    down(1, 100, 100);
    move(1, 140, 140);
    // 另一种指针类型各有各的 isPrimary；这里模拟又一个 isPrimary 的按下。
    down(3, 300, 300, true);
    move(1, 180, 180);
    up(3, 300, 300, true);
    expect(added).toHaveLength(0);
    up(1, 180, 180);
    expect(added).toHaveLength(1);
  });
});
