import * as React from "react";
import type { ActivityPhase, SessionActivity } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { StatusLine, type StatusTone } from "@/ui/status-pill";
import { formatDuration } from "./format";
import { useSmoothedActivity } from "../use-activity";
import { displayPhaseOf, type DisplayPhase } from "./display-phase";

/** 超过这么久没有输出，追加「已 N 无输出」。 */
export const QUIET_AFTER_MS = 60_000;

/** 在跑的阶段：前导转圈，色调 `working`。审批、出错、休眠、退出不转。 */
const SPINNING: ReadonlySet<DisplayPhase> = new Set<ActivityPhase>([
  "starting",
  "restoring",
  "submitting",
  "thinking",
  "tool",
  "responding",
  "switching",
]);

/** 阶段 → `StatusLine` 的色调（与设计系统 §11.1 一致）。 */
export function toneOfPhase(phase: DisplayPhase): StatusTone {
  if (phase === "failed") return "failed";
  if (phase === "awaiting_approval" || phase === "awaiting_input")
    return "attention";
  if (phase === "sleeping") return "paused";
  if (phase === "exited" || phase === "idle") return "idle";
  return "working";
}

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
 * 活动行（设计系统 §5.1 / §11.1）：一条 `StatusLine`——阶段 + 细节 + 计时，如
 * 「运行 · pnpm test · 12 s」；超过 60 s 没有输出时细节后追加「已 N 无输出」。
 * 阶段经页面数据层的 `useSmoothedActivity` 防闪烁（显示 300 ms、保持 500 ms）；审批与
 * 出错不转圈，换成对应色调；`aria-live="polite"` 的只有阶段文字，计时不播报。
 */
export function ActivityLine({ activity, now: fixedNow }: ActivityLineProps) {
  const t = useT();
  const shown = useSmoothedActivity(activity ?? undefined);
  const phase = displayPhaseOf(shown);
  const visible = phase !== "idle" && shown !== undefined;
  const ticking = visible && fixedNow === undefined;
  const clock = useNow(ticking);
  const now = fixedNow ?? clock;
  if (!visible) return null;

  const waiting = phase === "awaiting_approval" || phase === "awaiting_input";
  const quiet =
    shown.lastOutputAt !== undefined &&
    !waiting &&
    now - shown.lastOutputAt >= QUIET_AFTER_MS
      ? t("timeline.activity.quiet", {
          time: formatDuration(now - shown.lastOutputAt),
        })
      : "";
  const detail = [detailOf(shown, phase, t), quiet]
    .filter((part) => part !== "")
    .join(" · ");
  const tone = toneOfPhase(phase);
  return (
    <StatusLine
      data-slot="timeline-activity"
      data-phase={phase}
      tone={tone}
      label={t(`timeline.activity.${phase}`)}
      detail={detail}
      since={waiting ? undefined : (shown.turnStartedAt ?? shown.since)}
      spinning={SPINNING.has(phase)}
      now={now}
      className={
        tone === "failed"
          ? "px-2 py-1 text-danger-text"
          : tone === "attention"
            ? "px-2 py-1 text-warn-text"
            : "px-2 py-1"
      }
    />
  );
}
