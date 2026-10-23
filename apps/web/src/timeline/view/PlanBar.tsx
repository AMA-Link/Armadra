import { ChevronDown } from "lucide-react";
import type { TimelinePlanEntry, TimelinePlanItem } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Progress } from "@/ui/progress";
import { StatusDot, type StatusTone } from "@/ui/status-pill";

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

/** 步骤状态 → 圆点色调：完成 / 进行中 / 其余排队。 */
export function toneOfEntry(status: string | undefined): StatusTone {
  if (status === "completed") return "done";
  if (status === "in_progress") return "working";
  return "queued";
}

function EntryDot({ status }: { status: string | undefined }) {
  const tone = toneOfEntry(status);
  return <StatusDot tone={tone} size={6} pulse={false} />;
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
          className="w-full min-w-0 justify-start gap-2 px-2 font-normal"
        >
          <EntryDot status={current?.status} />
          <span className="min-w-0 flex-1 truncate text-left text-meta">
            {current?.content}
          </span>
          <Progress
            variant="ticks"
            tone="brand"
            value={(done / total) * 100}
            aria-hidden
            className="w-24 shrink-0"
          />
          <span
            data-numeric
            className="shrink-0 font-mono text-caption text-muted-foreground"
          >
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
              className="flex items-start gap-2 text-meta [&>[data-slot=status-dot]]:mt-[5px]"
            >
              <EntryDot status={entry.status} />
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
