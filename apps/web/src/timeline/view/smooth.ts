import * as React from "react";
import type { ActivityPhase, SessionActivity } from "@armadra/shared";

/** 页面侧的显示阶段：`idle` 且上一回合出错时是 `failed`。 */
export type DisplayPhase = ActivityPhase | "failed";

/** 新阶段至少持续这么久才显示。 */
export const ENTER_DELAY_MS = 300;
/** 一旦显示，至少保持这么久。 */
export const MIN_HOLD_MS = 500;

/** 审批、出错、退出立即显示，不等也不被占着。 */
const IMMEDIATE: ReadonlySet<DisplayPhase> = new Set<DisplayPhase>([
  "awaiting_approval",
  "awaiting_input",
  "failed",
  "exited",
]);

export function displayPhaseOf(
  activity: SessionActivity | null | undefined,
): DisplayPhase {
  if (activity === null || activity === undefined) return "idle";
  if (activity.phase === "idle" && activity.lastOutcome?.kind === "failed")
    return "failed";
  return activity.phase;
}

export interface SmoothedActivity {
  /** 当前应当显示的活动快照（细节随最新值更新，阶段经过防抖）。 */
  shown: SessionActivity | null;
  phase: DisplayPhase;
}

/**
 * 防闪烁（设计 §7）：阶段至少持续 {@link ENTER_DELAY_MS} 才显示，显示后至少保持
 * {@link MIN_HOLD_MS}；审批、出错、退出立即显示。只影响显示，不改 core 的真实状态。
 * 阶段不变时，细节与时间立刻跟随最新值。
 */
export function useSmoothedActivity(
  activity: SessionActivity | null | undefined,
): SmoothedActivity {
  const target = displayPhaseOf(activity);
  const [shown, setShown] = React.useState<SmoothedActivity>(() => ({
    shown: activity ?? null,
    phase: target,
  }));
  const shownAt = React.useRef(Date.now());
  const latest = React.useRef(activity);
  latest.current = activity;

  // 阶段切换：等够再显示。只依赖阶段本身，细节的频繁更新不会重置计时。
  React.useEffect(() => {
    if (target === shown.phase) return;
    const commit = (): void => {
      shownAt.current = Date.now();
      setShown({ shown: latest.current ?? null, phase: target });
    };
    if (IMMEDIATE.has(target)) {
      commit();
      return;
    }
    const hold = Math.max(0, shownAt.current + MIN_HOLD_MS - Date.now());
    const timer = setTimeout(commit, Math.max(ENTER_DELAY_MS, hold));
    return () => clearTimeout(timer);
  }, [target, shown.phase]);

  // 阶段不变：细节与时间立刻跟随。
  React.useEffect(() => {
    const next = activity ?? null;
    if (target === shown.phase && shown.shown !== next)
      setShown({ shown: next, phase: target });
  }, [activity, target, shown]);

  return shown;
}
