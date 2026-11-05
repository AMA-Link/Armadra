import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import { memberCount } from "./model";
import { useItemStages } from "./stage";
import { openDispatchDrawer } from "./store";

/**
 * 协调者（ama）节点头部的「N 成员」（设计系统 §5.4）：点开右侧分派抽屉。只给
 * ama 节点画；0 个成员也画——抽屉的空态就是「让 ama 组织一次分工」。协调者经
 * `canvas notify` 说了还没读的话时，旁边多一个点（契约 §101）。
 */
export function MembersChip({ nodeId }: { nodeId: string }) {
  const t = useT();
  const count = useCanvasStore((state) =>
    state.document
      ? memberCount(nodeId, state.document.nodes, state.document.edges)
      : 0,
  );
  const unread = useItemStages(
    (state) => (state.unreadReplies[nodeId] ?? 0) > 0,
  );
  return (
    <Badge asChild variant="secondary" size="sm">
      <Button
        variant="secondary"
        size="xs"
        type="button"
        data-slot="coordinator-members-chip"
        data-no-drag="true"
        aria-haspopup="dialog"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          openDispatchDrawer(nodeId);
        }}
      >
        {t("coordinator.members", { count })}
        {unread ? (
          <>
            <ColorDot
              color="var(--status-attention)"
              size={6}
              data-slot="coordinator-reply-dot"
            />
            <span className="sr-only">{t("coordinator.reply.unread")}</span>
          </>
        ) : null}
      </Button>
    </Badge>
  );
}
