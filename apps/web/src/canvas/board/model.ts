import type { CanvasNode, CanvasNodeType } from "@armadra/shared";
import type { DomKindSpec } from "@armadra/board/dom";
import type { Entity } from "@armadra/board/core";

import { COLLAPSED_HEIGHT, defaultNodeSize } from "../../store/defaults";
import { NODE_DRAG_HANDLE, NODE_META } from "../../nodes/registry";

/**
 * 节点 ↔ 引擎实体（设计 §2.3 的对应表，B3 只接 `nodes` 表）。
 *
 * 实体的 `kind` 带上最小尺寸与折叠态，因为引擎的缩放约束按 kind 登记：
 * 终端、便签、变更……最小尺寸各不相同，折叠的节点高度钉死只能改宽。
 * 分组统一叫 `group`（引擎拖入分组的缺省判据就是这个名字）。
 */
export type BoardEntity = Entity<CanvasNode>;

export const GROUP_KIND = "group";
/** 切走的板上还活着的网页节点：场景里留一个零尺寸的条目，宿主与 `<webview>` 原地不动。 */
export const GHOST_KIND = "browser:ghost";

/** 分组画在普通节点下面（与旧投影的 `GROUP_Z_INDEX` / `NODE_Z_INDEX` 同义）。 */
const CARD_Z = 1000;

export function kindOf(node: CanvasNode): string {
  if (node.type === "group") return GROUP_KIND;
  return node.collapsed ? `${node.type}:collapsed` : node.type;
}

/** 折叠时高度钉死；其余取文档尺寸，没写过 `size` 的按种类默认值。 */
export function geometryOf(node: CanvasNode): {
  w: number;
  h: number;
} {
  const size = node.size ?? defaultNodeSize(node.type);
  return {
    w: size.width,
    h: node.collapsed ? COLLAPSED_HEIGHT : size.height,
  };
}

/** 分组嵌套的深度，用来排序：外层分组压在里层分组下面。 */
function depthOf(nodes: ReadonlyMap<string, CanvasNode>, node: CanvasNode) {
  let depth = 0;
  for (
    let at = node.parentId ? nodes.get(node.parentId) : undefined;
    at && depth < 8;
    at = at.parentId ? nodes.get(at.parentId) : undefined
  ) {
    depth += 1;
  }
  return depth;
}

export function entityOf(
  node: CanvasNode,
  nodes: ReadonlyMap<string, CanvasNode>,
): BoardEntity {
  const { w, h } = geometryOf(node);
  return {
    id: node.id,
    kind: kindOf(node),
    ...(node.parentId ? { parent: node.parentId } : {}),
    x: node.position.x,
    y: node.position.y,
    w,
    h,
    z: node.type === "group" ? depthOf(nodes, node) : CARD_Z,
    data: node,
  };
}

/** ghost 条目：零面积、落在 `anchor`，按活着时的节点原样带着 `data`。 */
export function ghostOf(
  node: CanvasNode,
  anchor: { x: number; y: number },
): BoardEntity {
  return {
    id: node.id,
    kind: GHOST_KIND,
    x: anchor.x,
    y: anchor.y,
    w: 0,
    h: 0,
    z: CARD_Z,
    data: node,
  };
}

/** 全部种类登记：节点体按种类一张表，最小尺寸取 `NODE_META`。 */
export function nodeKinds(): Record<string, DomKindSpec<CanvasNode>> {
  const kinds: Record<string, DomKindSpec<CanvasNode>> = {};
  for (const type of Object.keys(NODE_META) as CanvasNodeType[]) {
    const { minSize } = NODE_META[type];
    const min = { w: minSize.width, h: minSize.height };
    if (type === "group") {
      kinds[GROUP_KIND] = { layer: "world", resize: { min } };
      continue;
    }
    kinds[type] = {
      layer: "world",
      dragHandle: NODE_DRAG_HANDLE,
      resize: { min },
    };
    kinds[`${type}:collapsed`] = {
      layer: "world",
      dragHandle: NODE_DRAG_HANDLE,
      resize: { min, widthOnly: true },
    };
  }
  // ghost 不可命中、不能起笔也不能作落点。
  kinds[GHOST_KIND] = {
    layer: "world",
    resize: false,
    hit: () => false,
    connect: { start: false, end: false },
  };
  return kinds;
}

/**
 * 可编辑区与自滚区：沿用节点体已有的类名约定，引擎在这些区域里放手
 * （终端、编辑器、网页、输入框、头部按钮），不用给几十处控件逐个加属性。
 */
export const BOARD_SELECTORS = {
  editable:
    'button, input, textarea, select, a[href], [contenteditable="true"], [data-no-drag="true"], .nodrag, .xterm',
  nowheel: ".nowheel",
} as const;
