import type { StatusLineModel } from "@/agent/display";
import { useAgentTree } from "@/agent/use-agent-tree";
import type { NodeShellProps } from "./NodeShell";
import { AgentTree } from "@/ui/agent-tree";
import { StatusLine } from "@/ui/status-pill";

/**
 * 节点头状态段的弹层内容（设计系统 §11.1）：`StatusLine`（阶段 · 细节 · 计时）+
 * 有下级 / 子代理卡片时的 `AgentTree md`。`NodeShell` 的 `statusPopover` 槽位接它。
 *
 * `line` 是节点头自己的 `SessionDisplay` 翻出来的一行；头部显示的是退出、掉线、休眠这类
 * 终端自己的状态时没有 `line`，退回头部的 `status`（同一个 tone 与文案）。
 */
export function NodeStatusPopover({
  nodeId,
  status,
  line,
}: {
  nodeId: string;
  status: NonNullable<NodeShellProps["status"]>;
  line?: StatusLineModel | undefined;
}) {
  const tree = useAgentTree(nodeId);
  return (
    <div
      data-slot="node-status-popover"
      className="flex min-w-0 flex-col gap-2"
    >
      {line ? (
        <StatusLine
          tone={line.tone}
          label={line.phaseLabel}
          detail={line.detail}
          since={line.since}
          spinning={line.spinning}
        />
      ) : (
        <StatusLine tone={status.tone} label={status.label} />
      )}
      {tree ? <AgentTree tree={tree} size="md" /> : null}
    </div>
  );
}
