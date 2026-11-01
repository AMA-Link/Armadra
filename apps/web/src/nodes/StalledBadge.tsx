import { scoped } from "../sources/scope";

import { useAgentStatusStore } from "@/agent/status-store";
import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";

/**
 * 进展看门狗在这个节点上的标记（契约 §91）：停滞 / 空等 / 久未处理。
 *
 * 标记随 `agent.status` 帧来，节点有了新的上报就随下一帧消失；没有标记不画
 * 任何东西。只提示：这里没有按钮，处置（重试、追问、上报）是协调者和人的事。
 */
export function StalledBadge({ nodeId }: { nodeId: string }) {
  const t = useT();
  const stalled = useAgentStatusStore(
    (state) => state.statuses[scoped(nodeId)]?.stalled,
  );
  if (stalled === undefined) return null;
  return (
    <Badge
      variant="outline"
      size="sm"
      data-slot="stalled-badge"
      data-stalled={stalled}
    >
      <span className="truncate">{t(`agent.stall.${stalled}`)}</span>
    </Badge>
  );
}
