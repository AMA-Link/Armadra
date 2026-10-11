import type { TerminalSurfaceHandle } from "@/terminal/TerminalSurface";

/**
 * 活着的终端节点句柄，按节点 id 索引。
 *
 * 右键菜单、命令面板、以及 Phase 3 的画布控制 API 都需要"对某个终端做点
 * 什么"，但它们拿不到组件的 ref。这里是唯一的中转，卸载时必须注销——
 * 留着一个死句柄会让菜单项静默无效。
 */
const handles = new Map<string, TerminalSurfaceHandle>();

export function registerTerminalHandle(
  nodeId: string,
  handle: TerminalSurfaceHandle,
): () => void {
  handles.set(nodeId, handle);
  return () => {
    if (handles.get(nodeId) === handle) handles.delete(nodeId);
  };
}

export function terminalHandle(
  nodeId: string,
): TerminalSurfaceHandle | undefined {
  return handles.get(nodeId);
}

/**
 * 终端节点在根元素上标这个属性，值是节点 id：键盘事件只有一个 `target`，
 * 从它问出「我在哪个终端节点里」靠的就是它。
 */
export const TERMINAL_NODE_ATTRIBUTE = "data-terminal-node";

/** 焦点（或事件目标）所在的终端节点；不在终端里是 `null`。 */
export function terminalNodeOf(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target : null;
  if (!element?.closest(".xterm")) return null;
  return (
    element
      .closest(`[${TERMINAL_NODE_ATTRIBUTE}]`)
      ?.getAttribute(TERMINAL_NODE_ATTRIBUTE) ?? null
  );
}

/**
 * 打开节点头部搜索框的入口。`terminal.search` 这条命令以前没有任何实现：
 * 全局监听器截下 ⌘F 之后派给一个不存在的画布命令，按了没反应。
 */
const finders = new Map<string, () => void>();

export function registerTerminalFind(
  nodeId: string,
  open: () => void,
): () => void {
  finders.set(nodeId, open);
  return () => {
    if (finders.get(nodeId) === open) finders.delete(nodeId);
  };
}

/** 打开这个终端节点的搜索框；没有这样的节点时返回 `false`。 */
export function openTerminalFind(nodeId: string | null | undefined): boolean {
  const open = nodeId ? finders.get(nodeId) : undefined;
  if (!open) return false;
  open();
  return true;
}
