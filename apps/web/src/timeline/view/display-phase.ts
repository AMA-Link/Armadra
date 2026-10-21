import type { ActivityPhase, SessionActivity } from "@armadra/shared";

/** 页面侧的显示阶段：`idle` 且上一回合出错时是 `failed`。 */
export type DisplayPhase = ActivityPhase | "failed";

export function displayPhaseOf(
  activity: SessionActivity | null | undefined,
): DisplayPhase {
  if (activity === null || activity === undefined) return "idle";
  if (activity.phase === "idle" && activity.lastOutcome?.kind === "failed")
    return "failed";
  return activity.phase;
}
