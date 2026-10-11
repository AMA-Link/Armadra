import type { InternalNode, Node } from "@xyflow/react";

import type { Box } from "../../geometry";

/**
 * 一条边路由时要看的那一小块画布（#318）：两端的矩形 + 附近的障碍。
 *
 * 每条边用它当 React Flow `useStore` 的选择器，配合 {@link sameScene}：
 * 只有两端或附近障碍真的挪了（取整到 1 个单位后）才会让这条边重渲、重算
 * 路由；拖一个节点时远处的线不动，平移缩放时一条线都不重算。
 */

/** 只在两端外扩这么多的范围里找障碍；路线绕不出这个范围外很远。 */
export const SCENE_MARGIN = 240;

/** 不当障碍的节点：分组框（线本来就要穿进穿出）、墨迹与直线（形状不规则）。 */
const PASS_THROUGH = new Set(["group", "wb.ink", "wb.line"]);

export interface EdgeScene {
  source: Box;
  target: Box;
  obstacles: Box[];
}

/** 一个节点的绝对矩形（取整）；还没量到尺寸时退回投影给的宽高。 */
export function boxOfNode(node: InternalNode<Node> | undefined): Box | null {
  if (!node) return null;
  const width = node.measured.width ?? node.width ?? 0;
  const height = node.measured.height ?? node.height ?? 0;
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.round(node.internals.positionAbsolute.x),
    y: Math.round(node.internals.positionAbsolute.y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function contains(outer: Box, inner: Box): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function intersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** 从 React Flow 的节点表里取出一条边的场景；任一端还没尺寸时为 `null`。 */
export function sceneOf(
  nodes: ReadonlyMap<string, InternalNode<Node>>,
  sourceId: string,
  targetId: string,
): EdgeScene | null {
  const source = boxOfNode(nodes.get(sourceId));
  const target = boxOfNode(nodes.get(targetId));
  if (!source || !target) return null;
  const left = Math.min(source.x, target.x) - SCENE_MARGIN;
  const top = Math.min(source.y, target.y) - SCENE_MARGIN;
  const region: Box = {
    x: left,
    y: top,
    width:
      Math.max(source.x + source.width, target.x + target.width) +
      SCENE_MARGIN -
      left,
    height:
      Math.max(source.y + source.height, target.y + target.height) +
      SCENE_MARGIN -
      top,
  };
  const obstacles: Box[] = [];
  for (const [id, node] of nodes) {
    if (id === sourceId || id === targetId) continue;
    if (node.hidden || PASS_THROUGH.has(node.type ?? "")) continue;
    const box = boxOfNode(node);
    if (!box || !intersects(box, region)) continue;
    // 把一端整个包住的节点（外框）不挡路。
    if (contains(box, source) || contains(box, target)) continue;
    obstacles.push(box);
  }
  return { source, target, obstacles };
}

function sameBox(a: Box, b: Box): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/** `useStore` 的相等判断：几何一样就沿用上一次的对象。 */
export function sameScene(a: EdgeScene | null, b: EdgeScene | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (!sameBox(a.source, b.source) || !sameBox(a.target, b.target)) {
    return false;
  }
  if (a.obstacles.length !== b.obstacles.length) return false;
  return a.obstacles.every((box, i) => sameBox(box, b.obstacles[i]!));
}
