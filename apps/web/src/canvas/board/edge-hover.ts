import { distToPolyline, type Vec } from "@armadra/board/core";

import { INTERACTION_WIDTH } from "../flow/edges/link-visual";
import type { BoardEdgeRouter } from "./edge-layout";

/**
 * 连线的几何命中（B4）：指针到折线的距离，不再给每条线铺一条加粗的透明路径。
 *
 * 容差取 `INTERACTION_WIDTH` 的一半（与旧引擎的命中带同宽，随缩放），缩得很小
 * 时至少 6 个屏幕像素；重叠时取最近的一条。
 */
export function edgeHitTolerance(zoom: number): number {
  return Math.max(INTERACTION_WIDTH / 2, 6 / (zoom > 0 ? zoom : 1));
}

export function hitEdge(
  router: Pick<BoardEdgeRouter, "edges" | "current">,
  world: Vec,
  zoom: number,
): string | null {
  const tolerance = edgeHitTolerance(zoom);
  let best: string | null = null;
  let nearest = Infinity;
  for (const edge of router.edges()) {
    const layout = router.current(edge.id);
    if (!layout) continue;
    const distance = distToPolyline(world, layout.view.route.points);
    if (distance <= tolerance && distance < nearest) {
      nearest = distance;
      best = edge.id;
    }
  }
  return best;
}

/** 每条边的悬停提示（投递结果、主从关系）；由边组件登记，悬停时读。 */
const tooltips = new Map<string, string>();

export function setEdgeTooltip(id: string, text: string | null): void {
  if (text === null) tooltips.delete(id);
  else tooltips.set(id, text);
}

export function edgeTooltip(id: string): string | undefined {
  return tooltips.get(id);
}
