// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSelectTool, createHandTool } from "../gestures/tools";
import { box, makeBoard, NO_MODS } from "../gestures/testing";
import type { Tool } from "../types";
import { createInputRouter, type InputRouterDeps } from "./router";

const setup = (
  tool?: (deps: Record<string, unknown>) => Tool,
  extra: Partial<InputRouterDeps> = {},
) => {
  const t = makeBoard([box("a", 100, 100), box("b", 400, 100)]);
  const container = document.createElement("div");
  container.innerHTML = `<div data-board-id="a" class="a"><i data-board-handle="se" class="se"></i><input data-board-editable class="in" /></div><div data-board-id="b" class="b"></div>`;
  document.body.append(container);
  container.setPointerCapture = vi.fn();
  let mods = NO_MODS;
  const current = (tool ?? ((d) => createSelectTool(d)))({});
  const router = createInputRouter(container, {
    board: t.board,
    tool: () => current,
    modifiers: () => mods,
    inputDevice: () => "trackpad",
    ...extra,
  });
  const fire = (type: string, target: Element, init: PointerEventInit = {}) => {
    const e = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      ...init,
    });
    target.dispatchEvent(e);
    return e;
  };
  const q = (s: string) => container.querySelector(s)!;
  return {
    ...t,
    container,
    router,
    fire,
    q,
    setMods: (m: Partial<typeof NO_MODS>) => void (mods = { ...NO_MODS, ...m }),
  };
};

describe("输入路由器", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("点实体：按下接管并捕获指针，抬起发 select，gesture 事件成对", () => {
    const s = setup();
    const down = s.fire("pointerdown", s.q(".a"), {
      clientX: 120,
      clientY: 120,
    });
    expect(down.defaultPrevented).toBe(true);
    expect(s.container.setPointerCapture).toHaveBeenCalledWith(1);
    s.fire("pointerup", s.q(".a"), { clientX: 120, clientY: 120 });
    expect(s.of("select")).toEqual([{ ids: ["a"], additive: false }]);
    expect(s.of("gesture")).toEqual([{ active: true }, { active: false }]);
  });

  it("拖动实体：世界坐标随相机换算，结束发 move", () => {
    const s = setup();
    s.camera.set({ x: 50, y: 0, zoom: 2 });
    s.fire("pointerdown", s.q(".a"), { clientX: 300, clientY: 300 });
    s.fire("pointermove", s.container, { clientX: 340, clientY: 360 });
    s.fire("pointerup", s.container, { clientX: 340, clientY: 360 });
    const move = s.of("move")[0] as {
      positions: Map<string, { x: number; y: number }>;
    };
    expect(move.positions.get("a")).toEqual({ x: 120, y: 130 });
  });

  it("空白框选；可编辑区不接管、不拦默认行为", () => {
    const s = setup();
    s.fire("pointerdown", s.container, { clientX: 10, clientY: 10 });
    s.fire("pointermove", s.container, { clientX: 200, clientY: 200 });
    s.fire("pointerup", s.container, { clientX: 200, clientY: 200 });
    expect(s.of("select")).toEqual([{ ids: ["a"], additive: false }]);
    const e = s.fire("pointerdown", s.q(".in"), { pointerId: 2 });
    expect(e.defaultPrevented).toBe(false);
    expect(s.of("gesture")).toHaveLength(2);
  });

  it("空格由外部修饰键提供：空格 + 左键拖动平移；锁定后不动", () => {
    const s = setup();
    s.setMods({ space: true });
    s.fire("pointerdown", s.container, { clientX: 0, clientY: 0 });
    s.fire("pointermove", s.container, { clientX: 30, clientY: 20 });
    expect(s.camera.get()).toMatchObject({ x: 30, y: 20 });
    s.camera.locked = true;
    s.fire("pointermove", s.container, { clientX: 90, clientY: 90 });
    s.fire("pointerup", s.container, { clientX: 90, clientY: 90 });
    expect(s.camera.get()).toMatchObject({ x: 30, y: 20 });
  });

  it("pointercancel、lostpointercapture、窗口失焦都取消手势并清预览", () => {
    for (const cancel of [
      (s: ReturnType<typeof setup>) => s.fire("pointercancel", s.container),
      (s: ReturnType<typeof setup>) =>
        s.fire("lostpointercapture", s.container),
      () => window.dispatchEvent(new Event("blur")),
    ]) {
      const s = setup();
      s.fire("pointerdown", s.q(".a"), { clientX: 120, clientY: 120 });
      s.fire("pointermove", s.container, { clientX: 300, clientY: 300 });
      expect(s.scene.gestureActive()).toBe(true);
      cancel(s);
      expect(s.scene.gestureActive()).toBe(false);
      s.fire("pointerup", s.container, { clientX: 300, clientY: 300 });
      expect(s.of("move")).toEqual([]);
      expect(s.of("gesture").at(-1)).toEqual({ active: false });
    }
  });

  it("第二根手指：没有 add 的手势被取消，换成 pinch（缩放）", () => {
    const s = setup();
    s.fire("pointerdown", s.q(".a"), {
      pointerId: 1,
      pointerType: "touch",
      clientX: 120,
      clientY: 120,
    });
    s.fire("pointermove", s.container, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 400,
      clientY: 400,
    });
    s.fire("pointerdown", s.container, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 500,
      clientY: 400,
    });
    expect(s.scene.gestureActive()).toBe(false);
    s.fire("pointermove", s.container, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 600,
      clientY: 400,
    });
    expect(s.camera.get().zoom).toBeCloseTo(1 + 100 / 100);
    s.fire("pointerup", s.container, { pointerId: 1, pointerType: "touch" });
    s.fire("pointermove", s.container, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    expect(s.camera.get().zoom).toBeCloseTo(2);
    s.fire("pointerup", s.container, { pointerId: 2, pointerType: "touch" });
    expect(s.of("gesture").at(-1)).toEqual({ active: false });
  });

  it("触屏长按空白发 context-menu，不触发后续 select", () => {
    const s = setup();
    s.fire("pointerdown", s.q(".b"), {
      pointerType: "touch",
      clientX: 410,
      clientY: 110,
      timeStamp: 0,
    } as PointerEventInit);
    vi.advanceTimersByTime(500);
    expect(s.of("context-menu")).toEqual([
      {
        target: { type: "entity", id: "b", part: "body" },
        screen: { x: 410, y: 110 },
        world: { x: 410, y: 110 },
      },
    ]);
    s.fire("pointerup", s.q(".b"), {
      pointerType: "touch",
      clientX: 410,
      clientY: 110,
    });
    expect(s.of("select")).toEqual([]);
    expect(s.of("gesture").at(-1)).toEqual({ active: false });
  });

  it("鼠标右键与双击：发 context-menu / double-click，输入区放手", () => {
    const s = setup();
    const menu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 410,
      clientY: 110,
    });
    s.q(".b").dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(s.of("context-menu")).toHaveLength(1);
    s.q(".b").dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, clientX: 410, clientY: 110 }),
    );
    expect(s.of("double-click")).toEqual([
      {
        target: { type: "entity", id: "b", part: "body" },
        world: { x: 410, y: 110 },
      },
    ]);
    const inField = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    s.q(".in").dispatchEvent(inField);
    expect(inField.defaultPrevented).toBe(false);
    expect(s.of("context-menu")).toHaveLength(1);
  });

  it("可整体替换 resolveTarget；手形工具在任何位置平移；destroy 摘掉监听", () => {
    const s = setup((d) => createHandTool(d), {
      resolveTarget: () => ({ type: "editable" }),
    });
    s.fire("pointerdown", s.q(".a"), { clientX: 0, clientY: 0 });
    s.fire("pointermove", s.container, { clientX: 15, clientY: 5 });
    expect(s.camera.get()).toMatchObject({ x: 15, y: 5 });
    s.fire("pointerup", s.container);
    s.router.destroy();
    s.fire("pointerdown", s.q(".a"), { clientX: 0, clientY: 0 });
    s.fire("pointermove", s.container, { clientX: 99, clientY: 5 });
    expect(s.camera.get().x).toBe(15);
    expect(s.container.style.touchAction).toBe("");
  });
});
