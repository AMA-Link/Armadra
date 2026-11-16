import type { CanvasEdgeRole, CanvasNode } from "@armadra/shared";
import type { Entity } from "@armadra/board/core";
import type { DomKindSpec } from "@armadra/board/dom";

/**
 * 连线 ↔ 引擎实体（设计 §2.3 的 `link` / `reference`，B4）。
 *
 * 连线是场景里带 `ends` 的实体：引擎据此在两端移动时通知它、缩略图把它画成线、
 * 框选 / 拖动 / 导出都认得并跳过它。它放在 `overlay` 层，所以没有宿主元素、也
 * 不上 Canvas；实际的线由世界坐标 SVG 叠加层画（`BoardEdges`），命中走几何
 * （折线距离，`edge-hit.ts`）。
 */

export const LINK_KIND = "link";
export const REFERENCE_KIND = "reference";

export interface EdgeData {
  type: typeof LINK_KIND | typeof REFERENCE_KIND;
  role?: CanvasEdgeRole;
}

export type BoardEdgeEntity = Entity<CanvasNode>;

/** 边的实体：几何字段不用（`ends` 的实体取两端的并集）。 */
export function edgeEntity(edge: {
  id: string;
  type?: string | undefined;
  source: string;
  target: string;
  data?: { role?: CanvasEdgeRole } | Record<string, never> | undefined;
}): BoardEdgeEntity {
  const reference = edge.type === REFERENCE_KIND;
  const role = reference
    ? undefined
    : (edge.data as { role?: CanvasEdgeRole } | undefined)?.role;
  const data: EdgeData = {
    type: reference ? REFERENCE_KIND : LINK_KIND,
    ...(role === undefined ? {} : { role }),
  };
  return {
    id: edge.id,
    kind: data.type,
    ends: [edge.source, edge.target],
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    z: reference ? 0 : 1,
    data: data as unknown as CanvasNode,
  };
}

export const edgeDataOf = (entity: Entity<unknown>): EdgeData =>
  entity.data as EdgeData;

export const isEdgeEntity = (entity: Entity<unknown>): boolean =>
  entity.ends !== undefined;

export function edgeKinds(): Record<string, DomKindSpec<CanvasNode>> {
  return {
    [LINK_KIND]: { layer: "overlay" },
    [REFERENCE_KIND]: { layer: "overlay" },
  };
}
