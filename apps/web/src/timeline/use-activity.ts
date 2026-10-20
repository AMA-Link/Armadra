/**
 * 活动（渐进式状态，设计 §2.4、§7）的页面侧读取与平滑。
 *
 * 真实状态在 core；这里只决定「显示什么、何时换」：阶段至少持续 300 ms 才显示
 * （审批、出错、退出立即显示），一旦显示至少保持 500 ms，计时每秒刷新一次。
 * 不影响 core 的真实状态，也不影响 `sessionDisplay()` 的结果。
 */
import * as React from "react";
import type { ActivityPhase, SessionActivity } from "@armadra/shared";

import { activeSourceId } from "@/sources/scope";

import { timelineKey, useTimelineStore } from "./store";

/** 某条时间线当前的活动（未平滑）；没有答 `undefined`。 */
export function useActivity(
  timelineId: string | undefined,
  options: { sourceId?: string } = {},
): SessionActivity | undefined {
  const sourceId = options.sourceId ?? activeSourceId();
  return useTimelineStore((state) =>
    timelineId === undefined
      ? undefined
      : state.activities[timelineKey(sourceId, timelineId)],
  );
}

export const SHOW_AFTER_MS = 300;
export const HOLD_MS = 500;

const IMMEDIATE_PHASES: ReadonlySet<ActivityPhase> = new Set([
  "awaiting_approval",
  "awaiting_input",
  "exited",
]);

function isImmediate(activity: SessionActivity): boolean {
  return (
    IMMEDIATE_PHASES.has(activity.phase) ||
    (activity.phase === "idle" && activity.lastOutcome?.kind === "failed")
  );
}

export interface SmootherConfig {
  showAfterMs: number;
  holdMs: number;
}

export interface SmootherState {
  readonly shown?: SessionActivity;
  readonly shownAt: number;
  readonly candidate?: SessionActivity;
  readonly candidateAt: number;
}

export const EMPTY_SMOOTHER: SmootherState = { shownAt: 0, candidateAt: 0 };

export interface SmootherStep {
  readonly state: SmootherState;
  /** 还要等多久再 `evaluate` 一次；不用等是 `undefined`。 */
  readonly wakeInMs?: number;
}

/** 候选是否到了该显示的时候。 */
export function evaluate(
  state: SmootherState,
  now: number,
  config: SmootherConfig,
): SmootherStep {
  const { candidate } = state;
  if (candidate === undefined) return { state };
  const eligibleAt = Math.max(
    state.candidateAt + config.showAfterMs,
    state.shownAt + config.holdMs,
  );
  if (now >= eligibleAt) {
    return {
      state: {
        shown: candidate,
        shownAt: now,
        candidateAt: now,
      },
    };
  }
  return { state, wakeInMs: eligibleAt - now };
}

/** 收到新的真实活动。 */
export function pushActivity(
  state: SmootherState,
  input: SessionActivity | undefined,
  now: number,
  config: SmootherConfig = { showAfterMs: SHOW_AFTER_MS, holdMs: HOLD_MS },
): SmootherStep {
  if (input === undefined) return { state: EMPTY_SMOOTHER };
  const { shown } = state;
  if (shown === undefined || isImmediate(input)) {
    return {
      state: { shown: input, shownAt: now, candidateAt: now },
    };
  }
  if (input.phase === shown.phase) {
    // 同一阶段：细节照常更新，不重置保持时间。
    return {
      state: { shown: input, shownAt: state.shownAt, candidateAt: now },
    };
  }
  const sameCandidate = state.candidate?.phase === input.phase;
  return evaluate(
    {
      ...state,
      candidate: input,
      candidateAt: sameCandidate ? state.candidateAt : now,
    },
    now,
    config,
  );
}

/** 平滑后的活动：给活动行用。 */
export function useSmoothedActivity(
  activity: SessionActivity | undefined,
  { showAfterMs, holdMs }: SmootherConfig = {
    showAfterMs: SHOW_AFTER_MS,
    holdMs: HOLD_MS,
  },
): SessionActivity | undefined {
  const config = React.useMemo(
    () => ({ showAfterMs, holdMs }),
    [showAfterMs, holdMs],
  );
  const machine = React.useRef<SmootherState>(EMPTY_SMOOTHER);
  const [shown, setShown] = React.useState<SessionActivity | undefined>(
    activity,
  );
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  React.useEffect(() => {
    const apply = (step: SmootherStep) => {
      machine.current = step.state;
      setShown(step.state.shown);
      clearTimeout(timer.current);
      timer.current = undefined;
      if (step.wakeInMs !== undefined) {
        timer.current = setTimeout(
          () => apply(evaluate(machine.current, Date.now(), config)),
          step.wakeInMs,
        );
      }
    };
    apply(pushActivity(machine.current, activity, Date.now(), config));
    return () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [activity, config]);

  return shown;
}

/** 本阶段已持续多久（毫秒），每秒刷新一次；没有活动时为 0。 */
export function useActivityElapsed(
  activity: SessionActivity | undefined,
): number {
  const [now, setNow] = React.useState(() => Date.now());
  const since = activity?.since;
  React.useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [since]);
  return since === undefined ? 0 : Math.max(0, now - since);
}
