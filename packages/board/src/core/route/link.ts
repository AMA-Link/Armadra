import { facingSides, type Box, type LinkAnchor, type Side } from "./anchor";
import { routeEdge, type Route, type SidePair } from "./route";

const ALL_SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

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
