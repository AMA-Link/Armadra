import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TimelineThoughtItem } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Spinner } from "@/ui/spinner";
import { formatDuration } from "../format";
import { StreamingMarkdown } from "../parts/StreamingMarkdown";
import { memoRow } from "../row-memo";

export interface ThoughtRowProps {
  item: TimelineThoughtItem;
}

/** 思考：默认折叠，标题「思考 · 12 s」，展开是 Markdown；流式时标题带 Spinner。 */
function ThoughtRowImpl({ item }: ThoughtRowProps) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const duration =
    item.durationMs !== undefined ? formatDuration(item.durationMs) : "";
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-slot="timeline-thought"
      data-streaming={item.streaming || undefined}
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 font-normal text-muted-foreground"
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          <span className="text-xs">
            {t("timeline.thought")}
            {duration !== "" && ` · ${duration}`}
          </span>
          {item.streaming && <Spinner aria-hidden className="size-3" />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pt-0.5 pl-7 text-muted-foreground">
        <StreamingMarkdown text={item.text} className="text-xs" />
      </CollapsibleContent>
    </Collapsible>
  );
}

export const ThoughtRow = memoRow(ThoughtRowImpl);
