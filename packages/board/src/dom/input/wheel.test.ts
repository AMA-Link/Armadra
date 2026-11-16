// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { createCamera } from "../camera";
import { attachSafariGestures, createWheelHandler } from "./wheel";

const setup = (device: "mouse" | "trackpad" = "trackpad") => {
  const container = document.createElement("div");
  document.body.append(container);
  const camera = createCamera();
  camera.setViewport({ width: 800, height: 600 });
  const handler = createWheelHandler(container, camera, () => device);
  const wheel = (init: WheelEventInit, target: Element = container) => {
    const e = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(e);
    handler(e);
    return e;
  };
  return { container, camera, wheel };
};

describe("滚轮", () => {
  it("触控板：普通滚轮平移，Shift 把纵向滚动当横向", () => {
    const { camera, wheel } = setup();
    const e = wheel({ deltaX: 10, deltaY: 20 });
    expect(camera.get()).toMatchObject({ x: -10, y: -20 });
    expect(e.defaultPrevented).toBe(true);
    wheel({ deltaY: 30, shiftKey: true });
    expect(camera.get()).toMatchObject({ x: -40, y: -20 });
  });

  it("ctrl / meta（含捏合）以指针为不动点缩放", () => {
    const { camera, wheel } = setup();
    const at = { x: 200, y: 100 };
    const before = camera.screenToWorld(at);
    wheel({ deltaY: -20, ctrlKey: true, clientX: at.x, clientY: at.y });
    expect(camera.get().zoom).toBeGreaterThan(1);
    expect(camera.worldToScreen(before).x).toBeCloseTo(200);
    const zoom = camera.get().zoom;
    wheel({ deltaY: 20, metaKey: true, clientX: at.x, clientY: at.y });
    expect(camera.get().zoom).toBeLessThan(zoom);
  });

  it("鼠标偏好：普通滚轮缩放，单个事件增量夹在上限内", () => {
    const { camera, wheel } = setup("mouse");
    wheel({ deltaY: -100 });
    expect(camera.get().zoom).toBeCloseTo(Math.exp(0.4));
  });

  it("可编辑 / 自滚区里的普通滚轮放手，ctrl 滚轮仍缩放", () => {
    const { container, camera, wheel } = setup();
    const input = document.createElement("textarea");
    input.dataset.boardEditable = "";
    container.append(input);
    const e = wheel({ deltaY: 50 }, input);
    expect(e.defaultPrevented).toBe(false);
    expect(camera.get()).toMatchObject({ x: 0, y: 0 });
    wheel({ deltaY: -20, ctrlKey: true }, input);
    expect(camera.get().zoom).toBeGreaterThan(1);
  });

  it("锁定的相机不动，但仍拦下页面滚动", () => {
    const { camera, wheel } = setup();
    camera.locked = true;
    const e = wheel({ deltaY: 50 });
    expect(camera.get()).toMatchObject({ x: 0, y: 0, zoom: 1 });
    expect(e.defaultPrevented).toBe(true);
  });

  it("Safari gesture*：缩放相对手势开始时", () => {
    const { container, camera } = setup();
    const off = attachSafariGestures(container, camera);
    const fire = (type: string, scale: number) => {
      const e = Object.assign(new Event(type, { cancelable: true }), {
        scale,
        clientX: 0,
        clientY: 0,
      });
      container.dispatchEvent(e);
      return e;
    };
    fire("gesturestart", 1);
    expect(fire("gesturechange", 1.5).defaultPrevented).toBe(true);
    expect(camera.get().zoom).toBeCloseTo(1.5);
    fire("gesturechange", 2);
    expect(camera.get().zoom).toBeCloseTo(2);
    off();
    fire("gesturechange", 3);
    expect(camera.get().zoom).toBeCloseTo(2);
  });
});
