import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_SMOOTHER,
  HOLD_MS,
  SHOW_AFTER_MS,
  evaluate,
  pushActivity,
  useActivityElapsed,
  useSmoothedActivity,
} from "./use-activity";
import { activity } from "./test-support";

const config = { showAfterMs: SHOW_AFTER_MS, holdMs: HOLD_MS };

describe("pushActivity", () => {
  it("shows the first activity immediately", () => {
    const step = pushActivity(EMPTY_SMOOTHER, activity(1, "idle"), 0);
    expect(step.state.shown?.phase).toBe("idle");
  });

  it("waits 300 ms before switching to a new phase", () => {
    let state = pushActivity(
      EMPTY_SMOOTHER,
      activity(1, "responding"),
      0,
    ).state;
    const step = pushActivity(state, activity(2, "thinking"), 1_000);
    expect(step.state.shown?.phase).toBe("responding");
    expect(step.wakeInMs).toBe(300);
    state = evaluate(step.state, 1_300, config).state;
    expect(state.shown?.phase).toBe("thinking");
  });

  it("never shows a phase that ends inside the delay", () => {
    const first = pushActivity(
      EMPTY_SMOOTHER,
      activity(1, "responding"),
      0,
    ).state;
    const blip = pushActivity(first, activity(2, "tool"), 1_000).state;
    const back = pushActivity(blip, activity(3, "responding"), 1_100);
    expect(back.state.shown?.phase).toBe("responding");
    expect(back.state.shown?.rev).toBe("boot:3");
  });

  it("holds a shown phase for 500 ms even if the next is eligible earlier", () => {
    const shown = pushActivity(EMPTY_SMOOTHER, activity(1, "tool"), 0).state;
    // 候选在 0 ms 开始，但已显示的 tool 要保持到 500 ms。
    const step = pushActivity(shown, activity(2, "responding"), 0);
    expect(step.wakeInMs).toBe(500);
  });

  it("shows approval, input, exit and failure at once", () => {
    const base = pushActivity(
      EMPTY_SMOOTHER,
      activity(1, "responding"),
      0,
    ).state;
    for (const phase of [
      "awaiting_approval",
      "awaiting_input",
      "exited",
    ] as const) {
      expect(
        pushActivity(base, activity(2, phase), 10).state.shown?.phase,
      ).toBe(phase);
    }
    const failed = {
      ...activity(2, "idle"),
      lastOutcome: { kind: "failed" as const, at: 5, error: "x" },
    };
    expect(pushActivity(base, failed, 10).state.shown).toBe(failed);
  });

  it("updates details of the same phase without resetting the hold", () => {
    const shown = pushActivity(EMPTY_SMOOTHER, activity(1, "tool"), 0).state;
    const next = { ...activity(2, "tool"), detail: { label: "pnpm test" } };
    const step = pushActivity(shown, next, 400);
    expect(step.state.shown).toBe(next);
    expect(step.state.shownAt).toBe(0);
  });
});

describe("hooks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("useSmoothedActivity switches after the delay", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSmoothedActivity(value),
      { initialProps: { value: activity(1, "responding") } },
    );
    expect(result.current?.phase).toBe("responding");
    rerender({ value: activity(2, "thinking") });
    expect(result.current?.phase).toBe("responding");
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    expect(result.current?.phase).toBe("thinking");
  });

  it("useActivityElapsed ticks once a second", () => {
    vi.setSystemTime(10_000);
    const { result } = renderHook(() =>
      useActivityElapsed({ ...activity(1, "tool"), since: 7_000 }),
    );
    expect(result.current).toBe(3_000);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(4_000);
  });
});
