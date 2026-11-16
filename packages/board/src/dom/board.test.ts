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
    expect(container.querySelectorAll("[data-board-layer]").length).toBe(6);
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
    expect(svg.querySelector("rect")).not.toBeNull();
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
