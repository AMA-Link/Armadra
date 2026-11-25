import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SquarePen } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { runtimeApi } from "@/api/client";
import { sk } from "@/sources/scope";
import { useCanvasStore } from "@/store/canvas-store";
import { useNewBoard } from "@/sidebar/use-board-mutations";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/state";

/**
 * 当前工作空间确实没有画布（#1015：最后一块也能删）。
 *
 * 只读 `useBoardSync` 那份画布列表的缓存（`enabled: false`，不自己发请求），
 * 并且只取「是不是空的」这一个布尔量：列表每次刷新不会叫醒订阅者。列表还没到
 * 时答 `false`，加载中照常是骨架。
 */
export function useNoBoards(): boolean {
  const workspace = useCanvasStore((state) => state.workspace);
  const boardId = useCanvasStore((state) => state.boardId);
  const empty = useQuery({
    queryKey: sk("boards", workspace?.id),
    queryFn: () => runtimeApi.listBoards(workspace!.id),
    enabled: false,
    select: (rows) => rows.length === 0,
  });
  return Boolean(workspace) && boardId === null && empty.data === true;
}

/** 没有画布时画布区正中的空状态：一句名词标题加「新建画布」。 */
export function NoBoards() {
  const t = useT();
  const none = useNoBoards();
  const newBoard = useNewBoard();
  if (!none) return null;
  return (
    <div
      data-slot="no-boards"
      className="pointer-events-none absolute inset-0 z-[var(--z-pills)] grid place-items-center"
    >
      <EmptyState
        title={t("noBoards.title")}
        className="pointer-events-auto w-auto min-w-64 flex-none border-solid border-border-strong bg-panel/90 shadow-overlay backdrop-blur-[12px]"
      >
        <Button disabled={newBoard.disabled} onClick={newBoard.run}>
          <SquarePen data-icon="inline-start" />
          {t("sidebar.newBoard")}
        </Button>
      </EmptyState>
    </div>
  );
}

/** 只在有画布时渲染（Dock 往画布里加东西，没有画布时没有落点）。 */
export function BoardOnly({ children }: { children: ReactNode }) {
  return useNoBoards() ? null : children;
}
