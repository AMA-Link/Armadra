/**
 * 画布的增删（§26 →§28）。
 *
 * 真相仍然在 Runtime：改完就让 `["boards", id]` 与 `["workspaces"]` 失效，
 * `use-board-sync` 订阅同一把 key，会把新列表灌回 store，侧栏不维护第二份。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/ui/toast";

import type { Board, WorkspaceSummary } from "@armadra/shared";
import { useCanvasStore } from "../store/canvas-store";
import { runtimeApi } from "../api/client";
import { sk } from "../sources/scope";
import { useT } from "../app/preferences-store";
import { nextBoardName } from "./board-tree";

export function useBoardMutations(workspaceId: string) {
  const queryClient = useQueryClient();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: sk("boards", workspaceId) });
    void queryClient.invalidateQueries({ queryKey: sk("workspaces") });
  };

  const create = useMutation({
    mutationFn: (name: string) => runtimeApi.createBoard(workspaceId, name),
    onSuccess: refresh,
    onError: (cause: Error) => toast.error(cause.message),
  });

  /**
   * 删哪块都行，最后一块也一样（#1015）。删的是当前画布就先切到同一工作空间的
   * 下一块，免得画布对着一个不存在的 id；没有下一块就留空，画布区显示空状态。
   */
  const remove = useMutation({
    mutationFn: (id: string) => runtimeApi.deleteBoard(workspaceId, id),
    onSuccess: (_, id) => {
      const state = useCanvasStore.getState();
      if (state.workspace?.id === workspaceId && state.boardId === id) {
        const next = state.boards.find((board) => board.id !== id);
        state.selectBoard(next?.id ?? null);
      }
      refresh();
    },
    onError: (cause: Error) => toast.error(cause.message),
  });

  const rename = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: sk("boards", workspaceId) }),
        queryClient.cancelQueries({ queryKey: sk("workspaces") }),
      ]);
      return runtimeApi.updateBoard(workspaceId, id, { name });
    },
    onSuccess: (board) => {
      queryClient.setQueryData<Board[]>(sk("boards", workspaceId), (rows) =>
        rows?.map((row) => (row.id === board.id ? board : row)),
      );
      queryClient.setQueryData<WorkspaceSummary[]>(sk("workspaces"), (rows) =>
        rows?.map((row) =>
          row.id === workspaceId
            ? {
                ...row,
                boards: row.boards.map((item) =>
                  item.id === board.id ? { ...item, name: board.name } : item,
                ),
              }
            : row,
        ),
      );
      const state = useCanvasStore.getState();
      if (state.workspace?.id !== workspaceId) return;
      state.setBoards(
        state.boards.map((item) =>
          item.id === board.id ? { ...item, name: board.name } : item,
        ),
      );
      // Name edits do not change the document CAS timestamp or discard unsaved shapes.
      if (state.document?.board.id === board.id)
        useCanvasStore.setState({
          document: {
            ...state.document,
            board: { ...state.document.board, name: board.name },
          },
        });
    },
  });

  return { create, remove, rename, refresh };
}

/**
 * 「新建画布」：按当前语言取下一个默认名，建好就切过去。侧栏那一行与没有画布时
 * 的空状态共用。
 */
export function useNewBoard() {
  const t = useT();
  const workspace = useCanvasStore((state) => state.workspace);
  const { create } = useBoardMutations(workspace?.id ?? "");

  const run = () => {
    if (!workspace || create.isPending) return;
    const state = useCanvasStore.getState();
    const name = nextBoardName(state.boards, (index) =>
      t("sidebar.boardDefaultName", { index }),
    );
    create.mutate(name, {
      onSuccess: (board) => useCanvasStore.getState().selectBoard(board.id),
    });
  };

  return { run, disabled: !workspace || create.isPending };
}
