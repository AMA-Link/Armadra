import type { CanvasNode } from "@armadra/shared";
import type { Entity, EntityId } from "@armadra/board/core";
import type { BoardEvents, DomBoard } from "@armadra/board/dom";

import { useCanvasStore } from "@/store/canvas-store";
import { absolutePosition } from "@/store/canvas/internal";
import { COLLAPSED_HEIGHT } from "@/store/defaults";
import { NODE_META } from "@/nodes/registry";
import { clearDrafts, setDrafts } from "../flow/drafts";
import { entityOf, type BoardEntity } from "./model";

/**
 * `canvas-store` ↔ 引擎场景（docs/design/board-engine.md §2.2，B3 只接节点与分组）。
 *
 * 数据流：
 *
 *   store.document.nodes ──按对象身份 diff──► scene（`history: "ignore"`，不进引擎撤销栈）
 *   引擎事件 select / move / resize ──────► store 动作（moveNodes / setParent / resizeNode …）
 *   store.selectedNodeIds ◄──► board.setSelection
 *
 * 身份保持：`CanvasNode` 没换就不碰场景里那个实体，实体对象也就不换，宿主上的
 * 节点组件不重渲；节点换了才重建一个实体。场景只收实体头，业务内容（`data` =
 * `CanvasNode`）原样透传。
 *
 * 写回时机：拖动 / 缩放结束时引擎**先发事件、再清预览**，所以事件监听里同步写
 * store；store 写完同步改场景，预览一清实体已在新位置，不会闪回原位。
 */

export interface BoardAdapter {
  destroy(): void;
}

type Store = typeof useCanvasStore;

/** 把手势进行中的状态喂给 `flow/drafts` 的「有没有手势」判定（实时绑定据此攒着远端改动）。 */
const GESTURE_DRAFT = "board:gesture";

const round2 = (value: number): number => Math.round(value * 100) / 100;

function sameSet(a: ReadonlySet<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((id) => a.has(id));
}

export function createBoardAdapter(
  board: DomBoard<CanvasNode>,
  store: Store = useCanvasStore,
): BoardAdapter {
  const known = new Map<EntityId, { node: CanvasNode; entity: BoardEntity }>();
  let lastNodes: readonly CanvasNode[] | undefined;

  function syncNodes(nodes: readonly CanvasNode[]): void {
    if (nodes === lastNodes) return;
    lastNodes = nodes;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const changed: BoardEntity[] = [];
    for (const node of nodes) {
      if (known.get(node.id)?.node === node) continue;
      const entity = entityOf(node, byId);
      known.set(node.id, { node, entity });
      changed.push(entity);
    }
    const gone = [...known.keys()].filter((id) => !byId.has(id));
    for (const id of gone) known.delete(id);
    if (changed.length === 0 && gone.length === 0) return;
    board.scene.transact(
      (draft) => {
        for (const entity of changed) draft.set(entity as Entity<CanvasNode>);
        for (const id of gone) draft.remove(id);
      },
      { history: "ignore" },
    );
    // 选区里已经不存在的节点要从引擎选区里去掉。
    pushSelection(store.getState().selectedNodeIds);
  }

  function pushSelection(ids: readonly string[]): void {
    const present = ids.filter((id) => known.has(id));
    if (sameSet(board.selection(), present)) return;
    board.setSelection(new Set(present));
  }

  const originOf = (nodes: readonly CanvasNode[], parentId: string | null) => {
    const parent = parentId
      ? nodes.find((node) => node.id === parentId)
      : undefined;
    return parent ? absolutePosition(nodes, parent) : { x: 0, y: 0 };
  };

  const onSelect = ({ ids }: BoardEvents["select"]): void => {
    // 引擎的选区是整体：点空白或换选一个，连线与白板对象的选区一并清掉。
    store.getState().setSelection({ nodes: ids, edges: [], items: [] });
  };

  const onMove = ({ ids, positions, reparent }: BoardEvents["move"]): void => {
    const before = store.getState().document?.nodes;
    if (!before) return;
    const byId = new Map(before.map((node) => [node.id, node]));
    // 引擎给的位置相对「它想去的父级」；先换成画布绝对坐标，
    // 再按 store 最终接受的父级换回相对坐标（组不能进组，store 会拒绝）。
    const absolute = new Map<string, { x: number; y: number }>();
    const byTarget = new Map<string | null, string[]>();
    for (const id of ids) {
      const at = positions.get(id);
      const node = byId.get(id);
      if (!at || !node) continue;
      const target = reparent.has(id)
        ? (reparent.get(id) ?? null)
        : (node.parentId ?? null);
      const origin = originOf(before, target);
      absolute.set(id, { x: at.x + origin.x, y: at.y + origin.y });
      if (reparent.has(id)) {
        byTarget.set(target, [...(byTarget.get(target) ?? []), id]);
      }
    }
    for (const [target, group] of byTarget) {
      store.getState().setParent(group, target);
    }
    const after = store.getState().document?.nodes ?? before;
    const moves = [...absolute].flatMap(([id, point]) => {
      const node = after.find((item) => item.id === id);
      if (!node) return [];
      const origin = originOf(after, node.parentId ?? null);
      return [
        {
          id,
          position: {
            x: round2(point.x - origin.x),
            y: round2(point.y - origin.y),
          },
        },
      ];
    });
    store.getState().moveNodes(moves);
  };

  const onResize = ({ id, box }: BoardEvents["resize"]): void => {
    const node = store.getState().document?.nodes.find((n) => n.id === id);
    if (!node) return;
    const min = NODE_META[node.type].minSize;
    store.getState().resizeNode(
      id,
      {
        width: Math.max(min.width, Math.round(box.w)),
        height: node.collapsed
          ? COLLAPSED_HEIGHT
          : Math.max(min.height, Math.round(box.h)),
      },
      { x: Math.round(box.x), y: Math.round(box.y) },
    );
  };

  const onGesture = ({ active }: BoardEvents["gesture"]): void => {
    if (active) setDrafts([[GESTURE_DRAFT, {}]]);
    else clearDrafts([GESTURE_DRAFT]);
  };

  syncNodes(store.getState().document?.nodes ?? []);
  pushSelection(store.getState().selectedNodeIds);

  const stops = [
    store.subscribe((state, previous) => {
      if (state.document?.nodes !== previous.document?.nodes) {
        syncNodes(state.document?.nodes ?? []);
      }
      if (state.selectedNodeIds !== previous.selectedNodeIds) {
        pushSelection(state.selectedNodeIds);
      }
    }),
    board.on("select", onSelect),
    board.on("move", onMove),
    board.on("resize", onResize),
    board.on("gesture", onGesture),
  ];

  return {
    destroy() {
      for (const stop of stops) stop();
      clearDrafts([GESTURE_DRAFT]);
    },
  };
}
