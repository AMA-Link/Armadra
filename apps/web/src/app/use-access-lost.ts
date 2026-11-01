import { useEffect } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@armadra/shared";
import { create } from "zustand";
import { toast } from "@/ui/toast";

import { clientFor } from "../api/client";
import { onWorkspaceAccessLost } from "../api/events";
import { workspacesApiFor } from "../api/workspaces";
import { sourceRegistry } from "../sources/registry";
import { idsInSource } from "./preferences/sources";
import { onGrantSynced } from "../sources/grant-synced";
import { activeSourceId, srcKey } from "../sources/scope";
import { useCanvasStore } from "../store/canvas-store";
import {
  rememberBoard,
  rememberWorkspace,
  t,
  usePreferencesStore,
} from "./preferences-store";

/**
 * 失去当前工作空间之后，那个源里一个能看的都不剩：主区画一句空态（`NoWorkspaceAccess`），
 * 不再是一块什么都没有的空白。打开任何一个工作空间就收起。
 */
export const useWorkspaceAccessEmpty = create<{ empty: boolean }>(() => ({
  empty: false,
}));

/**
 * 这块工作空间的读授权被收回了（服务器壳上撤销共享、停用账号、控制台改了授予
 * 的工作空间范围）：core 以 `forbidden` 结束这块的订阅，或以 4403 关掉事件流
 * （`api/events.ts`）。被删除或归档了（契约 §89）同样处理，订阅以 `not_found`
 * 结束，提示换成「已不可用」。
 *
 * 留在原处的话，侧栏会一直把它当「当前工作空间」列着，画布停在一份再也读
 * 不到、存不进的旧文档上，之后的每个请求都是 403 却没人说为什么。所以离开它，
 * 并用一句话说明；再重取这个源的工作空间列表，切到还看得见的第一个（先按侧栏
 * 里已打开的顺序，再按列表顺序）。一个都不剩时主区给空态（#632：此前只是清掉
 * 当前工作空间，主区一直空白；侧栏的树只列「已打开」与当前那块，范围收窄到一块
 * 没打开过的工作空间时连侧栏也是空的）。
 *
 * 放宽范围不结束任何订阅：授予同步完（`sources/grant-synced.ts`）时让当前源的列表
 * 重取，新放开的工作空间不必刷新就出现。
 */
export function useWorkspaceAccessLost(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const offLost = onWorkspaceAccessLost((lost, from, reason) => {
      // 删除或归档了的（契约 §89）连标签也不留：再点开也只是 `not_found`。
      if (reason === "gone")
        usePreferencesStore.getState().closeWorkspaceTab(lost, from);
      const state = useCanvasStore.getState();
      if (state.workspace?.id !== lost || state.sourceId !== from) return;
      const name = state.workspace.name;
      state.setWorkspace(null);
      toast.info(
        t(reason === "gone" ? "sharing.unavailable" : "sharing.revoked", {
          name,
        }),
      );
      void fallBack(queryClient, lost, from);
    });
    // 打开了任何工作空间（回落、或用户自己点开）就不再是「一个都不剩」。
    const offOpen = useCanvasStore.subscribe((state) => {
      if (state.workspace !== null && useWorkspaceAccessEmpty.getState().empty)
        useWorkspaceAccessEmpty.setState({ empty: false });
    });
    // 授予同步完（放宽也一样）：当前源的列表重取，新放开的工作空间直接出现在
    // 侧栏里；只重取，不自动打开。
    const offSynced = onGrantSynced(() => {
      void queryClient.invalidateQueries({
        queryKey: srcKey(activeSourceId(), "workspaces"),
      });
    });
    return () => {
      offLost();
      offOpen();
      offSynced();
    };
  }, [queryClient]);
}

/** 重取 `sourceId` 的工作空间列表（与侧栏同一个查询键），打开还看得见的第一个。 */
async function fallBack(
  queryClient: QueryClient,
  lost: string,
  sourceId: string,
): Promise<void> {
  const connection = sourceRegistry().get(sourceId);
  let list: readonly WorkspaceSummary[] = [];
  if (connection !== undefined) {
    try {
      list = await queryClient.fetchQuery({
        queryKey: srcKey(sourceId, "workspaces"),
        queryFn: () =>
          workspacesApiFor(() => clientFor(connection.source)).listWorkspaces(),
        staleTime: 0,
      });
    } catch {
      list = [];
    }
  }
  // 等列表的工夫里用户自己打开了别的：不替他换。
  if (useCanvasStore.getState().workspace !== null) return;
  // 列表可能还是授予同步之前那一份：收走的那块无论如何不再回去。
  const visible = list.filter((item) => item.id !== lost);
  const opened = idsInSource(
    usePreferencesStore.getState().openWorkspaceKeys,
    sourceId,
  );
  const next =
    opened
      .map((id) => visible.find((item) => item.id === id))
      .find((item): item is WorkspaceSummary => item !== undefined) ??
    visible[0];
  if (next === undefined) {
    rememberWorkspace(null);
    useWorkspaceAccessEmpty.setState({ empty: true });
    return;
  }
  rememberWorkspace(next.id, sourceId);
  rememberBoard(null);
  usePreferencesStore.getState().openWorkspaceTab(next.id, sourceId);
  useCanvasStore.getState().setWorkspace(next, sourceId);
  if (connection !== undefined)
    void workspacesApiFor(() => clientFor(connection.source))
      .openWorkspace(next.id)
      .catch(() => undefined);
}
