import { SquareTerminal } from "lucide-react";

import { agentLabel, agentMark } from "@/agent/launch";
import { useT } from "@/app/preferences-store";
import { AgentAvatar } from "@/ui/agent-avatar";

/**
 * 终端节点头最左边的类型标记（Armadra#969）：这是哪种 Agent。
 *
 * 标题从新建起就是预设名（`Atlas`），之后还会被自动命名改写，所以类型不能
 * 靠标题说。Agent 画一枚 20px 的头像：标识色实底（与小地图上独立 Agent 的
 * 标识色同源，`canvas/family.ts`）+ 两字符类型标记；普通终端与 SSH 终端画终端
 * 图标。悬停给全名。
 */
export function NodeTypeMark({ agentId }: { agentId: string | undefined }) {
  const t = useT();
  if (agentId) {
    return (
      <AgentAvatar
        agentId={agentId}
        size={20}
        text={agentMark(agentId)}
        data-slot="node-type-mark"
        aria-label={agentLabel(agentId)}
        className="shrink-0"
      />
    );
  }
  const label = t("node.terminal");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-slot="node-type-mark"
      className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
    >
      <SquareTerminal className="size-4" aria-hidden />
    </span>
  );
}
