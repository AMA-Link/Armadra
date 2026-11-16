// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entity } from "../core";
import { createBoard } from "./board";
import type { DomKindSpec, Tool } from "./types";

const card: DomKindSpec = { layer: "world" };
const dot: DomKindSpec = { layer: "canvas-under", paint: () => {} };
const entity = (id: string, kind = "card", x = 0, y = 0): Entity => ({
  id,
  kind,
  x,
  y,
  w: 100,
  h: 80,
  z: 0,
  data: null,
});

const setup = (
  entities: Entity[] = [entity("a"), entity("b", "card", 300)],
) => {
  const board = createBoard({ kinds: { card, dot } });
  board.scene.transact((d) => entities.forEach((e) => d.set(e)), {
    history: "ignore",
  });
  const container = document.createElement("div");
  document.body.append(container);
  container.setPointerCapture = vi.fn();
  return { board, container };
};

const fire = (el: Element, type: string, init: PointerEventInit = {}) =>
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      ...init,
    }),
  );

beforeEach(() => {
  // jsdom 没有 2D 上下文；painter 对 null 上下文按空操作处理。
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("createBoard", () => {
  it("挂载后建出分层与世界层宿主，卸载后全部拆除", () => {
    const { board, container } = setup();
    board.mount(container);
    expect(container.querySelectorAll("[data-board-layer]").length).toBe(7);
    expect(board.hostOf("a")?.dataset.boardId).toBe("a");
    expect(board.hostOf("a")?.parentElement).toBe(
      container.querySelector("[data-board-layer=world]"),
    );
    board.destroy();
    expect(container.children.length).toBe(0);
    expect(board.hostOf("a")).toBeUndefined();
    expect(container.style.touchAction).toBe("");
  });

  it("重复 mount 先拆旧的，不留双份", () => {
    const { board, container } = setup();
    board.mount(container);
    board.mount(container);
    expect(container.querySelectorAll("[data-board-layer=world]").length).toBe(
      1,
    );
    board.destroy();
  });

  it("canvas 层实体没有宿主", () => {
    const { board, container } = setup([entity("d", "dot")]);
    board.mount(container);
    expect(board.hostOf("d")).toBeUndefined();
    board.destroy();
  });

  it("相机变化转发成 camera 事件，退订后不再收到", () => {
    const { board, container } = setup();
    board.mount(container);
    const seen = vi.fn();
    const off = board.on("camera", seen);
    board.camera.panBy(10, 0);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    board.camera.panBy(10, 0);
    expect(seen).toHaveBeenCalledTimes(1);
    board.destroy();
  });

  it("select 事件缺省写进选区，监听方照样收到", () => {
    const { board } = setup();
    const seen = vi.fn();
    board.on("select", seen);
    board.emit("select", { ids: ["a", "b"], additive: false });
    expect([...board.selection()]).toEqual(["a", "b"]);
    expect(seen).toHaveBeenCalledOnce();
    board.setSelection(new Set(["b"]));
    expect([...board.selection()]).toEqual(["b"]);
  });

  it("hosts 事件随宿主增减发出，setSelection 发 selection 事件", () => {
    const { board, container } = setup([entity("a")]);
    board.mount(container);
    const hosts = vi.fn();
    const selection = vi.fn();
    board.on("hosts", hosts);
    board.on("selection", selection);
    board.scene.transact((d) => d.set(entity("c", "card", 500)), {
      history: "ignore",
    });
    expect(hosts).toHaveBeenLastCalledWith({ added: ["c"], removed: [] });
    board.scene.transact((d) => d.remove("c"), { history: "ignore" });
    expect(hosts).toHaveBeenLastCalledWith({ added: [], removed: ["c"] });
    board.setSelection(new Set(["a"]));
    expect(selection).toHaveBeenLastCalledWith({ ids: ["a"] });
    board.destroy();
  });

  it("slots 在挂载后给出叠加层插槽，卸载后为 null", () => {
    const { board, container } = setup();
    expect(board.slots()).toBeNull();
    board.mount(container);
    const slots = board.slots()!;
    expect(slots.worldHtml.dataset.boardLayer).toBe("overlay-world-html");
    expect(slots.worldSvg.dataset.boardLayer).toBe("overlay-world");
    board.camera.set({ x: 5, y: 6, zoom: 2 });
    expect(slots.worldHtml.style.transform).toBe(
      slots.worldSvg.style.transform,
    );
    board.destroy();
    expect(board.slots()).toBeNull();
  });

  it("selectors 补充的选择器按可编辑区放手，滚轮也不拦", () => {
    const board = createBoard({
      kinds: { card },
      selectors: { editable: ".nodrag", nowheel: ".nowheel" },
    });
    board.scene.transact((d) => d.set(entity("a")), { history: "ignore" });
    const container = document.createElement("div");
    document.body.append(container);
    container.setPointerCapture = vi.fn();
    board.mount(container);
    const inner = document.createElement("div");
    inner.className = "nodrag nowheel";
    board.hostOf("a")!.append(inner);
    fire(inner, "pointerdown", { clientX: 10, clientY: 10 });
    expect(board.gestureActive()).toBe(false);
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 40,
    });
    inner.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    board.destroy();
  });

  it("nativeContextMenu：右键事件交给应用，引擎不 preventDefault 但照发事件", () => {
    const board = createBoard({ kinds: { card }, nativeContextMenu: true });
    board.scene.transact((d) => d.set(entity("a")), { history: "ignore" });
    const container = document.createElement("div");
    document.body.append(container);
    board.mount(container);
    const seen = vi.fn();
    board.on("context-menu", seen);
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    board.hostOf("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(seen).toHaveBeenCalledOnce();
    board.destroy();
  });

  it("置顶的 Canvas 对象先于 DOM 宿主命中；置底的在宿主之下", () => {
    const over: DomKindSpec = { layer: "canvas-over", paint: () => {} };
    const board = createBoard({ kinds: { card, dot, over } });
    board.scene.transact(
      (d) => {
        d.set(entity("a"));
        d.set(entity("o", "over", 20, 20));
        d.set(entity("u", "dot", 300, 0));
      },
      { history: "ignore" },
    );
    const container = document.createElement("div");
    document.body.append(container);
    container.setPointerCapture = vi.fn();
    board.mount(container);
    const picked: string[] = [];
    board.on("select", ({ ids }) => picked.push(...ids));
    const host = board.hostOf("a")!;
    // 指针位置 (30,30) 同时落在宿主 a 与置顶对象 o 上；containter 在 jsdom 里原点是 (0,0)。
    fire(host, "pointerdown", { clientX: 30, clientY: 30 });
    fire(host, "pointerup", { clientX: 30, clientY: 30 });
    expect(picked).toEqual(["o"]);
    // 置顶对象之外的点仍然归宿主。
    picked.length = 0;
    fire(host, "pointerdown", { clientX: 5, clientY: 5 });
    fire(host, "pointerup", { clientX: 5, clientY: 5 });
    expect(picked).toEqual(["a"]);
    board.destroy();
  });

  it("invalidate 在未挂载时是空操作，挂载后触发重绘", () => {
    const { board, container } = setup();
    expect(() => board.invalidate()).not.toThrow();
    board.mount(container);
    expect(() => board.invalidate()).not.toThrow();
    board.destroy();
  });

  it("gesture 事件维护 gestureActive", () => {
    const { board } = setup();
    expect(board.gestureActive()).toBe(false);
    board.emit("gesture", { active: true });
    expect(board.gestureActive()).toBe(true);
    board.emit("gesture", { active: false });
    expect(board.gestureActive()).toBe(false);
  });

  it("点击实体宿主：缺省选择工具发 select 并写入选区", () => {
    const { board, container } = setup();
    board.mount(container);
    const host = board.hostOf("a")!;
    fire(host, "pointerdown", { clientX: 10, clientY: 10 });
    expect(board.gestureActive()).toBe(true);
    fire(host, "pointerup", { clientX: 10, clientY: 10 });
    expect(board.gestureActive()).toBe(false);
    expect([...board.selection()]).toEqual(["a"]);
    board.destroy();
  });

  it("拖动：先发 move 再清预览，监听方能同步写回", () => {
    const { board, container } = setup();
    board.mount(container);
    const host = board.hostOf("a")!;
    let previewAtMove: unknown;
    board.on("move", () => {
      previewAtMove = board.scene.previewOf("a");
    });
    fire(host, "pointerdown", { clientX: 10, clientY: 10 });
    fire(host, "pointermove", { clientX: 60, clientY: 40 });
    expect(board.scene.previewOf("a")).toEqual({ x: 50, y: 30 });
    fire(host, "pointerup", { clientX: 60, clientY: 40 });
    expect(previewAtMove).toEqual({ x: 50, y: 30 });
    expect(board.scene.previewOf("a")).toBeUndefined();
    board.destroy();
  });

  it("切换工具取消进行中的手势并清掉预览", () => {
    const { board, container } = setup();
    board.mount(container);
    const host = board.hostOf("a")!;
    fire(host, "pointerdown", { clientX: 10, clientY: 10 });
    fire(host, "pointermove", { clientX: 60, clientY: 40 });
    expect(board.scene.gestureActive()).toBe(true);
    const idle: Tool = { id: "idle", cursor: "crosshair", begin: () => null };
    board.setTool(idle);
    expect(board.gestureActive()).toBe(false);
    expect(board.scene.gestureActive()).toBe(false);
    expect(container.style.cursor).toBe("crosshair");
    board.destroy();
  });

  it("框选反馈画进叠加层，结束后移除", () => {
    const { board, container } = setup();
    board.mount(container);
    const svg = container.querySelector("[data-board-layer=overlay-world]")!;
    fire(container, "pointerdown", { clientX: 200, clientY: 200 });
    fire(container, "pointermove", { clientX: 250, clientY: 260 });
    const rect = svg.querySelector("rect")!;
    expect(rect.getAttribute("width")).toBe("50");
    expect(rect.getAttribute("height")).toBe("60");
    fire(container, "pointerup", { clientX: 250, clientY: 260 });
    expect(svg.children.length).toBe(0);
    board.destroy();
  });

  it("setOptions 影响手势：只读时拖动不发 move", () => {
    const { board, container } = setup();
    board.mount(container);
    board.setOptions({ readOnly: true });
    const moved = vi.fn();
    board.on("move", moved);
    const host = board.hostOf("a")!;
    fire(host, "pointerdown", { clientX: 10, clientY: 10 });
    fire(host, "pointermove", { clientX: 60, clientY: 40 });
    fire(host, "pointerup", { clientX: 60, clientY: 40 });
    expect(moved).not.toHaveBeenCalled();
    board.destroy();
  });

  it("setModifiers 的空格让左键拖动变成平移", () => {
    const { board, container } = setup();
    board.mount(container);
    board.setModifiers({ space: true });
    const before = board.camera.get();
    fire(container, "pointerdown", { clientX: 10, clientY: 10 });
    fire(container, "pointermove", { clientX: 40, clientY: 30 });
    fire(container, "pointerup", { clientX: 40, clientY: 30 });
    const after = board.camera.get();
    expect(after.x - before.x).toBe(30);
    expect(after.y - before.y).toBe(20);
    board.destroy();
  });

  it("destroy 后相机与事件都不再转发", () => {
    const { board, container } = setup();
    board.mount(container);
    const seen = vi.fn();
    board.on("camera", seen);
    board.destroy();
    board.camera.panBy(5, 5);
    expect(seen).not.toHaveBeenCalled();
  });

  it("gestureDeps 暴露给应用工具：选项实时生效、种类表可查", () => {
    const { board } = setup();
    expect(board.gestureDeps.kind?.("card")?.layer).toBe("world");
    board.setOptions({ grid: 8 });
    expect(board.gestureDeps.options?.().grid).toBe(8);
  });

  it("rasterize 空集合报错", async () => {
    const { board } = setup();
    await expect(board.rasterize([])).rejects.toThrow("nothing to rasterize");
  });
});
