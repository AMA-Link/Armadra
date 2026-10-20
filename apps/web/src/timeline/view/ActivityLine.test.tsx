import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ActivityLine } from "./ActivityLine";
import { activity } from "./fixtures";
import { displayPhaseOf } from "./display-phase";
import {
  HOLD_MS as MIN_HOLD_MS,
  SHOW_AFTER_MS as ENTER_DELAY_MS,
} from "../use-activity";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const phaseOf = () =>
  document
    .querySelector("[data-slot=timeline-activity]")
    ?.getAttribute("data-phase") ?? null;

describe("ActivityLine", () => {
  it("shows the phase, the current tool name and the elapsed time", () => {
    render(
      <ActivityLine
        activity={activity("tool", {
          since: 1000,
          turnStartedAt: 1000,
          detail: { label: "pnpm test", toolKind: "execute" },
        })}
        now={13_000}
      />,
    );
    const line = document.querySelector("[data-slot=timeline-activity]");
    expect(line?.textContent).toBe("运行· pnpm test· 12 s");
    expect(line?.querySelector("[data-slot=spinner]")).toBeTruthy();
    expect(line?.querySelector("[aria-live=polite]")?.textContent).toBe("运行");
  });

  it("appends the quiet hint after 60 s without output", () => {
    render(
      <ActivityLine
        activity={activity("responding", { since: 0, lastOutputAt: 1000 })}
        now={80_000}
      />,
    );
    expect(screen.getByText(/已 1 m 19 s 无输出/)).toBeTruthy();
  });

  it("does not spin for approval and failure and shows them in tone", () => {
    const { rerender } = render(
      <ActivityLine activity={activity("awaiting_approval")} now={5000} />,
    );
    const line = () => document.querySelector("[data-slot=timeline-activity]");
    expect(line()?.querySelector("[data-slot=spinner]")).toBeNull();
    expect(line()?.className).toContain("warn-text");
    rerender(
      <ActivityLine
        activity={activity("idle", { lastOutcome: { kind: "failed", at: 1 } })}
        now={5000}
      />,
    );
    expect(phaseOf()).toBe("failed");
    expect(line()?.className).toContain("danger-text");
  });

  it("starting shows the step; restoring shows the replayed count", () => {
    const first = render(
      <ActivityLine
        activity={activity("starting", { detail: { step: "initialize" } })}
        now={0}
      />,
    );
    expect(screen.getByText(/初始化/)).toBeTruthy();
    first.unmount();
    render(
      <ActivityLine
        activity={activity("restoring", { detail: { count: 120 } })}
        now={0}
      />,
    );
    expect(screen.getByText(/恢复历史/)).toBeTruthy();
    expect(screen.getByText(/120/)).toBeTruthy();
  });

  it("draws nothing when idle", () => {
    const { container } = render(<ActivityLine activity={activity("idle")} />);
    expect(container.textContent).toBe("");
  });
});

describe("anti-flicker", () => {
  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it("a phase that flips back within the enter delay is never shown", () => {
    const { rerender } = render(
      <ActivityLine activity={activity("responding")} now={0} />,
    );
    expect(phaseOf()).toBe("responding");
    advance(MIN_HOLD_MS + 10);
    rerender(<ActivityLine activity={activity("tool")} now={0} />);
    advance(ENTER_DELAY_MS - 100);
    expect(phaseOf()).toBe("responding");
    rerender(
      <ActivityLine activity={activity("responding", { since: 5 })} now={0} />,
    );
    advance(1000);
    expect(phaseOf()).toBe("responding");
  });

  it("a new phase shows after the enter delay, and is then held at least 500 ms", () => {
    const { rerender } = render(
      <ActivityLine activity={activity("responding")} now={0} />,
    );
    advance(MIN_HOLD_MS + 10);
    rerender(<ActivityLine activity={activity("tool")} now={0} />);
    advance(ENTER_DELAY_MS - 1);
    expect(phaseOf()).toBe("responding");
    advance(2);
    expect(phaseOf()).toBe("tool");
    // 立刻又要切回去：必须再保持满 500 ms 才换
    rerender(<ActivityLine activity={activity("thinking")} now={0} />);
    advance(ENTER_DELAY_MS + 50);
    expect(phaseOf()).toBe("tool");
    advance(MIN_HOLD_MS);
    expect(phaseOf()).toBe("thinking");
  });

  it("frequent detail updates do not postpone a pending switch", () => {
    const { rerender } = render(
      <ActivityLine activity={activity("responding")} now={0} />,
    );
    advance(MIN_HOLD_MS + 10);
    rerender(
      <ActivityLine activity={activity("tool", { rev: "b:1" })} now={0} />,
    );
    for (let i = 2; i < 6; i++) {
      advance(80);
      rerender(
        <ActivityLine
          activity={activity("tool", { rev: `b:${i}`, lastOutputAt: i })}
          now={0}
        />,
      );
    }
    advance(100);
    expect(phaseOf()).toBe("tool");
  });

  it("approval, failure and exit show immediately", () => {
    const { rerender } = render(
      <ActivityLine activity={activity("tool")} now={0} />,
    );
    rerender(<ActivityLine activity={activity("awaiting_approval")} now={0} />);
    expect(phaseOf()).toBe("awaiting_approval");
    rerender(<ActivityLine activity={activity("exited")} now={0} />);
    expect(phaseOf()).toBe("exited");
  });

  it("within the same phase the detail follows at once", () => {
    const { rerender } = render(
      <ActivityLine
        activity={activity("tool", { detail: { label: "first" } })}
        now={0}
      />,
    );
    rerender(
      <ActivityLine
        activity={activity("tool", { detail: { label: "second" } })}
        now={0}
      />,
    );
    expect(screen.getByText(/second/)).toBeTruthy();
  });

  it("derives display phases", () => {
    expect(displayPhaseOf(undefined)).toBe("idle");
    expect(
      displayPhaseOf(
        activity("idle", { lastOutcome: { kind: "done", at: 1 } }),
      ),
    ).toBe("idle");
    expect(
      displayPhaseOf(
        activity("idle", { lastOutcome: { kind: "failed", at: 1 } }),
      ),
    ).toBe("failed");
  });
});
