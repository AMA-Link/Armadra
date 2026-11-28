import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { EmptyState } from "@/ui/state";
import { flatten } from "./model";
import { SessionList } from "./SessionList";
import { useSessionPage } from "./store";
import { useWorkspaceAgentSessions } from "./use-agent-sessions";

/**
 * 侧栏里的会话列表（#1084 第二步）：侧栏停靠时会话模式的导航就是它，会话页
 * 只剩详情。数据与会话页同一组查询（按键去重，不多发请求）；「新建会话」打开
 * 会话页里的那个对话框。
 */
export default function SessionSidebar() {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const { tree, loading } = useWorkspaceAgentSessions(workspaceId);
  const selectedNodeId = useSessionPage((state) => state.selectedNodeId);
  const select = useSessionPage((state) => state.select);
  const setCreating = useSessionPage((state) => state.setCreating);

  return (
    <SessionList
      tree={tree}
      count={flatten(tree).length}
      selectedNodeId={selectedNodeId}
      onSelect={select}
      onNew={() => setCreating(true)}
      empty={
        loading ? null : (
          <EmptyState
            inline
            title={t("sessionPage.emptyList")}
            className="py-4"
          />
        )
      }
    />
  );
}
