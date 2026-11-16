// 向量与矩形的纯数学（docs/design/board-engine.md §2.5）。没有状态、没有 DOM。
import type { Rect, Vec } from "../types";

export const vecAdd = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const vecSub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const vecScale = (a: Vec, k: number): Vec => ({
  x: a.x * k,
  y: a.y * k,
});
export const vecDist = (a: Vec, b: Vec): number =>
  Math.hypot(a.x - b.x, a.y - b.y);
export const vecLerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export const rectRight = (r: Rect): number => r.x + r.w;
export const rectBottom = (r: Rect): number => r.y + r.h;
export const rectCenter = (r: Rect): Vec => ({
  x: r.x + r.w / 2,
  y: r.y + r.h / 2,
});

/** 点在矩形内（含边界）。 */
export function rectContainsPoint(r: Rect, p: Vec): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** `outer` 完全包含 `inner`（含贴边）。 */
export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** 两矩形有重叠面积或贴边（含边界）。 */
export function rectIntersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
  );
}

/** 交集；不相交返回 null。 */
export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  if (r < x || bt < y) return null;
  return { x, y, w: r - x, h: bt - y };
}

export function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** 一组矩形的包围盒；空数组返回 null。 */
export function rectsBounds(rects: Iterable<Rect>): Rect | null {
  let out: Rect | null = null;
  for (const r of rects) out = out ? rectUnion(out, r) : { ...r };
  return out;
}

/** 四周各扩 `by`（负数为收缩，宽高不会小于 0）。 */
export function rectInflate(r: Rect, by: number): Rect {
  const w = Math.max(0, r.w + by * 2);
  const h = Math.max(0, r.h + by * 2);
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** 由两个对角点（任意顺序）得到规范矩形。 */
export function rectFromPoints(a: Vec, b: Vec): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** 点到线段的距离。 */
export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return vecDist(p, a);
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2),
  );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 点到折线的最短距离；少于两个点时退化为点距离，空数组为 Infinity。 */
export function distToPolyline(p: Vec, points: readonly Vec[]): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) return vecDist(p, points[0]!);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i += 1) {
    best = Math.min(best, distToSegment(p, points[i - 1]!, points[i]!));
  }
  return best;
}

/** 三次贝塞尔在参数 t 处的点。 */
export function cubicAt(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** 把三次贝塞尔均匀采样成折线（含两端，`steps` 段），用于命中与包围盒。 */
export function flattenCubic(
  p0: Vec,
  p1: Vec,
  p2: Vec,
  p3: Vec,
  steps = 16,
): Vec[] {
  const n = Math.max(1, Math.floor(steps));
  const out: Vec[] = [];
  for (let i = 0; i <= n; i += 1) out.push(cubicAt(p0, p1, p2, p3, i / n));
  return out;
}

/** 点到三次贝塞尔的近似距离（先采样成折线）。 */
export function distToCubic(
  p: Vec,
  p0: Vec,
  p1: Vec,
  p2: Vec,
  p3: Vec,
  steps = 16,
): number {
  return distToPolyline(p, flattenCubic(p0, p1, p2, p3, steps));
}

/** 点列的包围盒；空返回 null。 */
export function pointsBounds(points: readonly Vec[]): Rect | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
