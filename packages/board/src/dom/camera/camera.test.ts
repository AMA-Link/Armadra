import { describe, expect, it, vi } from "vitest";

import { createCamera } from "./camera";
import type { Clock } from "./clock";

function fakeClock() {
  let t = 0;
  let next: (() => void) | null = null;
  const clock: Clock = {
    now: () => t,
    request: (cb) => {
      next = cb;
      return 1;
    },
    cancel: () => {
      next = null;
    },
  };
  return {
    clock,
    advance(ms: number) {
      t += ms;
      const cb = next;
      next = null;
      cb?.();
    },
    pending: () => next !== null,
  };
}

describe("相机", () => {
  it("坐标互转与可见区域", () => {
    const camera = createCamera({ x: 100, y: 50, zoom: 2 });
    camera.setViewport({ width: 400, height: 200 });
    expect(camera.screenToWorld({ x: 100, y: 50 })).toEqual({ x: 0, y: 0 });
    expect(camera.worldToScreen({ x: 10, y: 10 })).toEqual({ x: 120, y: 70 });
    expect(camera.visible()).toEqual({ x: -50, y: -25, w: 200, h: 100 });
  });

  it("set 夹缩放范围并通知订阅；相同状态不通知", () => {
    const camera = createCamera();
    const seen = vi.fn();
    const off = camera.subscribe(seen);
    camera.set({ x: 0, y: 0, zoom: 99 });
    expect(camera.get().zoom).toBe(camera.limits.max);
    camera.set({ x: 0, y: 0, zoom: 99 });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    camera.panBy(5, 5);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("zoomAround 保持指针下的世界点不动", () => {
    const camera = createCamera({ x: 30, y: 20, zoom: 1 });
    const before = camera.screenToWorld({ x: 200, y: 100 });
    camera.zoomAround({ x: 200, y: 100 }, 2);
    expect(camera.screenToWorld({ x: 200, y: 100 })).toEqual(before);
  });

  it("fit 与 center 用视口尺寸", () => {
    const camera = createCamera();
    camera.setViewport({ width: 1000, height: 500 });
    camera.center({ x: 100, y: 100 }, { zoom: 1 });
    expect(camera.get()).toEqual({ x: 400, y: 150, zoom: 1 });
    camera.fit({ x: 0, y: 0, w: 100, h: 100 }, { padding: 0, maxZoom: 2 });
    expect(camera.get().zoom).toBe(2);
  });

  it("duration 逐帧插值，最后落到目标，新的 set 打断动画", () => {
    const f = fakeClock();
    const camera = createCamera(undefined, undefined, f.clock);
    camera.set({ x: 100, y: 0, zoom: 1 }, { duration: 100 });
    expect(camera.get().x).toBe(0);
    f.advance(50);
    expect(camera.get().x).toBeGreaterThan(50);
    expect(camera.get().x).toBeLessThan(100);
    f.advance(60);
    expect(camera.get().x).toBe(100);
    expect(f.pending()).toBe(false);

    camera.set({ x: 0, y: 0, zoom: 1 }, { duration: 100 });
    f.advance(10);
    camera.set({ x: 7, y: 7, zoom: 1 });
    expect(f.pending()).toBe(false);
    expect(camera.get().x).toBe(7);
  });

  it("locked 只是标记，程序调用照常生效", () => {
    const camera = createCamera();
    camera.locked = true;
    camera.panBy(10, 0);
    expect(camera.get().x).toBe(10);
  });
});
