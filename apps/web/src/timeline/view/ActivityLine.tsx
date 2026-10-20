import * as React from "react";
import type { ActivityPhase, SessionActivity } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { Spinner } from "@/ui/spinner";
import { formatDuration } from "./format";
import { useSmoothedActivity, type DisplayPhase } from "./smooth";

/** 超过这么久没有输出，追加「已 N 无输出」。 */
export const QUIET_AFTER_MS = 60_000;

const SPINNING: ReadonlySet<DisplayPhase> = new Set<ActivityPhase>([
  "starting",
  "restoring",
  "submitting",
  "thinking",
  "tool",
  "responding",
  "switching",
]);

function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** 阶段后面的细节：工具标题、回放条数、启动步骤。 */
function detailOf(
  activity: SessionActivity,
  phase: DisplayPhase,
  t: ReturnType<typeof useT>,
): string {
  const detail = activity.detail;
  if (detail === undefined) return "";
  if (phase === "starting" && detail.step !== undefined)
    return t(`timeline.activity.step.${detail.step}`);
  if (phase === "restoring" && detail.count !== undefined)
    return String(detail.count);
  if (phase === "tool") {
    const label = detail.label ?? "";
    return detail.count !== undefined && detail.count > 1
      ? `${label} +${detail.count - 1}`.trim()
      : label;
  }
  return detail.label ?? "";
}

export interface ActivityLineProps {
  activity: SessionActivity | null | undefined;
  /** 测试用：固定当前时间。 */
  now?: number | undefined;
}

/**
 * 活动行（设计 §7）：`Spinner` + 阶段 + 细节 + 计时，如「运行 · pnpm test · 12 s」。
 * 阶段经 `useSmoothedActivity` 防闪烁；审批与出错不转圈，换成对应色调；
 * `aria-live="polite"` 的只有阶段文字，计时不播报。
 */
export function ActivityLine({ activity, now: fixedNow }: ActivityLineProps) {
  const t = useT();
  const { shown, phase } = useSmoothedActivity(activity);
  const visible = phase !== "idle" && shown !== null;
  const ticking = visible && fixedNow === undefined;
  const clock = useNow(ticking);
  const now = fixedNow ?? clock;
  if (!visible || shown === null) return null;

  const elapsed = formatDuration(
    Math.max(0, now - (shown.turnStartedAt ?? shown.since)),
  );
  const quiet =
    shown.lastOutputAt !== undefined &&
    phase !== "awaiting_approval" &&
    phase !== "awaiting_input" &&
    now - shown.lastOutputAt >= QUIET_AFTER_MS
      ? formatDuration(now - shown.lastOutputAt)
      : "";
  const detail = detailOf(shown, phase, t);
  const tone =
    phase === "failed"
      ? "text-[var(--danger-text)]"
      : phase === "awaiting_approval" || phase === "awaiting_input"
        ? "text-[var(--warn-text)]"
        : "text-muted-foreground";
  return (
    <div
      data-slot="timeline-activity"
      data-phase={phase}
      className={cn("flex min-w-0 items-center gap-2 px-2 py-1 text-xs", tone)}
    >
      {SPINNING.has(phase) && (
        <Spinner aria-hidden className="size-3 motion-reduce:animate-none" />
      )}
      <span aria-live="polite" className="shrink-0">
        {t(`timeline.activity.${phase}`)}
      </span>
      {detail !== "" && (
        <span className="min-w-0 truncate" title={detail}>
          · {detail}
        </span>
      )}
      <span aria-hidden className="shrink-0 tabular-nums">
        {phase === "awaiting_approval" || phase === "awaiting_input"
          ? ""
          : `· ${elapsed}`}
      </span>
      {quiet !== "" && (
        <span aria-hidden className="shrink-0 tabular-nums">
          · {t("timeline.activity.quiet", { time: quiet })}
        </span>
      )}
    </div>
  );
}
