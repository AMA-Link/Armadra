import { useT } from "@/app/preferences-store";
import { StatusPill } from "@/ui/status-pill";
import { BADGE_LANES, phraseKey, phraseTone } from "./model";
import { useDeliveryBoard } from "./store";

/**
 * 节点头的交付标记（Armadra#988）：只在需要你 / 审查中 / 可合并三栏上画；
 * 进行中节点头已经有 Agent 状态胶囊，终态与没有交付状态的节点不画。
 */
export function DeliveryBadge({ nodeId }: { nodeId: string }) {
  const t = useT();
  const row = useDeliveryBoard((state) => state.rows[nodeId]);
  if (row === undefined || !BADGE_LANES.includes(row.lane)) return null;
  return (
    <StatusPill
      tone={phraseTone(row.phrase)}
      label={t(phraseKey(row.lane, row.phrase))}
      data-slot="delivery-badge"
      data-lane={row.lane}
      data-phrase={row.phrase}
    />
  );
}
