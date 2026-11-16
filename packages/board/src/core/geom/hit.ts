// 命中测试与框选：基于空间索引，精确命中交给调用方回调（KindSpec.hit）。
import type { EntityId, Rect, Vec } from "../types";
import { rectContains, rectIntersects } from "./math";
import type { SpatialIndex } from "./spatial";

/** 命中所需的最小视图：z 决定谁在上面，同 z 时顺序不保证。 */
export interface HitSource {
  index: SpatialIndex<EntityId>;
  /** 绘制顺序，大者在上；缺省 0。 */
  order(id: EntityId): number;
  /** 精确命中（point 为世界坐标，tolerance 为世界单位）；缺省按包围盒。 */
  precise?(id: EntityId, point: Vec, tolerance: number): boolean;
  /** 能否被命中/框选（锁定、隐藏等）；缺省全部可以。 */
  filter?(id: EntityId): boolean;
}

const byTopmost = (source: HitSource) => (a: EntityId, b: EntityId) =>
  source.order(b) - source.order(a);

/** 点下去命中的全部实体，最上层在前。`tolerance` 同时外扩包围盒查询范围。 */
export function hitAll(
  source: HitSource,
  point: Vec,
  tolerance = 0,
): EntityId[] {
  const probe: Rect = {
    x: point.x - tolerance,
    y: point.y - tolerance,
    w: tolerance * 2,
    h: tolerance * 2,
  };
  return source.index
    .queryRect(probe)
    .filter((id) => {
      if (source.filter && !source.filter(id)) return false;
      return source.precise ? source.precise(id, point, tolerance) : true;
    })
    .sort(byTopmost(source));
}

/** 最上面的命中实体；没有返回 undefined。 */
export function hitTop(
  source: HitSource,
  point: Vec,
  tolerance = 0,
): EntityId | undefined {
  return hitAll(source, point, tolerance)[0];
}

export type MarqueeMode = "contain" | "intersect";

/**
 * 框选：`contain` 要求完全包含，`intersect` 只要相交；结果按 z 从下到上排列。
 * 精确回调不参与框选（框选只看包围盒）。
 */
export function marquee(
  source: HitSource,
  rect: Rect,
  mode: MarqueeMode = "intersect",
): EntityId[] {
  const test = mode === "contain" ? rectContains : rectIntersects;
  return source.index
    .queryRect(rect)
    .filter((id) => {
      if (source.filter && !source.filter(id)) return false;
      const box = source.index.get(id)!;
      return mode === "contain" ? test(rect, box) : test(box, rect);
    })
    .sort((a, b) => source.order(a) - source.order(b));
}
