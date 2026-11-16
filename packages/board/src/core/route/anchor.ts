// 连线路由用的最小几何与取边规则：与应用的 `Box`（x/y/width/height）同构，所以画布侧不必转换；
// 与 geom 模块互不 import，需要的小函数先在这里私有一份，合并时去重。
import type { Vec } from "../types";

/** 轴对齐矩形：左上角加宽高。 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Side = "left" | "right" | "top" | "bottom";

export function centerOf(box: Box): Vec {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** 某条边的中点。 */
export function anchorPoint(box: Box, side: Side): Vec {
  switch (side) {
    case "left":
      return { x: box.x, y: box.y + box.height / 2 };
    case "right":
      return { x: box.x + box.width, y: box.y + box.height / 2 };
    case "top":
      return { x: box.x + box.width / 2, y: box.y };
    case "bottom":
      return { x: box.x + box.width / 2, y: box.y + box.height };
  }
}

/**
 * 连线锚点的取边规则。
 *
 * - `horizontal`：只走左右（横向布局的派发线：主右 → 子左）；
 * - `vertical`：只走上下（纵向布局的派发线：主底 → 子顶）；
 * - `free`：按两端的相对位置选最近的边（对等的上下文线、引用线）。
 */
export type LinkAnchor = "horizontal" | "vertical" | "free";

/**
 * 两个矩形之间沿 x / y 轴的空隙（负数表示在这条轴上有重叠）。
 *
 * `free` 选边看空隙而不只看中心：一个 600 宽的终端斜下方挂一个小便签，
 * 中心横向差更大，但两者在 x 上其实是重叠的——那时走左右会让线先往回折。
 */
function gaps(source: Box, target: Box): { x: number; y: number } {
  return {
    x: Math.max(
      target.x - (source.x + source.width),
      source.x - (target.x + target.width),
    ),
    y: Math.max(
      target.y - (source.y + source.height),
      source.y - (target.y + target.height),
    ),
  };
}

/** `free` 锚这一次该走左右还是上下。 */
function freeAxis(source: Box, target: Box): "horizontal" | "vertical" {
  const gap = gaps(source, target);
  const apartX = gap.x >= 0;
  const apartY = gap.y >= 0;
  // 只在一条轴上分开：就走那条轴上相对的两条边。
  if (apartX && !apartY) return "horizontal";
  if (apartY && !apartX) return "vertical";
  // 两条轴上都分开（斜着摆）：空隙大的那条轴。
  if (apartX && apartY) return gap.x >= gap.y ? "horizontal" : "vertical";
  // 叠在一起：退回比较中心。
  const from = centerOf(source);
  const to = centerOf(target);
  return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
    ? "horizontal"
    : "vertical";
}

/** 两个矩形互相「面对」的边。 */
export function facingSides(
  source: Box,
  target: Box,
  anchor: LinkAnchor = "horizontal",
): { source: Side; target: Side } {
  const from = centerOf(source);
  const to = centerOf(target);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const axis = anchor === "free" ? freeAxis(source, target) : anchor;

  if (axis === "horizontal") {
    return dx >= 0
      ? { source: "right", target: "left" }
      : { source: "left", target: "right" };
  }
  return dy >= 0
    ? { source: "bottom", target: "top" }
    : { source: "top", target: "bottom" };
}

/**
 * 派发线这一刻该用的锚（#211）。
 *
 * 子节点还在布局方向的「下游」（纵向：整个落在主的下方；横向：整个落在主的
 * 右侧）时按布局方向走主底 → 子顶 / 主右 → 子左，同侧几条线共用一个出点；
 * 被拖到主的上方、左侧或与主叠在一起时，布局方向已经说不通，改走就近边。
 */
export function dispatchAnchor(
  source: Box,
  target: Box,
  direction: "vertical" | "horizontal",
): LinkAnchor {
  const downstream =
    direction === "vertical"
      ? target.y >= source.y + source.height
      : target.x >= source.x + source.width;
  return downstream ? direction : "free";
}
