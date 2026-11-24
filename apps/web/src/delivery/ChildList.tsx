import { useT } from "@/app/preferences-store";
import { requestCenterOnNode } from "@/canvas/flow/flow-context";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import { StatusPill } from "@/ui/status-pill";
import { phraseLabel, phraseTone, type ChildrenInfo } from "./model";
import { useDeliveryBoard } from "./store";

/** 选中并居中到节点（与分派抽屉同一套）。 */
export function reveal(nodeId: string): void {
  useCanvasStore.getState().selectNodes([nodeId]);
  requestCenterOnNode(nodeId);
}

/** 子任务列表：一行一个子节点，标题按钮居中到节点，右侧是它自己的交付短语。 */
export function ChildList({ children }: { children: ChildrenInfo }) {
  const t = useT();
  const document = useCanvasStore((state) => state.document);
  const rows = useDeliveryBoard((state) => state.rows);
  const titles = new Map<string, string>();
  for (const node of document?.nodes ?? []) titles.set(node.id, node.title);
  return (
    <ul className="flex min-w-0 flex-col gap-1" data-slot="delivery-children">
      {children.nodes.map((child) => {
        const raw = titles.get(child.nodeId);
        const title =
          raw === undefined || raw.trim() === "" ? t("delivery.untitled") : raw;
        const row = rows[child.nodeId];
        return (
          <li
            key={child.nodeId}
            className="flex min-w-0 items-center gap-2"
            data-slot="delivery-child"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto min-w-0 flex-1 justify-start px-1 py-0.5 text-body"
              aria-label={t("delivery.card", { title })}
              onClick={() => reveal(child.nodeId)}
            >
              <span className="truncate">{title}</span>
            </Button>
            {row === undefined ? null : (
              <StatusPill
                tone={phraseTone(row.phrase)}
                label={phraseLabel(t, row.lane, row.phrase, row.children)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
