import * as Y from "yjs";

import {
  setHistoryDelegate,
  type HistoryDelegate,
} from "../store/canvas-store";
import { WHITEBOARD_ENVELOPE, itemsOf, metaOf, rootsOf } from "./doc";

/**
 * 实时板的撤销（补全架构 §6.4）：一个 `Y.UndoManager` 管节点、连线、白板
 * 三类根，保住「一个撤销栈」的约定；只追踪本地来源的事务，所以远端改动
 * （别的客户端、core 的写者）不进栈。撤销 / 重做本身是一次非本地 origin 的
 * 事务，经绑定的远端灌入回到 store。
 *
 * 被远端删掉的节点上做过的改动，撤销时是 no-op：`Y.Map` 已经没了，Yjs 不会
 * 把它复活。
 *
 * `canvas-store` 自己的历史栈在实时板上停用（`setHistoryDelegate`），⌘Z 与
 * 工具栏的撤销按钮都走这里。
 */

export interface RealtimeUndo {
  readonly manager: Y.UndoManager;
  destroy(): void;
}

/**
 * 这一步是不是「只新建了白板对象 `itemId`」：没有删除；插入的只有 `itemsOf`
 * 里这条记录，外加第一次写白板时顺带落下的外壳（`meta.whiteboardEnvelope`）。
 */
function isCreationOnly(
  doc: Y.Doc,
  entry: Y.UndoManager["undoStack"][number] | undefined,
  itemId: string,
): boolean {
  if (!entry || entry.deletions.clients.size !== 0) return false;
  const items = itemsOf(doc);
  const live = items._map.get(itemId);
  if (!live || live.deleted) return false;
  const meta = metaOf(doc);
  let found = false;
  for (const [client, ranges] of entry.insertions.clients) {
    for (const { clock, len } of ranges) {
      for (let at = clock; at < clock + len; at++) {
        const struct = Y.getItem(doc.store, Y.createID(client, at));
        if (struct.parent === items && struct.parentSub === itemId) {
          found = true;
        } else if (
          struct.parent !== meta ||
          struct.parentSub !== WHITEBOARD_ENVELOPE
        ) {
          return false;
        }
      }
    }
  }
  return found;
}

/**
 * 每次提交一条历史（`captureTimeout: 0`）：store 一个动作就是一次事务，与非
 * 实时板「一次手势一条历史」相同；合并会话（文字编辑）期间临时放开合并。
 */
export function installUndo(doc: Y.Doc, origin: object): RealtimeUndo {
  const manager = new Y.UndoManager(rootsOf(doc), {
    trackedOrigins: new Set([origin]),
    captureTimeout: 0,
  });
  let coalescing = false;
  const watchers = new Set<() => void>();
  const delegate: HistoryDelegate = {
    undo: () => {
      manager.stopCapturing();
      manager.undo();
    },
    redo: () => {
      manager.redo();
    },
    canUndo: () => manager.canUndo(),
    canRedo: () => manager.canRedo(),
    beginCoalesce: () => {
      manager.stopCapturing();
      coalescing = true;
      manager.captureTimeout = Number.MAX_SAFE_INTEGER;
    },
    endCoalesce: () => {
      if (!coalescing) return;
      coalescing = false;
      manager.captureTimeout = 0;
      manager.stopCapturing();
    },
    removeForgettingCreation: (itemId, remove) => {
      manager.stopCapturing();
      const depth = manager.undoStack.length;
      const fresh = isCreationOnly(doc, manager.undoStack[depth - 1], itemId);
      remove();
      manager.stopCapturing();
      // 删除自己是栈上新增的一步；只有恰好多出这一步才弹，远端事务不进栈，
      // 但别的本地来源若插了一步，宁可留着也不误弹。
      if (!fresh || manager.undoStack.length !== depth + 1) return false;
      manager.undoStack.splice(depth - 1, 2);
      for (const notify of watchers) notify();
      return true;
    },
    subscribe: (notify) => {
      watchers.add(notify);
      const events = [
        "stack-item-added",
        "stack-item-popped",
        "stack-cleared",
      ] as const;
      for (const event of events) manager.on(event, notify);
      return () => {
        watchers.delete(notify);
        for (const event of events) manager.off(event, notify);
      };
    },
  };
  setHistoryDelegate(delegate);
  return {
    manager,
    destroy: () => {
      setHistoryDelegate(null);
      manager.destroy();
    },
  };
}
