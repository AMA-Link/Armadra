import { PanelBottom } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { LogPage } from "@/panels/git/log/LogPage";
import { useCanvasStore } from "@/store/canvas-store";
import { IconButton } from "@/ui/icon-button";
import { EmptyState } from "@/ui/state";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";

/**
 * 画布上的 Git 节点（#927 B4）：内容就是侧边栏那个历史组件，同一份代码、同一套
 * 偏好。节点只记自己是什么，提交、差异与文件每次都从仓库现读。
 *
 * 头部一个按钮「停靠到侧边栏」：节点收走、底部窗口打开——两处是同一个视图的
 * 两种摆法，不是两样东西，所以不同时留着两份。
 */
export function GitNode({ node, selected }: NodeBodyProps) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const removeNodes = useCanvasStore((state) => state.removeNodes);
  const setPanel = useCanvasStore((state) => state.setPanel);

  return (
    <NodeShell
      node={node}
      selected={selected}
      headerActions={
        <IconButton
          label={t("gitLog.dock.panel")}
          onClick={() => {
            removeNodes([node.id]);
            setPanel("scm", "bottom");
          }}
        >
          <PanelBottom />
        </IconButton>
      }
    >
      <div
        data-slot="git-node"
        className="flex h-full min-h-0 min-w-0 flex-col"
      >
        {workspaceId ? (
          <LogPage key={workspaceId} workspaceId={workspaceId} />
        ) : (
          <EmptyState inline title={t("gitLog.dock.noWorkspace")} />
        )}
      </div>
    </NodeShell>
  );
}
