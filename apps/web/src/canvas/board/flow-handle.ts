import type { Node } from "@xyflow/react";
import type { CanvasNode } from "@armadra/shared";
import type { DomBoard } from "@armadra/board/dom";

import type { FlowHandle } from "../flow/flow-context";

/**
 * 自研引擎对 `flow-context` 那组视口方法的适配：`getViewport` / `setViewport` /
 * `screenToFlowPosition` / `zoomTo` / `setCenter` / `getNode(s)`。
 *
 * 外面十几处（视口命令、新建节点落点、最大化、整理、拖放坐标）只认这组方法，
 * 所以适配一次，它们对两种引擎都不改。`getNode(s)` 给的是 `getNodesBounds` 能读
 * 的节点形状：`internals.positionAbsolute` 与 `measured` 取自引擎场景（宿主尺寸
 * 就是文档尺寸，没有「量到的」另一份）。
 */
export function createBoardFlowHandle(
  board: DomBoard<CanvasNode>,
  container: () => HTMLElement | null,
): FlowHandle {
  const { camera, scene } = board;

  const nodeOf = (id: string): Node | undefined => {
    const entity = scene.get(id);
    const box = scene.bounds(id);
    if (!entity || !box) return undefined;
    const size = { width: entity.w, height: entity.h };
    return {
      id,
      type: entity.kind,
      position: { x: entity.x, y: entity.y },
      ...(entity.parent ? { parentId: entity.parent } : {}),
      ...size,
      measured: size,
      selected: board.selection().has(id),
      data: entity.data,
      internals: { positionAbsolute: { x: box.x, y: box.y }, z: entity.z },
    } as unknown as Node;
  };

  return {
    getViewport: () => ({ ...camera.get() }),
    setViewport: (viewport, options) => {
      camera.set(viewport, { duration: options?.duration ?? 0 });
      return Promise.resolve(true);
    },
    screenToFlowPosition: (point) => {
      const rect = container()?.getBoundingClientRect();
      return camera.screenToWorld({
        x: point.x - (rect?.left ?? 0),
        y: point.y - (rect?.top ?? 0),
      });
    },
    zoomTo: (zoom, options) => {
      const rect = container()?.getBoundingClientRect();
      camera.zoomAround(
        { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 },
        zoom,
        { duration: options?.duration ?? 0 },
      );
      return Promise.resolve(true);
    },
    setCenter: (x, y, options) => {
      camera.center(
        { x, y },
        {
          ...(options?.zoom === undefined ? {} : { zoom: options.zoom }),
          duration: options?.duration ?? 0,
        },
      );
      return Promise.resolve(true);
    },
    getNode: nodeOf as FlowHandle["getNode"],
    getNodes: () =>
      scene
        .ordered()
        // 连线（带 `ends` 的实体）不是节点。
        .flatMap((entity) =>
          entity.ends ? [] : (nodeOf(entity.id) ?? []),
        ) as ReturnType<FlowHandle["getNodes"]>,
  };
}
