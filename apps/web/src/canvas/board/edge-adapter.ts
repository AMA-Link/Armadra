import type { CanvasNode } from "@armadra/shared";
import type { Entity, EntityId } from "@armadra/board/core";
import type { DomBoard } from "@armadra/board/dom";

import { useCanvasStore } from "@/store/canvas-store";
import { projectEdges } from "../sync/project-edges";
import { edgeEntity, edgeKinds, type BoardEdgeEntity } from "./edge-model";

/**
 * `canvas-store` 的连线 → 引擎场景（B4）。
 *
 * 数据来源与旧引擎同一个纯函数 `projectEdges`：`document.edges` 是上下文连线，
 * `whiteboard.references` 是内容引用（来源端是白板对象或 Frame）；任一端不在
 * 画布上的投影不出来。连线由用户的建 / 删动作改变，写场景一律 `history: "ignore"`
 * （撤销栈是 store 的，不是引擎的）。
 *
 * 身份保持与节点一样：边没变（类型、两端、角色都同）就不碰场景里那个实体。
 */

type Store = typeof useCanvasStore;

export interface BoardEdgeAdapter {
  destroy(): void;
}

export function createBoardEdgeAdapter(
  board: DomBoard<CanvasNode>,
  store: Store = useCanvasStore,
): BoardEdgeAdapter {
  for (const [kind, spec] of Object.entries(edgeKinds())) {
    board.registerKind(kind, spec);
  }
  const known = new Map<EntityId, { key: string; entity: BoardEdgeEntity }>();
  let last: readonly unknown[] = [];

  function sync(): void {
    const { document, whiteboard } = store.getState();
    const inputs = [
      document?.nodes,
      document?.edges,
      whiteboard.items,
      whiteboard.references,
    ] as const;
    if (inputs.every((value, i) => value === last[i])) return;
    last = inputs;
    const edges = projectEdges(document, whiteboard);
    const live = new Set<EntityId>();
    const changed: BoardEdgeEntity[] = [];
    for (const edge of edges) {
      live.add(edge.id);
      const role = (edge.data as { role?: string } | undefined)?.role ?? "";
      const key = `${edge.type}|${edge.source}|${edge.target}|${role}`;
      if (known.get(edge.id)?.key === key) continue;
      const entity = edgeEntity(edge);
      known.set(edge.id, { key, entity });
      changed.push(entity);
    }
    const gone = [...known.keys()].filter((id) => !live.has(id));
    for (const id of gone) known.delete(id);
    if (changed.length === 0 && gone.length === 0) return;
    board.scene.transact(
      (draft) => {
        for (const entity of changed) draft.set(entity as Entity<CanvasNode>);
        for (const id of gone) draft.remove(id);
      },
      { history: "ignore" },
    );
  }

  sync();
  const stop = store.subscribe(sync);
  return {
    destroy() {
      stop();
      // 场景随板销毁；这里只让后续的同步不再写。
      known.clear();
    },
  };
}
