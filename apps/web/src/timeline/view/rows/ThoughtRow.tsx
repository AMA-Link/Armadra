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
import { Shimmer } from "@/ui/shimmer";
import { TextSwap } from "@/ui/text-swap";
import { formatDuration } from "../format";
import { StreamingMarkdown } from "../parts/StreamingMarkdown";
import { memoRow } from "../row-memo";

export interface ThoughtRowProps {
  item: TimelineThoughtItem;
  /** 测试用：固定当前时间。 */
  now?: number | undefined;
}

/** 流式时标题后面实时跳动的秒数（从这一条开始的时刻算起）。 */
function useElapsed(
  active: boolean,
  since: number,
  fixed: number | undefined,
): string {
  const [now, setNow] = React.useState(() => fixed ?? Date.now());
  React.useEffect(() => {
    if (!active || fixed !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, fixed]);
  return formatDuration(Math.max(0, (fixed ?? now) - since));
}

/**
 * 思考（设计系统 §5.1）：默认折叠。流式时标题「思考」带微光，后面是实时秒数；结束后
 * 固定成「思考了 12 s」（标签用 `TextSwap` 换字）。没有时长的历史记录只写「思考」。
 * 展开是 Markdown。
 */
function ThoughtRowImpl({ item, now }: ThoughtRowProps) {
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
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-2 font-normal text-muted-foreground"
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          <Shimmer active={item.streaming} className="text-meta">
            <TextSwap>{label}</TextSwap>
          </Shimmer>
          {item.streaming && elapsed !== "" && (
            <span data-numeric className="font-mono text-caption">
              {elapsed}
            </span>
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pt-0.5 pl-7 text-muted-foreground">
        <StreamingMarkdown text={item.text} className="text-meta" />
      </CollapsibleContent>
    </Collapsible>
  );
}

export const ThoughtRow = memoRow(ThoughtRowImpl);
