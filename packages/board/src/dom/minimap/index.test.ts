// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryScene,
  screenToWorld,
  visibleRect,
  type CameraState,
  type Entity,
} from "../../core";
import type { RenderEnv } from "../render/env";
import type { Camera } from "../types";
import { createMinimap, minimapView } from "./index";

const make = (id: string, patch: Partial<Entity> = {}): Entity => ({
  id,
  kind: "card",
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  z: 0,
  data: null,
  ...patch,
});

function setup() {
  const calls: string[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    new Proxy({} as Record<string, unknown>, {
      get:
        (_t, key: string) =>
        (...args: unknown[]) =>
          calls.push(`${key}(${args.join(",")})`),
      set: (_t, key: string, value) => (
        calls.push(`${key}=${String(value)}`),
        true
      ),
    }) as never,
  );
  const frames: Array<() => void> = [];
  const env: RenderEnv = {
    raf: (cb) => frames.push(cb),
    caf: () => {},
    observe: () => () => {},
    dpr: () => 1,
  };
  const state: CameraState = { x: 0, y: 0, zoom: 1 };
  const centered: Array<{ x: number; y: number }> = [];
  const camera = {
    get: () => state,
    visible: () => visibleRect(state, { width: 200, height: 100 }),
    screenToWorld: (p: { x: number; y: number }) => screenToWorld(state, p),
    center: (p: { x: number; y: number }) => centered.push(p),
    subscribe: () => () => {},
  } as unknown as Camera;
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 100 });
  Object.defineProperty(el, "clientHeight", { value: 50 });
  el.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
  const scene = createMemoryScene();
  scene.transact((d) => {
    d.set(make("a", { x: 0, y: 0, w: 100, h: 50 }));
    d.set(make("b", { x: 300, y: 150, w: 100, h: 50 }));
    d.set(make("l", { ends: ["a", "b"] }));
  });
  const minimap = createMinimap(el, {
    scene,
    camera,
    env,
    colorOf: (e) =>
      e.id === "a"
        ? { fill: "red", stroke: "blue", strokeWidth: 2 }
        : e.ends
          ? { fill: "none", stroke: "gray" }
          : "green",
  });
  const press = (type: string, x: number, y: number) =>
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX: x,
        clientY: y,
      }),
    );
  return { el, minimap, calls, centered, press };
}

afterEach(() => vi.restoreAllMocks());

describe("minimapView", () => {
  it("把范围居中缩放进画布，留白", () => {
    const v = minimapView(
      { x: 0, y: 0, w: 400, h: 200 },
      { width: 112, height: 112 },
      6,
    );
    expect(v.scale).toBe(0.25);
    // 世界原点落在水平留白处，垂直居中。
    expect(v.origin.x * -v.scale).toBe(6);
    expect(v.origin.y * -v.scale).toBe(31);
  });
});

describe("createMinimap", () => {
  it("按注入的颜色画每个实体的包围盒，连线画中心连线，最后画可视框遮罩", () => {
    const { minimap, calls } = setup();
    minimap.flush();
    expect(calls).toContain("fillStyle=red");
    expect(calls).toContain("strokeStyle=blue");
    expect(calls).toContain("lineWidth=2");
    expect(calls).toContain("fillStyle=green");
    expect(calls).toContain("strokeStyle=gray");
    expect(calls.filter((c) => c.startsWith("lineTo(")).length).toBe(1);
    expect(calls.lastIndexOf("fill(evenodd)")).toBeGreaterThan(
      calls.indexOf("fillStyle=green"),
    );
  });

  it("点到实体居中到它，点到空白居中到点击处；拖可视框时不跳", () => {
    const { minimap, press, centered, el } = setup();
    minimap.flush();
    // 范围 = 世界 (0,0)-(400,200)，画布 100×50、留白 6 → scale 0.2125…
    const view = minimapView(
      { x: 0, y: 0, w: 400, h: 200 },
      { width: 100, height: 50 },
    );
    const px = (wx: number, wy: number) =>
      [
        (wx - view.origin.x) * view.scale,
        (wy - view.origin.y) * view.scale,
      ] as const;
    // 点实体 b 的中心 (350, 175)：可视框是 (0,0,200,100)，不在框内。
    press("pointerdown", ...px(350, 175));
    expect(centered.at(-1)).toEqual({ x: 350, y: 175 });
    press("pointerup", 0, 0);
    // 拖可视框：在框内 (50,30)，偏离中心 (100,50) 的 (-50,-20)；移到 (60,40) 后中心 = 指针 - 偏移。
    press("pointerdown", ...px(50, 30));
    expect(centered.length).toBe(1);
    press("pointermove", ...px(60, 40));
    expect(centered.at(-1)!.x).toBeCloseTo(110, 5);
    expect(centered.at(-1)!.y).toBeCloseTo(60, 5);
    press("pointerup", 0, 0);
    press("pointermove", 5, 5);
    expect(centered.length).toBe(2);
    expect(el.querySelector("canvas")).not.toBeNull();
  });

  it("destroy 摘掉画布并停止响应", () => {
    const { minimap, el, press, centered } = setup();
    minimap.destroy();
    press("pointerdown", 50, 25);
    expect(centered.length).toBe(0);
    expect(el.querySelector("canvas")).toBeNull();
  });
});
