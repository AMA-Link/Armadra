import type { CanvasNode } from "@armadra/shared";
import type { Entity } from "@armadra/board/core";
import type { BoardEvents, DomBoard } from "@armadra/board/dom";

import { useCanvasStore } from "@/store/canvas-store";
import { isItemId, toItemId, type Item } from "../../whiteboard/model";
import {
  beginGesture,
  endGesture,
  resizeItem,
  updateItems,
} from "../../whiteboard/store";
import { setImageWorkspace, onImageLoaded } from "./images";
import { wbKindOf } from "./kinds";
import { onFontsReady, textHeight } from "./text";

/**
 * 白板对象 ↔ 引擎场景（设计 §2.2，B5）。
 *
 *   store.whiteboard.items ──按对象身份 diff──► scene（`history: "ignore"`）
 *   引擎事件 move / resize（`wb:` 开头的 id）──► whiteboard/store 动作
 *
 * 实体 id 是 `wb:<对象 id>`，与节点（裸 uuid）不冲突；`kind` 带遮挡带（`kinds.ts`）。
 * 选区的双向映射在 `board-adapter`（选区是节点与白板对象的整体）。
 *
 * 移动事件的监听必须先于 `board-adapter` 的注册：节点与白板对象一起拖时，这里
 * 开一个合并会话、微任务里收，两边的写入合成一条历史。
 */

type Store = typeof useCanvasStore;
type WbEntity = Entity<Item>;

export interface WhiteboardSync {
  destroy(): void;
}

export const entityOfItem = (item: Item): WbEntity => ({
  id: toItemId(item.id),
  kind: wbKindOf(item),
  ...(item.parentId ? { parent: item.parentId } : {}),
  x: item.x,
  y: item.y,
  w: item.w,
  h: item.h,
  z: item.z,
  data: item,
});

const round = (value: number): number => Math.round(value);

export function createWhiteboardSync(
  board: DomBoard<CanvasNode>,
  store: Store = useCanvasStore,
): WhiteboardSync {
  const known = new Map<string, { item: Item; entity: WbEntity }>();
  let last: readonly Item[] | undefined;
  /** 字体没就绪前量出来的高度不可信：不写回文档（免得打开板就置脏）。 */
  let fontsReady =
    typeof document === "undefined" ||
    !document.fonts ||
    document.fonts.status === "loaded";

  /** 文字对象的高度由内容算：排版结果与文档不一致就写回（不进历史）。 */
  function fitTexts(items: readonly Item[]): void {
    if (!fontsReady) return;
    const patches = items.flatMap((item) => {
      if (item.kind !== "text") return [];
      const h = textHeight(item);
      return Math.abs(h - item.h) >= 1 ? [{ id: item.id, patch: { h } }] : [];
    });
    if (patches.length === 0) return;
    queueMicrotask(() => updateItems(patches as never, { history: "ignore" }));
  }

  function syncItems(items: readonly Item[]): void {
    if (items === last) return;
    last = items;
    const byId = new Map(items.map((item) => [toItemId(item.id), item]));
    const changed: WbEntity[] = [];
    const fresh: Item[] = [];
    for (const [id, item] of byId) {
      if (known.get(id)?.item === item) continue;
      const entity = entityOfItem(item);
      known.set(id, { item, entity });
      changed.push(entity);
      fresh.push(item);
    }
    const gone = [...known.keys()].filter((id) => !byId.has(id));
    for (const id of gone) known.delete(id);
    if (changed.length === 0 && gone.length === 0) return;
    board.scene.transact(
      (draft) => {
        for (const entity of changed)
          draft.set(entity as unknown as Entity<CanvasNode>);
        for (const id of gone) draft.remove(id);
      },
      { history: "ignore" },
    );
    fitTexts(fresh);
  }

  const onMove = ({ ids, positions, reparent }: BoardEvents["move"]): void => {
    const mine = ids.filter(isItemId);
    if (mine.length === 0) return;
    if (mine.length < ids.length) {
      beginGesture("canvas.move");
      queueMicrotask(endGesture);
    }
    updateItems(
      mine.flatMap((id) => {
        const at = positions.get(id);
        if (!at) return [];
        const patch: Partial<Item> = { x: round(at.x), y: round(at.y) };
        if (reparent.has(id)) {
          patch.parentId = reparent.get(id) ?? undefined;
        }
        return [{ id, patch }];
      }),
      { label: "whiteboard.move" },
    );
  };

  const onResize = ({ id, box }: BoardEvents["resize"]): void => {
    if (!isItemId(id)) return;
    resizeItem(id, {
      x: round(box.x),
      y: round(box.y),
      w: Math.max(8, round(box.w)),
      h: Math.max(8, round(box.h)),
    });
  };

  const workspace = (id: string | null | undefined) =>
    setImageWorkspace(id ?? null);
  workspace(store.getState().workspace?.id);
  syncItems(store.getState().whiteboard.items);

  const stops = [
    // 先于 board-adapter 的 move 监听（见文件头）。
    board.on("move", onMove),
    board.on("resize", onResize),
    store.subscribe((state, previous) => {
      if (state.workspace?.id !== previous.workspace?.id) {
        workspace(state.workspace?.id);
        board.invalidate();
      }
      if (state.whiteboard.items !== previous.whiteboard.items) {
        syncItems(state.whiteboard.items);
      }
    }),
    onImageLoaded(() => board.invalidate()),
    onFontsReady(() => {
      fontsReady = true;
      board.invalidate();
      fitTexts(store.getState().whiteboard.items);
    }),
  ];

  return {
    destroy() {
      for (const stop of stops) stop();
      known.clear();
    },
  };
}
