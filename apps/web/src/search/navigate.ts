/**
 * 搜索结果 → 跳到那里（可能要跨工作空间、跨画布）。
 *
 * 三段，各等各的：
 *
 *  1. 工作空间不是当前的：交给 `openWorkspace`（它切 store、清选中画布），然后
 *     等 `use-board-sync` 把那个工作空间的画布列表取回来。
 *  2. 画布不是当前的：`selectBoard`。这一步要**晚一拍**：`use-board-sync` 在
 *     同一个 effect 里 `setBoards` 之后还会 `selectBoard(记住的或第一块)`，同步
 *     选会被它盖掉。
 *  3. 节点 / 白板对象：交给 `gotoNode` / `gotoItem`，它们等文档到位、再按重试表
 *     居中。
 */
import type { WorkspaceSummary } from "@armadra/shared";

import { gotoItem, gotoNode } from "@/sidebar/goto-node";
import { useCanvasStore } from "@/store/canvas-store";
import type { SearchEntry } from "./index";

/** 等画布列表的上限：超过就放弃，不留着一个永远不触发的订阅。 */
export const BOARDS_TIMEOUT_MS = 10_000;

export interface NavigateDeps {
  /** 已知的工作空间（含画布列表），按 id 找要打开的那个。 */
  workspaces: readonly WorkspaceSummary[];
  /** `useOpenWorkspace()` 给的函数：切到这个工作空间。 */
  openWorkspace: (workspace: WorkspaceSummary) => void;
}

/** 切到 `workspaceId` 的 `boardId`，完成后调 `done`。找不到工作空间就什么也不做。 */
function ensureBoard(
  workspaceId: string,
  boardId: string,
  deps: NavigateDeps,
  done: () => void,
): void {
  const state = useCanvasStore.getState();
  if (state.workspace?.id === workspaceId) {
    if (state.boardId !== boardId) state.selectBoard(boardId);
    done();
    return;
  }
  const summary = deps.workspaces.find((item) => item.id === workspaceId);
  if (!summary) return;
  deps.openWorkspace(summary);

  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    unsubscribe?.();
    unsubscribe = null;
  };
  const timeout = setTimeout(stop, BOARDS_TIMEOUT_MS);
  unsubscribe = useCanvasStore.subscribe((next) => {
    if (next.workspace?.id !== workspaceId) return;
    if (!next.boards.some((board) => board.id === boardId)) return;
    clearTimeout(timeout);
    stop();
    // 晚一拍：让 `use-board-sync` 那个 effect 先把它自己的 `selectBoard` 做完。
    timer = setTimeout(() => {
      const current = useCanvasStore.getState();
      if (current.workspace?.id !== workspaceId) return;
      if (current.boardId !== boardId) current.selectBoard(boardId);
      done();
    }, 0);
  });
}

/** 跳到一个搜索条目：工作空间 / 画布 / 节点 / 白板对象。 */
export function navigateTo(entry: SearchEntry, deps: NavigateDeps): void {
  if (entry.kind === "workspace") {
    const state = useCanvasStore.getState();
    if (state.workspace?.id === entry.workspaceId) return;
    const summary = deps.workspaces.find(
      (item) => item.id === entry.workspaceId,
    );
    if (summary) deps.openWorkspace(summary);
    return;
  }
  ensureBoard(entry.workspaceId, entry.boardId, deps, () => {
    if (entry.kind === "node" && entry.targetId)
      gotoNode(entry.boardId, entry.targetId);
    else if (entry.kind === "item" && entry.targetId)
      gotoItem(entry.boardId, entry.targetId);
  });
}
