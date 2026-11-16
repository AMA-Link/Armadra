// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import type { RenderEnv } from "./env";
import { createLayers } from "./layers";

function sized(width: number, height: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: height,
    configurable: true,
  });
  document.body.append(el);
  return el;
}

function fakeEnv(dpr = 2) {
  let notify = () => {};
  const state = { dpr };
  const env: RenderEnv = {
    raf: () => 0,
    caf: () => {},
    observe(_el, cb) {
      notify = cb;
      return () => {
        notify = () => {};
      };
    },
    dpr: () => state.dpr,
  };
  return { env, state, fire: () => notify() };
}

describe("createLayers", () => {
  it("按 Canvas 下带、世界层、Canvas 上带、叠加层的顺序建四层", () => {
    const container = sized(300, 200);
    const layers = createLayers(container, fakeEnv().env);
    const order = [...container.children].map(
      (el) => (el as HTMLElement).dataset.boardLayer,
    );
    expect(order).toEqual(["canvas-under", "world", "canvas-over", "overlay"]);
    expect(layers.over.style.pointerEvents).toBe("none");
    expect(layers.overlay.style.pointerEvents).toBe("none");
    expect(layers.overlay.contains(layers.worldSvg)).toBe(true);
    expect(layers.overlay.contains(layers.screenSlot)).toBe(true);
    expect(container.style.position).toBe("relative");
  });

  it("Canvas 像素尺寸 = 容器尺寸 × DPR，尺寸或 DPR 变化时通知", () => {
    const container = sized(300, 200);
    const { env, state, fire } = fakeEnv(2);
    const layers = createLayers(container, env);
    expect(layers.under.width).toBe(600);
    expect(layers.over.height).toBe(400);
    const listener = vi.fn();
    layers.onResize(listener);
    fire();
    expect(listener).not.toHaveBeenCalled();
    state.dpr = 3;
    fire();
    expect(layers.under.width).toBe(900);
    expect(listener).toHaveBeenCalledWith({ width: 300, height: 200, dpr: 3 });
  });

  it("世界层与世界 SVG 用同一个 transform 跟相机", () => {
    const layers = createLayers(sized(10, 10), fakeEnv().env);
    layers.setCamera({ x: 40, y: -20, zoom: 0.5 });
    expect(layers.world.style.transform).toBe(
      "translate(40px, -20px) scale(0.5)",
    );
    expect(layers.worldSvg.style.transform).toBe(layers.world.style.transform);
  });

  it("destroy 摘掉四层并停止监听", () => {
    const container = sized(10, 10);
    const { env, fire } = fakeEnv();
    const layers = createLayers(container, env);
    const listener = vi.fn();
    layers.onResize(listener);
    layers.destroy();
    fire();
    expect(container.children.length).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});
