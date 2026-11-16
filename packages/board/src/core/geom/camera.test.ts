import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA,
  DEFAULT_LIMITS,
  MAX_WHEEL_DELTA,
  MAX_ZOOM,
  MIN_ZOOM,
  cameraEquals,
  centerOn,
  clampZoom,
  fitBounds,
  panBy,
  screenToWorld,
  visibleRect,
  wheelZoomFactor,
  worldToScreen,
  zoomAround,
  zoomAroundCentre,
} from "./camera";

const size = { width: 800, height: 600 };

describe("camera", () => {
  it("坐标往返", () => {
    const cam = { x: 30, y: -20, zoom: 2 };
    const w = screenToWorld(cam, { x: 130, y: 80 });
    expect(w).toEqual({ x: 50, y: 50 });
    expect(worldToScreen(cam, w)).toEqual({ x: 130, y: 80 });
    expect(screenToWorld({ x: 0, y: 0, zoom: 0 }, { x: 4, y: 4 })).toEqual({
      x: 4,
      y: 4,
    });
  });
  it("clampZoom", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(5, { min: 1, max: 8 })).toBe(5);
    expect(DEFAULT_LIMITS).toEqual({ min: 0.1, max: 3 });
  });
  it("可见矩形与平移", () => {
    expect(visibleRect({ x: -100, y: -50, zoom: 2 }, size)).toEqual({
      x: 50,
      y: 25,
      w: 400,
      h: 300,
    });
    expect(visibleRect({ x: 0, y: 0, zoom: 0 }, size).w).toBe(800);
    expect(panBy(DEFAULT_CAMERA, 5, -5)).toEqual({ x: 5, y: -5, zoom: 1 });
  });
  it("以点缩放保持不动点", () => {
    const cam = { x: 10, y: 20, zoom: 1 };
    const p = { x: 300, y: 200 };
    const next = zoomAround(cam, 2, p);
    expect(screenToWorld(next, p)).toEqual(screenToWorld(cam, p));
    expect(next.zoom).toBe(2);
  });
  it("到边界不飘", () => {
    const at = zoomAround(DEFAULT_CAMERA, 3, { x: 100, y: 100 });
    expect(zoomAround(at, 99, { x: 100, y: 100 })).toEqual(at);
  });
  it("以中心缩放", () => {
    const next = zoomAroundCentre(DEFAULT_CAMERA, 2, size);
    expect(next).toEqual({ x: -400, y: -300, zoom: 2 });
  });
  it("滚轮倍率", () => {
    expect(wheelZoomFactor(NaN)).toBe(1);
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(1000)).toBeCloseTo(
      Math.exp(-MAX_WHEEL_DELTA * 0.01),
    );
    expect(wheelZoomFactor(-3) * wheelZoomFactor(3)).toBeCloseTo(1);
  });
  it("centerOn", () => {
    expect(centerOn({ x: 100, y: 100 }, size, 1)).toEqual({
      x: 300,
      y: 200,
      zoom: 1,
    });
    expect(centerOn({ x: 0, y: 0 }, size, 99).zoom).toBe(MAX_ZOOM);
  });
  it("fitBounds", () => {
    const cam = fitBounds({ x: 0, y: 0, w: 1600, h: 600 }, size);
    expect(cam.zoom).toBeCloseTo(800 / (1600 * 1.1));
    const c = screenToWorld(cam, { x: 400, y: 300 });
    expect(c.x).toBeCloseTo(800);
    expect(c.y).toBeCloseTo(300);
    // 小内容不放大超过 maxZoom
    expect(
      fitBounds({ x: 0, y: 0, w: 10, h: 10 }, size, { maxZoom: 1 }).zoom,
    ).toBe(1);
    // 零面积只居中
    expect(
      fitBounds({ x: 10, y: 10, w: 0, h: 0 }, size, { maxZoom: 2 }),
    ).toEqual(centerOn({ x: 10, y: 10 }, size, 2));
    // 巨大内容夹到下限
    expect(fitBounds({ x: 0, y: 0, w: 1e6, h: 1e6 }, size).zoom).toBe(MIN_ZOOM);
    expect(
      fitBounds({ x: 0, y: 0, w: 100, h: 100 }, size, { padding: 0 }).zoom,
    ).toBe(3);
  });
  it("cameraEquals", () => {
    expect(cameraEquals({ x: 1, y: 2, zoom: 3 }, { x: 1, y: 2, zoom: 3 })).toBe(
      true,
    );
    expect(cameraEquals({ x: 1, y: 2, zoom: 3 }, { x: 1, y: 2, zoom: 2 })).toBe(
      false,
    );
  });
});
