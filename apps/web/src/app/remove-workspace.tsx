/**
 * 工作空间的删除、归档与恢复——侧栏工作空间行与设置「归档」页共用（契约 §89）。
 *
 * 两样都一步完成，不弹确认框：删除的是记录不是项目，磁盘上的目录一个字节都
 * 不动；归档可以撤销，所以只在归档之后弹一条带「撤销」的提示（设计系统：可撤销
 * 的动作才弹）。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/ui/toast";

import { runtimeApi } from "../api/client";
import { sk } from "../sources/scope";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferencesStore, useT } from "./preferences-store";
import { useCloseWorkspace, useOpenWorkspace } from "./workspace-actions";

/** 归档列表的查询键（设置「归档」页）。 */
export const ARCHIVED_WORKSPACES_KEY = "archived-workspaces";

function useInvalidateLists() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: sk("workspaces") });
    void queryClient.invalidateQueries({
      queryKey: sk(ARCHIVED_WORKSPACES_KEY),
    });
  };
}

/**
 * 删除 + 收尾：先把 tab 关掉（`useCloseWorkspace` 要读缓存里的工作空间列表
 * 来决定切到哪个，所以必须在 invalidate 之前；也在请求之前，免得 core 结束这块
 * 的订阅时页面把它当成「别人删掉了」），再让列表失效。
 */
export function useRemoveWorkspace() {
  const closeWorkspace = useCloseWorkspace();
  const invalidate = useInvalidateLists();

  return useMutation({
    mutationFn: (workspaceId: string) =>
      runtimeApi.deleteWorkspace(workspaceId),
    onMutate: (workspaceId) => closeWorkspace(workspaceId),
    onSettled: invalidate,
    onError: (cause: Error) => toast.error(cause.message),
  });
}

/**
 * 恢复：侧栏只列打开着的工作空间，所以恢复的同时把它的标签放回去；`open`
 * （撤销刚才的归档、它原本就开着）时直接切回它。
 */
export function useRestoreWorkspace() {
  const invalidate = useInvalidateLists();
  const openWorkspace = useOpenWorkspace();
  const openWorkspaceTab = usePreferencesStore(
    (state) => state.openWorkspaceTab,
  );
  return useMutation({
    mutationFn: (input: { id: string; open?: boolean }) =>
      runtimeApi.restoreWorkspace(input.id),
    onSuccess: (workspace, input) => {
      if (input.open === true) openWorkspace(workspace);
      else openWorkspaceTab(workspace.id);
    },
    onSettled: invalidate,
    onError: (cause: Error) => toast.error(cause.message),
  });
}

/** 归档：关掉、收起，提示里给「撤销」（就是恢复）。 */
export function useArchiveWorkspace() {
  const t = useT();
  const closeWorkspace = useCloseWorkspace();
  const invalidate = useInvalidateLists();
  const restore = useRestoreWorkspace();

  return useMutation({
    mutationFn: (workspace: { id: string; name: string }) =>
      runtimeApi.archiveWorkspace(workspace.id),
    // 关之前记下它是不是当前那块：撤销时原样切回去。
    onMutate: (workspace) => {
      const current = useCanvasStore.getState().workspace?.id === workspace.id;
      closeWorkspace(workspace.id);
      return { current };
    },
    onSuccess: (_result, workspace, context) => {
      toast.success(t("launcher.archived", { name: workspace.name }), {
        action: {
          label: t("launcher.undo"),
          onClick: () =>
            restore.mutate({ id: workspace.id, open: context?.current }),
        },
      });
    },
    onSettled: invalidate,
    onError: (cause: Error) => toast.error(cause.message),
  });
}
