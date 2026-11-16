// 相机：纯函数。状态 {x,y,zoom} 与 shared 的 Viewport 同义：
// 屏幕 = 世界 * zoom + (x,y)。行为与 apps/web/src/canvas/zoom.ts、viewport.ts 一致。
import type { Rect, Vec } from "../types";

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
export const DEFAULT_LIMITS: ZoomLimits = { min: MIN_ZOOM, max: MAX_ZOOM };
/** ⌘= / ⌘- 每次的倍率。 */
export const ZOOM_STEP = 1.2;
/** 适应视图四周留的比例边距。 */
export const FIT_PADDING = 0.05;
/** 单个滚轮事件计入缩放的最大增量（鼠标一格 ±100 与触控板 ±2~8 不至于差一个数量级）。 */
export const MAX_WHEEL_DELTA = 40;

export const DEFAULT_CAMERA: CameraState = { x: 0, y: 0, zoom: 1 };

export function clampZoom(
  zoom: number,
  limits: ZoomLimits = DEFAULT_LIMITS,
): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(limits.max, Math.max(limits.min, zoom));
}

export function screenToWorld(camera: CameraState, p: Vec): Vec {
  const z = camera.zoom || 1;
  return { x: (p.x - camera.x) / z, y: (p.y - camera.y) / z };
}

export function worldToScreen(camera: CameraState, p: Vec): Vec {
  return { x: p.x * camera.zoom + camera.x, y: p.y * camera.zoom + camera.y };
}

/** 屏幕尺寸下当前可见的世界矩形。 */
export function visibleRect(
  camera: CameraState,
  size: { width: number; height: number },
): Rect {
  const z = camera.zoom || 1;
  return {
    x: -camera.x / z,
    y: -camera.y / z,
    w: size.width / z,
    h: size.height / z,
  };
}

/** 平移（屏幕像素增量）。 */
export function panBy(
  camera: CameraState,
  dx: number,
  dy: number,
): CameraState {
  return { x: camera.x + dx, y: camera.y + dy, zoom: camera.zoom };
}

/** 以屏幕点为不动点缩放到 `zoom`（先夹范围再算，到边界不飘）。 */
export function zoomAround(
  camera: CameraState,
  zoom: number,
  point: Vec,
  limits: ZoomLimits = DEFAULT_LIMITS,
): CameraState {
  const next = clampZoom(zoom, limits);
  const world = screenToWorld(camera, point);
  return {
    x: point.x - world.x * next,
    y: point.y - world.y * next,
    zoom: next,
  };
}

/** 以容器中心为不动点缩放。 */
export function zoomAroundCentre(
  camera: CameraState,
  zoom: number,
  size: { width: number; height: number },
  limits: ZoomLimits = DEFAULT_LIMITS,
): CameraState {
  return zoomAround(
    camera,
    zoom,
    { x: size.width / 2, y: size.height / 2 },
    limits,
  );
}

/** 滚轮增量 → 缩放倍率（指数，上滚再下滚能回到原值）。 */
export function wheelZoomFactor(deltaY: number, sensitivity = 0.01): number {
  if (!Number.isFinite(deltaY)) return 1;
  const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, deltaY));
  return Math.exp(-delta * sensitivity);
}

/** 把世界点摆到容器中心，缩放可选。 */
export function centerOn(
  world: Vec,
  size: { width: number; height: number },
  zoom: number,
  limits: ZoomLimits = DEFAULT_LIMITS,
): CameraState {
  const z = clampZoom(zoom, limits);
  return {
    x: size.width / 2 - world.x * z,
    y: size.height / 2 - world.y * z,
    zoom: z,
  };
}

/**
 * 把世界矩形（含 `padding` 比例边距）放进容器，居中。
 * 缩放夹在 limits 与 `maxZoom` 内；盒子无面积时只居中、保持 `maxZoom`（缺省 1）。
 */
export function fitBounds(
  bounds: Rect,
  size: { width: number; height: number },
  options: { padding?: number; maxZoom?: number; limits?: ZoomLimits } = {},
): CameraState {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const pad = 1 + (options.padding ?? FIT_PADDING) * 2;
  const cap = Math.min(options.maxZoom ?? limits.max, limits.max);
  const target =
    bounds.w > 0 && bounds.h > 0
      ? Math.min(size.width / (bounds.w * pad), size.height / (bounds.h * pad))
      : cap;
  const zoom = clampZoom(Math.min(target, cap), limits);
  return centerOn(
    { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
    size,
    zoom,
    limits,
  );
}

/** 相机是否相等（订阅去抖用）。 */
export function cameraEquals(a: CameraState, b: CameraState): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}
