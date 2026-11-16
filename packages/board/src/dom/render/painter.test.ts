// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryScene,
  screenToWorld,
  visibleRect,
  type CameraState,
  type Entity,
} from "../../core";
import type { Camera, DomKindSpec } from "../types";
import type { RenderEnv } from "./env";
import { createLayers } from "./layers";
import { createPainter, dotGap } from "./painter";

/** 记录调用的假 2D 上下文。 */
function fakeCtx(): Record<string, unknown> & { calls: string[] } {
  const calls: string[] = [];
  const target: Record<string, unknown> = { calls };
  return new Proxy(target, {
    get: (t, key: string) =>
      key in t
        ? t[key]
        : (...args: unknown[]) => calls.push(`${key}(${args.join(",")})`),
    set: (t, key: string, value) => {
      t[key] = value;
      calls.push(`${key}=${String(value)}`);
      return true;
    },
  }) as never;
}

function fakeCamera(state: CameraState, size = { width: 200, height: 100 }) {
  const listeners = new Set<(s: CameraState) => void>();
  const camera = {
    get: () => state,
    set(next: CameraState) {
      state = next;
      for (const l of listeners) l(state);
    },
    visible: () => visibleRect(state, size),
    screenToWorld: (p: { x: number; y: number }) => screenToWorld(state, p),
    subscribe(l: (s: CameraState) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return camera as unknown as Camera & { set(s: CameraState): void };
}

function setup(state: CameraState = { x: 0, y: 0, zoom: 1 }) {
  const ctxs = new Map<HTMLCanvasElement, ReturnType<typeof fakeCtx>>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      if (!ctxs.has(this)) ctxs.set(this, fakeCtx());
      return ctxs.get(this) as never;
    },
  );
  const frames: Array<() => void> = [];
  const env: RenderEnv = {
    raf: (cb) => frames.push(cb),
    caf: (h) => {
      frames[h - 1] = () => {};
    },
    observe: () => () => {},
    dpr: () => 2,
  };
  const container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", { value: 200 });
  Object.defineProperty(container, "clientHeight", { value: 100 });
  const layers = createLayers(container, env);
  const paints: string[] = [];
  const spec = (
    layer: "canvas-under" | "canvas-over" | "world",
  ): DomKindSpec => ({
    layer,
    paint: (_ctx, e, penv) =>
      paints.push(`${e.id}@${e.x},${e.y}${penv.selected ? "*" : ""}`),
  });
  const specs: Record<string, DomKindSpec> = {
    under: spec("canvas-under"),
    over: spec("canvas-over"),
    card: spec("world"),
  };
  const scene = createMemoryScene({ kinds: (k) => specs[k] });
  const camera = fakeCamera(state);
  const run = () => {
    const batch = frames.splice(0);
    for (const f of batch) f();
  };
  const painter = createPainter({
    layers,
    scene,
    camera,
    env,
    kind: (k) => specs[k],
    settings: { dots: false },
  });
  return { layers, scene, camera, painter, paints, ctxs, frames, run };
}

const make = (id: string, patch: Partial<Entity> = {}): Entity => ({
  id,
  kind: "under",
  x: 0,
  y: 0,
  w: 20,
  h: 20,
  z: 0,
  data: null,
  ...patch,
});

afterEach(() => vi.restoreAllMocks());

describe("createPainter", () => {
  it("按层、再按 z 序画；只画可见区内的对象；world 层实体不画", () => {
    const { scene, painter, paints } = setup();
    scene.transact((d) => {
      d.set(make("b", { z: 2 }));
      d.set(make("a", { z: 1 }));
      d.set(make("far", { x: 5000 }));
      d.set(make("top", { kind: "over" }));
      d.set(make("node", { kind: "card" }));
    });
    painter.flush();
    expect(paints).toEqual(["a@0,0", "b@0,0", "top@0,0"]);
  });

  it("相机矩阵 = dpr × 缩放；先清屏", () => {
    const { layers, painter, ctxs, camera } = setup();
    camera.set({ x: 30, y: 10, zoom: 2 });
    painter.flush();
    const calls = ctxs.get(layers.under)!.calls;
    expect(calls).toContain("setTransform(4,0,0,4,60,20)");
    expect(calls.indexOf("clearRect(0,0,400,200)")).toBeLessThan(
      calls.indexOf("setTransform(4,0,0,4,60,20)"),
    );
  });

  it("一帧内多次标脏只重绘一次；相机与场景变化都会标脏", () => {
    const { scene, painter, camera, frames, run, paints } = setup();
    run();
    scene.transact((d) => d.set(make("a")));
    camera.set({ x: 1, y: 0, zoom: 1 });
    painter.invalidate();
    expect(frames.length).toBe(1);
    run();
    expect(paints.length).toBe(1);
    expect(frames.length).toBe(0);
  });

  it("只改 world 层实体不触发 Canvas 重绘，删除或 Canvas 层实体才触发", () => {
    const { scene, run, frames } = setup();
    scene.transact((d) => d.set(make("n", { kind: "card" })));
    run();
    scene.transact((d) => d.update("n", { x: 5 }));
    expect(frames.length).toBe(0);
    scene.transact((d) => d.remove("n"));
    expect(frames.length).toBe(1);
  });

  it("预览中的实体按预览几何画，选中状态传给 paint", () => {
    const { scene, painter, paints } = setup();
    painter.configure({ selected: (id) => id === "a" });
    scene.transact((d) => d.set(make("a")));
    scene.preview(new Map([["a", { x: 40, y: 8 }]]));
    painter.flush();
    expect(paints).toEqual(["a@40,8*"]);
  });

  it("父子分组：子对象用绝对世界坐标画", () => {
    const { scene, painter, paints } = setup();
    scene.transact((d) => {
      d.set(make("g", { kind: "card", x: 50, y: 10, w: 100, h: 60 }));
      d.set(make("c", { parent: "g", x: 5, y: 5 }));
    });
    painter.flush();
    expect(paints).toEqual(["c@55,15"]);
  });

  it("点阵画在下带，缩小时间距翻倍；关闭点阵不画", () => {
    expect(dotGap(1, 200, 100)).toBe(20);
    expect(dotGap(0.25, 200, 100)).toBe(40);
    expect(dotGap(0.1, 200, 100)).toBe(160);
    expect(dotGap(0, 200, 100)).toBe(20);
    const { layers, painter, ctxs } = setup();
    painter.configure({ dots: true, color: (n) => (n === "dot" ? "#999" : n) });
    painter.flush();
    const calls = ctxs.get(layers.under)!.calls;
    expect(calls).toContain("fillStyle=#999");
    expect(calls).toContain("fill()");
    expect(
      ctxs.get(layers.over)!.calls.some((c) => c.startsWith("rect(")),
    ).toBe(false);
  });

  it("没传 color 时点阵按主题取缺省灰，不是黑色", () => {
    const { layers, painter, ctxs } = setup();
    painter.configure({ dots: true });
    painter.flush();
    expect(ctxs.get(layers.under)!.calls).toContain(
      "fillStyle=rgba(0,0,0,0.18)",
    );
    painter.configure({ theme: "dark" });
    painter.flush();
    expect(ctxs.get(layers.under)!.calls).toContain(
      "fillStyle=rgba(255,255,255,0.18)",
    );
  });

  it("destroy 取消排队的帧并退订", () => {
    const { scene, painter, run, paints } = setup();
    scene.transact((d) => d.set(make("a")));
    painter.destroy();
    run();
    expect(paints).toEqual([]);
    scene.transact((d) => d.set(make("b")));
    run();
    expect(paints).toEqual([]);
  });
});
