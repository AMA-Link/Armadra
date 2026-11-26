import type { CanvasNode } from "@armadra/shared";

/**
 * 不在当前画布文档里的节点的写回（Armadra#1071）。
 *
 * `SessionView` 的写回（会话 id、模式 / 模型、自动标题）走 `canvas-store`，只
 * 认当前打开的那块板。会话页上的会话多半在会话板或别的画板上：那时写回是
 * 空操作，刷新就丢。会话页挂着时登记一个写者，它知道每个会话在哪块板上，按
 * 「读板 → 改这个节点 → 按版本号存」写回去。
 *
 * 没登记写者、或写者不认识这个节点，答 `false`，调用方照旧什么都不做。
 */

export type NodeMutation = (node: CanvasNode) => CanvasNode | null;

export type OffCanvasWriter = (nodeId: string, mutate: NodeMutation) => boolean;

let writer: OffCanvasWriter | undefined;

/** 登记（`undefined` 撤销）写者，返回撤销函数。 */
export function setOffCanvasWriter(
  next: OffCanvasWriter | undefined,
): () => void {
  writer = next;
  return () => {
    if (writer === next) writer = undefined;
  };
}

/**
 * 把 `mutate` 应用到一个不在当前文档里的节点；`mutate` 答 `null` 表示不改。
 * 答这一次是否交给了写者（写是异步的，失败只记日志）。
 */
export function writeOffCanvas(nodeId: string, mutate: NodeMutation): boolean {
  return writer?.(nodeId, mutate) ?? false;
}
