import * as React from "react";
import { ChevronRight, X } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { requestCenterOnNode } from "@/canvas/flow/flow-context";
import { WorkPanelSheet } from "@/panels/WorkPanelSheet";
import { useCompactLayout } from "@/platform/layout";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { EmptyState } from "@/ui/state";
import { SheetTitle } from "@/ui/sheet";
import { StatusPill } from "@/ui/status-pill";
import {
  BOARD_LANES,
  buildBoard,
  laneKey,
  phraseKey,
  phraseTone,
  type BoardCard,
} from "./model";
import { useDeliveryBoard } from "./store";

function close(): void {
  useCanvasStore.getState().setPanel("delivery", "closed");
}

/** 选中并居中到节点（与分派抽屉同一套）。 */
function reveal(nodeId: string): void {
  useCanvasStore.getState().selectNodes([nodeId]);
  requestCenterOnNode(nodeId);
}

function PullLinks({ card }: { card: BoardCard }) {
  const t = useT();
  if (card.pulls.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-2" data-slot="delivery-pulls">
      {card.pulls.map((pull) =>
        /^https?:\/\//i.test(pull.url) ? (
          <Button
            key={`${pull.repo}#${pull.number}`}
            asChild
            variant="link"
            size="xs"
            className="h-auto p-0"
          >
            <a
              href={pull.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t("delivery.pull", { number: pull.number })}
            >
              #{pull.number}
            </a>
          </Button>
        ) : (
          <span
            key={`${pull.repo}#${pull.number}`}
            className="text-meta text-muted-foreground"
          >
            #{pull.number}
          </span>
        ),
      )}
    </span>
  );
}

function DeliveryCard({ card }: { card: BoardCard }) {
  const t = useT();
  return (
    <Card size="sm" className="gap-2" data-slot="delivery-card">
      <div className="flex min-w-0 flex-col gap-2 px-(--card-spacing)">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto min-w-0 justify-start px-1 py-0.5 text-body font-medium"
          aria-label={t("delivery.card", { title: card.title })}
          onClick={() => reveal(card.nodeId)}
        >
          <span className="truncate">{card.title}</span>
        </Button>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusPill
            tone={phraseTone(card.phrase)}
            label={t(phraseKey(card.lane, card.phrase))}
          />
          <PullLinks card={card} />
        </div>
      </div>
    </Card>
  );
}

function Lane({
  lane,
  cards,
}: {
  lane: (typeof BOARD_LANES)[number];
  cards: readonly BoardCard[];
}) {
  const t = useT();
  const headingId = React.useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2"
      data-slot="delivery-lane"
      data-lane={lane}
    >
      <h3
        id={headingId}
        className="flex items-baseline gap-1.5 text-meta font-medium text-muted-foreground"
      >
        <span>{t(laneKey(lane))}</span>
        <span data-numeric>{cards.length}</span>
      </h3>
      {cards.length === 0 ? (
        <EmptyState inline title={t("delivery.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {cards.map((card) => (
            <li key={card.nodeId}>
              <DeliveryCard card={card} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OffBoard({
  merged,
  closed,
}: {
  merged: readonly BoardCard[];
  closed: readonly BoardCard[];
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  if (merged.length + closed.length === 0) return null;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="shrink-0 border-t border-border"
      data-slot="delivery-off-board"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="h-(--row-h-table) w-full justify-start rounded-none px-3"
        >
          <ChevronRight
            className={cn("transition-transform", open && "rotate-90")}
          />
          <span data-numeric>
            {t("delivery.offBoard.summary", {
              merged: merged.length,
              closed: closed.length,
            })}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto px-3 pb-3">
          {[...merged, ...closed].map((card) => (
            <li
              key={card.nodeId}
              className="flex min-w-0 items-center gap-2"
              data-slot="delivery-off-row"
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto min-w-0 flex-1 justify-start px-1 py-0.5 text-body"
                aria-label={t("delivery.card", { title: card.title })}
                onClick={() => reveal(card.nodeId)}
              >
                <span className="truncate">{card.title}</span>
              </Button>
              <StatusPill
                tone={phraseTone(card.phrase)}
                label={t(phraseKey(card.lane, card.phrase))}
              />
              <PullLinks card={card} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 交付面板（Armadra#988）：四栏看板，底部收起的已合并 / 已关闭区。 */
export function DeliveryPanel() {
  const t = useT();
  const open = useCanvasStore((state) => state.panels.delivery === "drawer");
  const document = useCanvasStore((state) => state.document);
  const rows = useDeliveryBoard((state) => state.rows);
  const compact = useCompactLayout();

  const board = React.useMemo(() => {
    const titles = new Map<string, string>();
    for (const node of document?.nodes ?? []) {
      titles.set(
        node.id,
        node.title.trim() === "" ? t("delivery.untitled") : node.title,
      );
    }
    return buildBoard(Object.values(rows), titles, Date.now());
  }, [document, rows, t]);

  return (
    <WorkPanelSheet panel="delivery" open={open} onClose={close}>
      <div className="flex h-(--row-h-table) shrink-0 items-center gap-1 border-b border-border px-3">
        <SheetTitle className="flex-1 truncate text-body font-semibold">
          {t("delivery.title")}
        </SheetTitle>
        <IconButton label={t("delivery.close")} onClick={close}>
          <X />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div
          className={cn(
            "grid gap-3 p-3",
            compact ? "grid-cols-1" : "grid-cols-4",
          )}
        >
          {BOARD_LANES.map((lane) => (
            <Lane key={lane} lane={lane} cards={board.lanes[lane]} />
          ))}
        </div>
      </ScrollArea>
      <OffBoard merged={board.merged} closed={board.closed} />
    </WorkPanelSheet>
  );
}
