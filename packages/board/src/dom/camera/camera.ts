// 有状态相机：core 的相机纯函数之上加订阅、锁定与 rAF 过渡。
import {
  DEFAULT_CAMERA,
  DEFAULT_LIMITS,
  cameraEquals,
  centerOn,
  clampZoom,
  fitBounds,
  panBy,
  screenToWorld,
  visibleRect,
  worldToScreen,
  zoomAround,
  type CameraState,
  type ZoomLimits,
} from "../../core";
import type { Camera, CameraOptions } from "../types";
import { browserClock, type Clock } from "./clock";

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export function createCamera(
  initial: CameraState = DEFAULT_CAMERA,
  limits: ZoomLimits = DEFAULT_LIMITS,
  clock: Clock = browserClock,
): Camera {
  let state: CameraState = {
    ...initial,
    zoom: clampZoom(initial.zoom, limits),
  };
  let size = { width: 0, height: 0 };
  let frame: { handle: unknown } | null = null;
  const listeners = new Set<(state: CameraState) => void>();

  const write = (next: CameraState) => {
    if (cameraEquals(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener(state);
  };
  const stop = () => {
    if (frame) clock.cancel(frame.handle);
    frame = null;
  };

  function go(target: CameraState, options?: CameraOptions) {
    stop();
    const next = { ...target, zoom: clampZoom(target.zoom, camera.limits) };
    const duration = options?.duration ?? 0;
    if (duration <= 0 || cameraEquals(state, next)) return write(next);
    const from = state;
    const t0 = clock.now();
    const step = () => {
      const t = Math.min(1, (clock.now() - t0) / duration);
      const e = easeOutCubic(t);
      write({
        x: from.x + (next.x - from.x) * e,
        y: from.y + (next.y - from.y) * e,
        zoom: from.zoom + (next.zoom - from.zoom) * e,
      });
      frame = t < 1 ? { handle: clock.request(step) } : null;
    };
    frame = { handle: clock.request(step) };
  }

  const camera: Camera = {
    locked: false,
    limits: { ...limits },
    get: () => state,
    set: (next, options) => go(next, options),
    setViewport(next) {
      size = { ...next };
    },
    screenToWorld: (point) => screenToWorld(state, point),
    worldToScreen: (point) => worldToScreen(state, point),
    visible: () => visibleRect(state, size),
    panBy: (dx, dy) => go(panBy(state, dx, dy)),
    zoomAround: (screen, zoom, options) =>
      go(zoomAround(state, zoom, screen, camera.limits), options),
    fit: (bounds, options) =>
      go(
        fitBounds(bounds, size, { ...options, limits: camera.limits }),
        options,
      ),
    center: (world, options) =>
      go(
        centerOn(world, size, options?.zoom ?? state.zoom, camera.limits),
        options,
      ),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return camera;
}
