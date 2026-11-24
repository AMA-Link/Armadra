import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { StatusPill } from "@/ui/status-pill";
import { ChildList } from "./ChildList";
import { BADGE_LANES, phraseLabel, phraseTone } from "./model";
import { useDeliveryBoard } from "./store";

const CHILD_PHRASES: readonly string[] = ["waitingOnChildren", "collecting"];

/**
 * 节点头的交付标记（Armadra#988）：需要你 / 审查中 / 可合并三栏上画；
 * 进行中只在等待子任务、汇总中或有子任务需要你时画，其余已有 Agent 状态胶囊；
 * 终态与没有交付状态的节点不画。有子任务时带计数按钮，弹出子任务列表。
 */
export function DeliveryBadge({ nodeId }: { nodeId: string }) {
  const t = useT();
  const row = useDeliveryBoard((state) => state.rows[nodeId]);
  if (row === undefined) return null;
  const children = row.children;
  const needsYou = children?.needsYou ?? 0;
  const byLane = BADGE_LANES.includes(row.lane);
  const byChildren =
    row.lane === "working" &&
    (CHILD_PHRASES.includes(row.phrase) || needsYou > 0);
  if (!byLane && !byChildren) return null;
  const hint = !byLane && !CHILD_PHRASES.includes(row.phrase);
  return (
    <>
      <StatusPill
        tone={hint ? "attention" : phraseTone(row.phrase)}
        label={
          hint
            ? t("delivery.children.needsYou", { count: needsYou })
            : phraseLabel(t, row.lane, row.phrase, children)
        }
        data-slot="delivery-badge"
        data-lane={row.lane}
        data-phrase={row.phrase}
      />
      {children === null || children === undefined ? null : (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={t("delivery.children.toggle")}
              data-slot="delivery-children-trigger"
            >
              <span data-numeric>
                {children.finished}/{children.total}
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent>
            <ChildList>{children}</ChildList>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}
