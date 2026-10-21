import { Check, ChevronDown, Circle, CircleDot } from "lucide-react";
import type { TimelinePlanEntry, TimelinePlanItem } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Progress } from "@/ui/progress";

export function planProgress(entries: readonly TimelinePlanEntry[]): {
  done: number;
  total: number;
  current: TimelinePlanEntry | undefined;
} {
  const done = entries.filter((entry) => entry.status === "completed").length;
  const current =
    entries.find((entry) => entry.status === "in_progress") ??
    entries.find((entry) => entry.status !== "completed") ??
    entries[entries.length - 1];
  return { done, total: entries.length, current };
}

function EntryIcon({ status }: { status: string | undefined }) {
  if (status === "completed")
    return <Check className="text-[var(--success)]" />;
  if (status === "in_progress")
    return <CircleDot className="text-[var(--brand-text)]" />;
  return <Circle className="text-muted-foreground" />;
}

/** 会话顶部的计划条：当前项与进度（x / n），点开是清单。 */
export function PlanBar({
  plan,
}: {
  plan: TimelinePlanItem | null | undefined;
}) {
  const t = useT();
  if (plan === null || plan === undefined || plan.entries.length === 0)
    return null;
  const { done, total, current } = planProgress(plan.entries);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-slot="timeline-plan-bar"
          aria-label={t("timeline.plan")}
          className="h-8 w-full min-w-0 justify-start gap-2 px-2 font-normal"
        >
          <EntryIcon status={current?.status} />
          <span className="min-w-0 flex-1 truncate text-left text-xs">
            {current?.content}
          </span>
          <Progress value={(done / total) * 100} className="w-16 shrink-0" />
          <span className="shrink-0 text-[length:var(--text-caption)] text-muted-foreground tabular-nums">
            {done} / {total}
          </span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-1 p-2">
        <ul data-slot="timeline-plan-list" className="flex flex-col gap-1">
          {plan.entries.map((entry, index) => (
            <li
              key={index}
              data-status={entry.status}
              className="flex items-start gap-2 text-xs [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0"
            >
              <EntryIcon status={entry.status} />
              <span
                className={
                  entry.status === "completed"
                    ? "text-muted-foreground line-through"
                    : undefined
                }
              >
                {entry.content}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
