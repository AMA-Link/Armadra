import { t } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { toast } from "@/ui/toast";
import { requestNodeNames } from "@/nodes/node-names";
import { MAX_LINKS } from "../../content-links";
import { createContentReference } from "../../create-content-reference";
import { classifyConnection, connectionRejection } from "./connect";

/**
 * 一次连线手势落定后的动作（两种引擎共用）：按判定表建一条边或一条内容引用，
 * 或者在「落到了某个节点上却被拒绝」时提示一次。
 *
 * 旧引擎由 React Flow 的 `onConnect` / `onConnectEnd` 调用，新引擎由
 * `connect` 事件调用；判定表（`connect.ts`）与动作都只此一份。
 */

/**
 * 松手且合法：节点 ↔ 节点是 `edges` 表的一行；有一端是白板对象时是
 * `whiteboard.references` 的一行。返回是否建成。
 *
 * 引用的重复提示不弹（`notify: false`）：拖线时落点高亮已经说过。
 */
export function commitConnection(source: string, target: string): boolean {
  const state = useCanvasStore.getState();
  const verdict = classifyConnection(
    { source, target },
    { document: state.document, whiteboard: state.whiteboard },
  );
  if (verdict.kind === "reference") {
    createContentReference(verdict.itemId, verdict.nodeId, { notify: false });
    return true;
  }
  if (verdict.kind !== "link") return false;
  const edgeId = state.addEdge(verdict.source, verdict.target);
  if (edgeId === null) return false;
  // 一条边建立的那一刻，两端才第一次需要互相称呼（设计 §2.2）。
  requestNodeNames([verdict.source, verdict.target], { edgeId });
  return true;
}

/** 落到了节点上却被拒绝：提示一次（拖到空白处是取消，不提示）。 */
export function rejectConnection(source: string, target: string): void {
  const state = useCanvasStore.getState();
  const verdict = classifyConnection(
    { source, target },
    { document: state.document, whiteboard: state.whiteboard },
  );
  const message = connectionRejection(verdict);
  if (message) toast.error(t(message, { limit: MAX_LINKS }));
}
