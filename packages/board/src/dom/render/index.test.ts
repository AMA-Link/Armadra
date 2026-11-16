// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { createMemoryScene, type CameraState, type Entity } from "../../core";
import type { Camera } from "../types";
import type { RenderEnv } from "./env";
import { createRenderer } from "./index";

describe("createRenderer", () => {
  it("接线：视口写入相机，相机变化写世界层 transform，实体有宿主，销毁后清空", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      null as never,
    );
    let notifyResize = () => {};
    const env: RenderEnv = {
      raf: () => 1,
      caf: () => {},
      observe: (_el, cb) => ((notifyResize = cb), () => {}),
      dpr: () => 1,
    };
    const container = document.createElement("div");
    let width = 300;
    Object.defineProperty(container, "clientWidth", { get: () => width });
    Object.defineProperty(container, "clientHeight", { value: 200 });
    let listener: (s: CameraState) => void = () => {};
    const setViewport = vi.fn();
    const camera = {
      get: () => ({ x: 5, y: 6, zoom: 1 }),
      visible: () => ({ x: 0, y: 0, w: 300, h: 200 }),
      setViewport,
      subscribe: (l: (s: CameraState) => void) => ((listener = l), () => {}),
    } as unknown as Camera;
    const scene = createMemoryScene();
    const card: Entity = {
      id: "a",
      kind: "card",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      z: 0,
      data: null,
    };
    scene.transact((d) => d.set(card));

    const renderer = createRenderer(container, {
      scene,
      camera,
      kind: () => undefined,
      env,
    });
    expect(setViewport).toHaveBeenLastCalledWith({
      width: 300,
      height: 200,
      dpr: 1,
    });
    expect(renderer.layers.world.style.transform).toBe(
      "translate(5px, 6px) scale(1)",
    );
    expect(renderer.hosts.hostOf("a")).toBeDefined();

    width = 400;
    notifyResize();
    expect(setViewport).toHaveBeenLastCalledWith({
      width: 400,
      height: 200,
      dpr: 1,
    });
    listener({ x: 1, y: 2, zoom: 2 });
    expect(renderer.layers.world.style.transform).toBe(
      "translate(1px, 2px) scale(2)",
    );

    renderer.destroy();
    expect(container.children.length).toBe(0);
  });
});
