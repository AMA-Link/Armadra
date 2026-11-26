import * as React from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BoardDocument } from "@armadra/shared";

import { useSessions } from "@/agent/sessions";
import { runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";
import { useT } from "@/app/preferences-store";
import { sk } from "@/sources/scope";
import {
  buildSessionItems,
  buildSessionTree,
  type AgentSessionItem,
  type AgentSessionNode,
  type BoardSource,
} from "./model";
import { useSessionPage } from "./store";

export interface WorkspaceAgentSessions {
  readonly items: readonly AgentSessionItem[];
  readonly tree: readonly AgentSessionNode[];
  readonly loading: boolean;
  readonly refresh: () => void;
}

const prefix = (workspaceId: string | null) =>
  sk("session-page", workspaceId) as unknown[];

/**
 * 工作空间里的全部 Agent 会话：每块画布加上会话板的文档里带 Agent 的终端节点，
 * 合并会话行的状态，按 `supervises` 边排成上下级树。某块板变了（`board.changed`）
 * 只重取那一块。
 */
export function useWorkspaceAgentSessions(
  workspaceId: string | null,
): WorkspaceAgentSessions {
  const t = useT();
  const client = useQueryClient();
  const enabled = workspaceId !== null;

  const boards = useQuery({
    queryKey: sk("boards", workspaceId),
    queryFn: () => runtimeApi.listBoards(workspaceId!),
    enabled,
  });
  const sessionBoard = useQuery({
    queryKey: [...prefix(workspaceId), "session-board"],
    queryFn: () => runtimeApi.sessionBoard(workspaceId!),
    enabled,
  });
  const sessionBoardId = sessionBoard.data?.boardId ?? null;

  const sources = React.useMemo(() => {
    const list = (boards.data ?? []).map((board) => ({
      boardId: board.id,
      name: board.name,
      onSessionBoard: false,
    }));
    if (
      sessionBoardId !== null &&
      !list.some((b) => b.boardId === sessionBoardId)
    )
      list.push({ boardId: sessionBoardId, name: "", onSessionBoard: true });
    return list;
  }, [boards.data, sessionBoardId]);

  const documents = useQueries({
    queries: sources.map((board) => ({
      queryKey: [...prefix(workspaceId), "board", board.boardId],
      queryFn: () => runtimeApi.loadBoard(workspaceId!, board.boardId),
      enabled,
    })),
    combine: (results) => ({
      data: results.map((result) => result.data),
      pending: results.some((result) => result.isPending),
    }),
  });

  const known = React.useRef<ReadonlySet<string>>(new Set());
  known.current = new Set(sources.map((board) => board.boardId));
  React.useEffect(() => {
    if (workspaceId === null) return;
    return onWorkspaceEvent("board.changed", (event) => {
      if (!known.current.has(event.boardId)) {
        // 新板（第一次起会话时才建的会话板）：重取列表与会话板 id。
        void client.invalidateQueries({ queryKey: sk("boards", workspaceId) });
        void client.invalidateQueries({
          queryKey: [...prefix(workspaceId), "session-board"],
        });
        return;
      }
      const key = [...prefix(workspaceId), "board", event.boardId];
      const cached = client.getQueryData<BoardDocument>(key);
      // 自己刚存的那一次带着同一个版本号：重取只会拿回同一份。
      if (cached?.board.updatedAt === event.updatedAt) return;
      void client.invalidateQueries({ queryKey: key });
    });
  }, [client, workspaceId]);

  const { sessions } = useSessions(workspaceId);
  const starting = useSessionPage((state) => state.starting);
  const sessionsLabel = t("sessionPage.board");

  const items = React.useMemo(() => {
    const merged: BoardSource[] = sources.map((board, index) => ({
      ...board,
      document: documents.data[index],
    }));
    return buildSessionItems(merged, sessions, starting, sessionsLabel);
  }, [sources, documents.data, sessions, starting, sessionsLabel]);
  const tree = React.useMemo(() => buildSessionTree(items), [items]);

  const refresh = React.useCallback(() => {
    void client.invalidateQueries({ queryKey: prefix(workspaceId) });
    void client.invalidateQueries({ queryKey: sk("boards", workspaceId) });
  }, [client, workspaceId]);

  return {
    items,
    tree,
    loading:
      enabled &&
      (boards.isPending ||
        sessionBoard.isPending ||
        (sources.length > 0 && documents.pending)),
    refresh,
  };
}
