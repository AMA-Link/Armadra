// 空间索引：均匀网格 + 大对象旁路表（设计 §2.5）。接口抽象，数据量变了可换实现。
import type { Rect, Vec } from "../types";
import { rectContainsPoint, rectIntersects } from "./math";

export interface SpatialIndex<K = string> {
  insert(id: K, rect: Rect): void;
  /** 更新位置；不存在时等同 insert。 */
  update(id: K, rect: Rect): void;
  remove(id: K): void;
  has(id: K): boolean;
  get(id: K): Rect | undefined;
  /** 与矩形相交（含贴边）的所有 id，无序。 */
  queryRect(rect: Rect): K[];
  /** 包围盒含该点的所有 id，无序。 */
  queryPoint(point: Vec): K[];
  clear(): void;
  readonly size: number;
}

/** 格边长（世界单位，约一个默认节点宽）。 */
export const GRID_CELL = 512;
/** 覆盖格数超过 `MAX_SPAN * MAX_SPAN` 的对象进旁路表。 */
export const GRID_MAX_SPAN = 8;

export function createGridIndex<K = string>(
  cell: number = GRID_CELL,
  maxSpan: number = GRID_MAX_SPAN,
): SpatialIndex<K> {
  const rects = new Map<K, Rect>();
  const cells = new Map<string, Set<K>>();
  const large = new Set<K>();

  const span = (r: Rect) => ({
    x0: Math.floor(r.x / cell),
    x1: Math.floor((r.x + r.w) / cell),
    y0: Math.floor(r.y / cell),
    y1: Math.floor((r.y + r.h) / cell),
  });
  const isLarge = (s: ReturnType<typeof span>) =>
    s.x1 - s.x0 + 1 > maxSpan || s.y1 - s.y0 + 1 > maxSpan;

  const detach = (id: K, r: Rect) => {
    if (large.delete(id)) return;
    const s = span(r);
    for (let x = s.x0; x <= s.x1; x += 1) {
      for (let y = s.y0; y <= s.y1; y += 1) {
        const key = `${x},${y}`;
        const bucket = cells.get(key);
        if (!bucket) continue;
        bucket.delete(id);
        if (bucket.size === 0) cells.delete(key);
      }
    }
  };

  const attach = (id: K, r: Rect) => {
    const s = span(r);
    if (isLarge(s)) {
      large.add(id);
      return;
    }
    for (let x = s.x0; x <= s.x1; x += 1) {
      for (let y = s.y0; y <= s.y1; y += 1) {
        const key = `${x},${y}`;
        let bucket = cells.get(key);
        if (!bucket) cells.set(key, (bucket = new Set()));
        bucket.add(id);
      }
    }
  };

  const remove = (id: K) => {
    const old = rects.get(id);
    if (!old) return;
    detach(id, old);
    rects.delete(id);
  };

  const insert = (id: K, rect: Rect) => {
    remove(id);
    const r = { ...rect };
    rects.set(id, r);
    attach(id, r);
  };

  const collect = (rect: Rect, test: (r: Rect) => boolean): K[] => {
    const found = new Set<K>();
    const s = span(rect);
    const cellCount = (s.x1 - s.x0 + 1) * (s.y1 - s.y0 + 1);
    if (cellCount > cells.size) {
      // 查询范围比已占用的格还多：直接遍历占用格更省。
      for (const [key, bucket] of cells) {
        const [cx, cy] = key.split(",").map(Number) as [number, number];
        if (cx < s.x0 || cx > s.x1 || cy < s.y0 || cy > s.y1) continue;
        for (const id of bucket) if (test(rects.get(id)!)) found.add(id);
      }
    } else {
      for (let x = s.x0; x <= s.x1; x += 1) {
        for (let y = s.y0; y <= s.y1; y += 1) {
          const bucket = cells.get(`${x},${y}`);
          if (!bucket) continue;
          for (const id of bucket) if (test(rects.get(id)!)) found.add(id);
        }
      }
    }
    for (const id of large) if (test(rects.get(id)!)) found.add(id);
    return [...found];
  };

  return {
    insert,
    update: insert,
    remove,
    has: (id) => rects.has(id),
    get: (id) => rects.get(id),
    queryRect: (rect) => collect(rect, (r) => rectIntersects(r, rect)),
    queryPoint: (p) =>
      collect({ x: p.x, y: p.y, w: 0, h: 0 }, (r) => rectContainsPoint(r, p)),
    clear: () => {
      rects.clear();
      cells.clear();
      large.clear();
    },
    get size() {
      return rects.size;
    },
  };
}
