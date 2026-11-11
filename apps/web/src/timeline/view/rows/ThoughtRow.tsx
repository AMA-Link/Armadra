import * as React from "react";
import { Brain, ChevronRight } from "lucide-react";
import type { TimelineThoughtItem } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Shimmer } from "@/ui/shimmer";
import { TextSwap } from "@/ui/text-swap";
import { cn } from "@/lib/cn";
import {
  ENTRY_BODY,
  ENTRY_FRAME,
  ENTRY_NESTED_BODY,
  ENTRY_TRIGGER,
} from "../entry";
import { formatDuration } from "../format";
import { StreamingMarkdown } from "../parts/StreamingMarkdown";
import { memoRow } from "../row-memo";
import { useElapsed } from "../use-elapsed";
import { PartView } from "./AssistantRow";

export interface ThoughtRowProps {
  item: TimelineThoughtItem;
  /** 嵌在活动组里：没有自己的边框。 */
  plain?: boolean | undefined;
  /** 测试用：固定当前时间。 */
  now?: number | undefined;
}

/**
 * 思考（设计系统 §5.1）：一张默认折叠的条目卡片。流式时标题「思考」带微光，后面是
 * 实时秒数；结束后固定成「思考了 12 s」（标签用 `TextSwap` 换字）。没有时长的历史
 * 记录只写「思考」。展开是 Markdown，限高可滚。
 */
function ThoughtRowImpl({ item, plain, now }: ThoughtRowProps) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const elapsed = useElapsed(item.streaming, item.at, now);
  const duration =
    item.durationMs !== undefined ? formatDuration(item.durationMs) : "";
  const label = item.streaming
    ? t("timeline.thinking")
    : duration !== ""
      ? t("timeline.thoughtDone", { duration })
      : t("timeline.thought");
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-slot="timeline-thought"
      data-streaming={item.streaming || undefined}
      className={plain ? "min-w-0" : ENTRY_FRAME}
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            ENTRY_TRIGGER,
            "text-muted-foreground hover:text-foreground",
          )}
        >
          <Brain aria-hidden />
          <Shimmer
            active={item.streaming}
            className="min-w-0 truncate text-meta"
          >
            <TextSwap>{label}</TextSwap>
          </Shimmer>
          {item.streaming && elapsed !== "" && (
            <span data-numeric className="font-mono text-caption">
              {elapsed}
            </span>
          )}
          <ChevronRight
            aria-hidden
            data-open={open || undefined}
            className="ml-auto transition-[rotate] duration-(--dur-fast) data-open:rotate-90"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent
        data-slot="timeline-thought-body"
        className={cn(
          plain ? ENTRY_NESTED_BODY : ENTRY_BODY,
          "max-h-64 overflow-y-auto text-muted-foreground",
        )}
      >
        {item.text !== "" && (
          <StreamingMarkdown text={item.text} className="text-meta" />
        )}
        {item.parts?.map((part, index) => (
          <PartView key={index} part={part} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export const ThoughtRow = memoRow(ThoughtRowImpl);
