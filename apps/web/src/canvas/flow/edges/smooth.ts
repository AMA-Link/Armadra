import type { Position } from "@armadra/shared";

import type { Box } from "../../geometry";

/**
 * 正交折线的平滑（纯函数，#397）。
 *
 * 每个拐角用一段二次曲线代替：曲线从拐点前 `cutIn` 处出发、到拐点后
 * `cutOut` 处结束，控制点就是拐点本身，所以两头都与线段相切、没有尖角。
 *
 * 与固定半径的圆角相比有两处不同：
 *
 *  - 半径大得多（{@link SOFT_RADIUS}），空旷处的拐弯是一整道弧；
 *  - 两侧的切入距离可以**不等**：一侧线段很短（两排节点之间只有一道窄缝时
 *    那一小段竖线）时，短侧用尽它的长度，长侧最多拉到短侧的
 *    {@link STRETCH} 倍（不超过 {@link LONG_CUT}），弧是一道扁长的缓坡，
 *    而不是在窄缝里被挤成一个小圆角。曲线始终落在两段线之间的矩形里，
 *    所以不会比折线本身更靠近任何节点；
 *  - 弧要是会逼近旁边的障碍（拐角的内侧有节点）就按比例缩小，直到离障碍至少
 *    {@link CURVE_MARGIN}，缩到 {@link MIN_CUT} 为止。
 */

/** 拐角的基准半径（画布单位）：两侧线段都够长时，切入距离就是它。 */
export const SOFT_RADIUS = 36;
/** 一侧受限时，长侧最多拉到短侧的几倍。 */
export const STRETCH = 4;
/** 长侧切入距离的上限。 */
export const LONG_CUT = 56;
/** 曲线离障碍的最小距离。 */
export const CURVE_MARGIN = 8;
/** 切入距离的下限：相邻线段够长时，任何拐角至少这么圆。 */
export const MIN_CUT = 6;
/** 连着端点的那段线，拐角最多占它的这个比例（留一截直线给箭头）。 */
const END_SHARE = 0.75;

function length(a: Position, b: Position): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 某一段在某一端最多能让出多少给拐角：与另一个拐角平分，连着端点的段让出大头。 */
function available(points: readonly Position[], segment: number): number {
  const len = length(points[segment]!, points[segment + 1]!);
  const anchored = segment === 0 || segment === points.length - 2;
  // 另一头也是端点（只有一个拐角的两段折线的两段各有一端是端点）。
  return anchored && points.length > 2 ? len * END_SHARE : len / 2;
}

function pointAt(a: Position, b: Position, distance: number): Position {
  const len = length(a, b);
  return {
    x: a.x + ((b.x - a.x) / len) * distance,
    y: a.y + ((b.y - a.y) / len) * distance,
  };
}

/** 曲线上几个采样点是否进入某个障碍外扩 {@link CURVE_MARGIN} 的范围。 */
function crowds(
  from: Position,
  corner: Position,
  to: Position,
  obstacles: readonly Box[],
): boolean {
  for (const t of [0.25, 0.5, 0.75]) {
    const u = 1 - t;
    const x = u * u * from.x + 2 * u * t * corner.x + t * t * to.x;
    const y = u * u * from.y + 2 * u * t * corner.y + t * t * to.y;
    for (const box of obstacles) {
      if (
        x > box.x - CURVE_MARGIN &&
        x < box.x + box.width + CURVE_MARGIN &&
        y > box.y - CURVE_MARGIN &&
        y < box.y + box.height + CURVE_MARGIN
      ) {
        return true;
      }
    }
  }
  return false;
}

export interface Cut {
  /** 拐点之前、沿来向线段的切入距离。 */
  before: number;
  /** 拐点之后、沿去向线段的切入距离。 */
  after: number;
}

/**
 * 折线每个内部顶点的切入距离（端点没有）。
 *
 * `obstacles` 是要避让的矩形（调用方去掉两端自己：连着端点的那段线本来就贴着它）。
 */
export function cornerCuts(
  points: readonly Position[],
  obstacles: readonly Box[] = [],
  radius: number = SOFT_RADIUS,
): Cut[] {
  const cuts: Cut[] = [];
  for (let k = 1; k < points.length - 1; k += 1) {
    const prev = points[k - 1]!;
    const corner = points[k]!;
    const next = points[k + 1]!;
    const room = {
      before: available(points, k - 1),
      after: available(points, k),
    };
    const short = Math.min(room.before, room.after);
    let before: number;
    let after: number;
    if (short >= radius) {
      before = after = radius;
    } else {
      const long = Math.min(
        Math.max(room.before, room.after),
        LONG_CUT,
        short * STRETCH,
      );
      before = room.before <= room.after ? short : long;
      after = room.before <= room.after ? long : short;
    }
    if (before < 0.5 || after < 0.5) {
      cuts.push({ before: 0, after: 0 });
      continue;
    }
    // 拐角内侧有障碍时按比例缩小。
    for (let attempt = 0; attempt < 5 && obstacles.length > 0; attempt += 1) {
      if (
        !crowds(
          pointAt(corner, prev, before),
          corner,
          pointAt(corner, next, after),
          obstacles,
        )
      ) {
        break;
      }
      const scale = Math.max(MIN_CUT / Math.max(before, after), 0.7);
      before *= scale;
      after *= scale;
    }
    cuts.push({ before, after });
  }
  return cuts;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 折线加切入距离 → SVG 路径（拐角是二次曲线）。 */
export function smoothPath(
  points: readonly Position[],
  cuts: readonly Cut[],
): string {
  if (points.length === 0) return "";
  const head = points[0]!;
  let d = `M ${head.x},${head.y}`;
  for (let k = 1; k < points.length - 1; k += 1) {
    const prev = points[k - 1]!;
    const corner = points[k]!;
    const next = points[k + 1]!;
    const cut = cuts[k - 1] ?? { before: 0, after: 0 };
    if (cut.before === 0 || cut.after === 0) {
      d += ` L ${corner.x},${corner.y}`;
      continue;
    }
    const a = pointAt(corner, prev, cut.before);
    const b = pointAt(corner, next, cut.after);
    d += ` L ${round(a.x)},${round(a.y)} Q ${corner.x},${corner.y} ${round(b.x)},${round(b.y)}`;
  }
  const tail = points[points.length - 1]!;
  if (points.length > 1) d += ` L ${tail.x},${tail.y}`;
  return d;
}

/** 平滑后的路径：一步到位（拖线预览、测试用）。 */
export function softPath(
  points: readonly Position[],
  obstacles: readonly Box[] = [],
  radius: number = SOFT_RADIUS,
): string {
  return smoothPath(points, cornerCuts(points, obstacles, radius));
}
