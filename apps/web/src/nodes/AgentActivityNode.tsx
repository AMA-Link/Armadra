import { displayOfStatus, lineOf } from "@/agent/display";
import { useAgentStatus } from "@/agent/status-store";
import { useAgentTree } from "@/agent/use-agent-tree";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { AgentTree } from "@/ui/agent-tree";
import { EmptyState } from "@/ui/state";
import { StatusLine } from "@/ui/status-pill";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";

/**
 * 原生活动观察卡片（自动化设计 §3）。
 *
 * 只读、只展示状态：来源节点名、它当前的阶段（`StatusLine`）、有下级时的缩略树
 * （`AgentTree md`）。数据来自已有的 Hook 事件（agent status 与 subagent 事件）与画布
 * 上的 `supervises` 边，不暂停、不取消、不触发任何执行——隐藏它不会动 CLI 自己的
 * 循环；也不转换成平台计划，免得同一个任务被双重触发。
 */
export function AgentActivityNode({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  const data = node.data.kind === "agentActivity" ? node.data : null;
  const sourceId = data?.sourceNodeId ?? "";
  const source = useCanvasStore((state) =>
    state.document?.nodes.find((candidate) => candidate.id === sourceId),
  );
  const status = useAgentStatus(sourceId);
  const tree = useAgentTree(source ? sourceId : null);
  const display = displayOfStatus(status);
  const line = lineOf(display, status?.activity, t);

  return (
    <NodeShell
      node={node}
      selected={selected}
      {...(display.busy ? { glow: "working" as const } : {})}
    >
      <div
        data-slot="agent-activity-card"
        data-node-id={id}
        className="flex min-w-0 flex-col gap-2 px-3 py-2"
      >
        {!source ? (
          <EmptyState inline title={t("activity.missingSource")} />
        ) : (
          <>
            <span className="block min-w-0 truncate text-body font-medium">
              {source.title}
            </span>
            <StatusLine
              tone={line.tone}
              label={line.phaseLabel}
              detail={line.detail}
              since={line.since}
              spinning={line.spinning}
            />
            {tree ? <AgentTree tree={tree} size="md" /> : null}
          </>
        )}
      </div>
    </NodeShell>
  );
}
