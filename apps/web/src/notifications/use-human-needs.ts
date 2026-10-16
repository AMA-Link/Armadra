/**
 * 把「需要人处理」的清单算出来并放进 `useNeedsStore`（App 挂一次）。
 *
 * 数据是现成的两份：每个工作空间的会话列表（`GET /sessions`，当前
 * 工作空间再叠上实时状态镜像）和交接记录。别的工作空间没有事件流，所以
 * 轮询；当前工作空间的变化走事件，立刻反映。
 */
import { useCallback, useEffect, useMemo } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type {
  HandoffView,
  SessionSummary,
  WorkspaceSummary,
} from "@armadra/shared";

import { onWorkspaceEvent } from "../api/events";
import { runtimeApi } from "../api/client";
import { mergeSessions, sessionsQuery } from "../agent/sessions";
import { useAgentStatusStore } from "../agent/status-store";
import { useOpenWorkspace } from "../app/workspace-actions";
import { useWorkspacesQuery } from "../app/workspaces-query";
import { gotoNode } from "../sidebar/goto-node";
import { activeSourceId, srcKey } from "../sources/scope";
import { useCanvasStore } from "../store/canvas-store";
import { collectNeeds, groupNeeds } from "./needs";
import { useNeedsStore } from "./needs-store";

/** 别的工作空间的轮询周期。 */
export const NEEDS_POLL_MS = 20_000;
/** 等工作空间和画布到位的上限。 */
const OPEN_TIMEOUT_MS = 10_000;

const pickSessions = (results: readonly { data?: SessionSummary[] }[]) =>
  results.map((result) => result.data);
const pickHandoffs = (results: readonly { data?: HandoffView[] }[]) =>
  results.map((result) => result.data);

export function useHumanNeedsSync(): void {
  const queryClient = useQueryClient();
  const workspaces = useWorkspacesQuery();
  const workspace = useCanvasStore((state) => state.workspace);
  const boards = useCanvasStore((state) => state.boards);
  const boardId = useCanvasStore((state) => state.boardId);
  const statuses = useAgentStatusStore((state) => state.statuses);
  const openWorkspace = useOpenWorkspace();

  const sourceId = activeSourceId();
  // 全部工作空间，不只是打开了标签的：Agent 在 core 里跑，与标签开不开无关。
  const ids = useMemo(() => {
    const all = (workspaces.data ?? []).map((summary) => summary.id);
    return workspace && !all.includes(workspace.id)
      ? [workspace.id, ...all]
      : all;
  }, [workspace, workspaces.data]);

  const sessions = useQueries({
    queries: ids.map((id) => ({
      ...sessionsQuery(id),
      refetchInterval: NEEDS_POLL_MS,
    })),
    combine: pickSessions,
  });

  const handoffs = useQueries({
    queries: ids.map((id) => ({
      queryKey: srcKey(sourceId, "handoffs", "needs", id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        runtimeApi.workspaceHandoffs(id, signal),
      retry: false,
      refetchInterval: NEEDS_POLL_MS,
    })),
    combine: pickHandoffs,
  });

  // 当前工作空间的事件：交接批准时 core 发 `agent.delivery`，立刻重读。
  useEffect(
    () =>
      onWorkspaceEvent("agent.delivery", () => {
        void queryClient.invalidateQueries({
          queryKey: srcKey(sourceId, "handoffs", "needs"),
        });
      }),
    [queryClient, sourceId],
  );

  const layoutWorkspaces = useMemo(
    () =>
      (workspaces.data ?? []).map((summary: WorkspaceSummary) => ({
        id: summary.id,
        name: summary.name,
        boards: (summary.id === workspace?.id ? boards : summary.boards).map(
          (board) => ({ id: board.id, name: board.name }),
        ),
      })),
    [boards, workspace?.id, workspaces.data],
  );

  const result = useMemo(() => {
    const items = collectNeeds(
      ids.map((id, index) => ({
        workspaceId: id,
        rows: mergeSessions(sessions[index] ?? [], statuses),
        handoffs: handoffs[index] ?? [],
      })),
    );
    return {
      items,
      groups: groupNeeds(items, {
        workspaces: layoutWorkspaces,
        currentWorkspaceId: workspace?.id ?? null,
        currentBoardId: boardId,
      }),
    };
  }, [
    boardId,
    handoffs,
    ids,
    layoutWorkspaces,
    sessions,
    statuses,
    workspace?.id,
  ]);

  useEffect(() => {
    useNeedsStore.getState().set(result.items, result.groups);
  }, [result]);

  const open = useCallback(
    (target: { workspaceId: string; boardId: string; nodeId: string }) => {
      const canvas = useCanvasStore.getState();
      if (canvas.workspace?.id === target.workspaceId) {
        gotoNode(target.boardId, target.nodeId);
        return;
      }
      const summary = (workspaces.data ?? []).find(
        (item) => item.id === target.workspaceId,
      );
      if (!summary) return;
      openWorkspace(summary);
      // 工作空间换过去、画布列表到位之后再定位，gotoNode 接着等文档。
      const timer = setTimeout(() => off(), OPEN_TIMEOUT_MS);
      const off = useCanvasStore.subscribe((state) => {
        if (state.workspace?.id !== target.workspaceId) return;
        if (!state.boards.some((board) => board.id === target.boardId)) return;
        // 画布同步先选好它自己的板之后再改选，免得被它盖回去。
        if (state.boardId === null) return;
        clearTimeout(timer);
        off();
        gotoNode(target.boardId, target.nodeId);
      });
    },
    [openWorkspace, workspaces.data],
  );

  useEffect(() => {
    useNeedsStore.getState().setOpen(open);
  }, [open]);
}
