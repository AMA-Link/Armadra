import type { CanvasEdgeRole, Position } from "@armadra/shared";

import {
  facingSides,
  type Box,
  type LinkAnchor,
  type Side,
} from "../../geometry";
import { edgeArrowheads, edgeLabelKey } from "../../sync/project";
import { roundedPath, routeEdge, type Route, type SidePair } from "./route";

/**
 * 一条上下文连线画成什么样（纯函数，`LinkEdge.tsx` 与单测共用）。
 *
 * 路线（`route.ts` 的避障正交折线 + 圆角）、箭头方向、标签键、线宽。另一半（`ShapeUtil` 的 `getGeometry` / `getIndicatorPath` /
 * 一堆 `hideXxx`）在 React Flow 里没有对应物——边的命中区由 `BaseEdge` 的
 * `interactionWidth` 给，选中框就是线本身变粗。
 */

/** 线宽：常态 2，选中 3.5（旧画布契约 §3.3）。 */
export const STROKE_WIDTH = 2;
export const STROKE_WIDTH_SELECTED = 3.5;

/** 边的命中区宽度（画布单位）。默认 20 在触屏上偏窄。 */
export const INTERACTION_WIDTH = 24;

/** 箭头长度（画布单位，跟着相机缩放）与张角。 */
export const ARROW_SIZE = 11;
const ARROW_SPREAD = 0.45;

/** 拐角圆角半径（画布单位）。 */
export const CORNER_RADIUS = 14;

const ALL_SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

export interface LinkView {
  route: Route;
  /** 给 `<path>` 的路径（折线 + 圆角）。 */
  d: string;
  /** 常驻标签的 i18n 键。 */
  labelKey: string | null;
  arrowStart: boolean;
  arrowEnd: boolean;
}

/**
 * 上下文线的颜色（`styles/tokens.css` 的 `--link-context`）。一个专用的品红：
 * 色相与派发簇的五色（`family.ts` 的 `CLUSTER_PALETTE`）都隔开 60° 以上，
 * 一眼分得出「读谁的上下文」与「谁派的」（`styles/tokens.test.ts` 守）。
 */
export const LINK_CONTEXT_COLOR = "var(--link-context)";

/**
 * 一条连线画什么颜色：选中与投递闪动用品牌色；派发线用主的簇色；上下文线用
 * {@link LINK_CONTEXT_COLOR}。画布与小地图共用。
 */
export function linkColor({
  supervises,
  familyColor,
  selected = false,
  flashing = false,
}: {
  supervises: boolean;
  familyColor?: string | undefined;
  selected?: boolean;
  flashing?: boolean;
}): string {
  if (flashing || selected) return "var(--brand)";
  if (supervises) return familyColor ?? "var(--brand)";
  return LINK_CONTEXT_COLOR;
}

/** 派发线的标签。 */
export const DISPATCH_LABEL_KEY = "edge.role.dispatch";

/**
 * 一条线允许从哪些边出入：派发线顺布局方向只有一对；`free` 四边都行，
 * 正对的那一对优先（`route.ts` 给其余的边加代价）。
 */
export function routeFor(
  source: Box,
  target: Box,
  obstacles: readonly Box[] = [],
  anchor: LinkAnchor = "free",
  previous?: SidePair,
): Route {
  const facing = facingSides(source, target, anchor);
  const fixed = anchor !== "free";
  return routeEdge({
    source,
    target,
    obstacles,
    sourceSides: fixed ? [facing.source] : ALL_SIDES,
    targetSides: fixed ? [facing.target] : ALL_SIDES,
    preferred: facing,
    previous: fixed ? undefined : previous,
  });
}

/**
 * 两端的矩形、节点类型与边的角色 → 画一条线需要的全部信息（ui-wave2 §3.2）。
 *
 * 对等线：箭头与标签只看**类型**，不看用户从哪一头拖出来（§21）——内容 →
 * 终端单向，终端 ↔ 终端双向，内容 ↔ 内容无箭头；分组的类型是 `"group"`，
 * 落在「内容」那一类里。
 *
 * 派发线（`supervises`）：只在子那一端画箭头，标签「派发」。
 *
 * `anchor` 决定走哪条边：对等线 `free`（就近边），派发线按布局方向。
 * `obstacles` 是附近要绕开的节点矩形，`previous` 是上一次的出入边（防抖）。
 */
export function linkView(
  source: Box,
  target: Box,
  sourceType?: string,
  targetType?: string,
  role?: CanvasEdgeRole,
  anchor: LinkAnchor = "free",
  options: { obstacles?: readonly Box[]; previous?: SidePair } = {},
): LinkView {
  const route = routeFor(
    source,
    target,
    options.obstacles,
    anchor,
    options.previous,
  );
  const d = roundedPath(route.points, CORNER_RADIUS);
  const labelKey = edgeLabelKey(sourceType, targetType, role);
  if (role === "supervises") {
    return { route, d, labelKey, arrowStart: false, arrowEnd: true };
  }
  const heads = edgeArrowheads(sourceType, targetType);
  return {
    route,
    d,
    labelKey,
    arrowStart: heads.start === "arrow",
    arrowEnd: heads.end === "arrow",
  };
}

/**
 * 端点处的一个「V」形箭头，沿末段线段的方向画（`from` 是那一段的另一头）。
 *
 * 不用 SVG `marker`：一条边一个 marker id，30 条线就是 30 个 `<defs>`，
 * 而且 marker 不跟着 `currentColor` 走，选中变色时还要再复制一份。
 */
export function arrowHead(tip: Position, from: Position): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return "";
  const ux = dx / length;
  const uy = dy / length;
  const barb = (sign: number): Position => {
    const cos = Math.cos(ARROW_SPREAD);
    const sin = Math.sin(ARROW_SPREAD) * sign;
    return {
      x: tip.x - ARROW_SIZE * (ux * cos - uy * sin),
      y: tip.y - ARROW_SIZE * (uy * cos + ux * sin),
    };
  };
  const a = barb(1);
  const b = barb(-1);
  return `M ${a.x},${a.y} L ${tip.x},${tip.y} L ${b.x},${b.y}`;
}
