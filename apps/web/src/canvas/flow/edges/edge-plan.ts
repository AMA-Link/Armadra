import type { CanvasEdgeRole } from "@armadra/shared";
import {
  dispatchAnchor,
  roundedPath,
  routeFor,
  type EdgeLayout as CoreLayout,
  type EdgePlan,
  type EdgeScene,
  type LinkAnchor,
  type RoutedEdge,
  type SidePair,
} from "@armadra/board/core";

import { CORNER_RADIUS, linkView, type LinkView } from "./link-visual";

/**
 * 一条边「画成什么样」的判断（两种引擎共用）：取边规则、束、标签优先级、路线。
 *
 * 从 `edge-router.ts` 抽出来，不依赖 React Flow：旧引擎的路由器与 `next` 的
 * `board/edge-layout.ts` 都调它，所以同一组节点位置下两边的折线点必然一致。
 */

export type EdgeLayout = CoreLayout<LinkView>;

export interface LayoutParams {
  direction: "vertical" | "horizontal";
  /** 标签字号（画布单位）；0 表示不画标签。 */
  fontSize: number;
  t: (key: string) => string;
}

/** 路由器认得的边：上下文连线（`link`）或内容引用（`reference`）。 */
export interface PlannedEdge extends RoutedEdge {
  type?: string | undefined;
  data?: unknown;
}

/** 不当障碍的节点：分组框（线本来就要穿进穿出）、墨迹与直线（形状不规则）。 */
export const PASS_THROUGH: ReadonlySet<string> = new Set([
  "group",
  "wb.ink",
  "wb.line",
  "ink",
  "line",
]);

/** 一条边怎么画：两端一动就重新选边（#211），派发线同束、先摆标签。 */
export function planOf(
  edge: PlannedEdge,
  scene: EdgeScene,
  typeOf: (id: string) => string | undefined,
  params: Pick<LayoutParams, "direction">,
): EdgePlan<LinkView> {
  const reference = edge.type === "reference";
  const role = reference
    ? undefined
    : (edge.data as { role?: CanvasEdgeRole } | undefined)?.role;
  const sourceType = typeOf(edge.source);
  const targetType = typeOf(edge.target);
  const supervises = role === "supervises";
  // 对等线就近边；派发线子在下游时按布局方向，被拖到主的上方 / 左侧时也改走就近边。
  const anchor: LinkAnchor = supervises
    ? dispatchAnchor(scene.source, scene.target, params.direction)
    : "free";
  return {
    key: `${edge.type}|${role ?? ""}|${sourceType ?? ""}|${targetType ?? ""}|${anchor}`,
    // 同一个主派出去的线共用主干，不必错开。
    bundle: supervises ? `dispatch:${edge.source}` : `edge:${edge.id}`,
    priority: supervises ? 0 : reference ? 2 : 1,
    view: (previous) =>
      reference
        ? referenceView(scene, previous)
        : linkView(
            scene.source,
            scene.target,
            sourceType,
            targetType,
            role,
            anchor,
            { obstacles: scene.obstacles, previous },
          ),
  };
}

/** 引用线：与上下文线同一套路由，箭头只指向节点，标签「引用」。 */
function referenceView(scene: EdgeScene, previous?: SidePair): LinkView {
  const route = routeFor(
    scene.source,
    scene.target,
    scene.obstacles,
    "free",
    previous,
  );
  return {
    route,
    d: roundedPath(route.points, CORNER_RADIUS, scene.obstacles),
    labelKey: "edge.reference",
    arrowStart: false,
    arrowEnd: true,
  };
}
