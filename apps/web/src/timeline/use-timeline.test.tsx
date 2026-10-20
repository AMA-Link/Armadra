import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setTimelineTransportFactory } from "./api";
import { createTimelineCache, setTimelineCache } from "./cache";
import { resetTimelines, setFrameScheduler } from "./sync";
import {
  FakeCore,
  SOURCE_ID,
  TIMELINE_ID,
  append,
  manualScheduler,
} from "./test-support";
import { useTimeline } from "./use-timeline";

let core: FakeCore;
let frames: ReturnType<typeof manualScheduler>;

beforeEach(() => {
  core = new FakeCore().seedTurns(8);
  frames = manualScheduler();
  setFrameScheduler(frames.scheduler);
  setTimelineCache(createTimelineCache(null));
  setTimelineTransportFactory(() => core.transport);
});

afterEach(() => {
  resetTimelines();
  setTimelineTransportFactory();
  setTimelineCache();
  setFrameScheduler();
});

describe("useTimeline", () => {
  it("loads the tail, streams deltas and pages upward", async () => {
    const { result } = renderHook(() =>
      useTimeline(TIMELINE_ID, { sourceId: SOURCE_ID }),
    );
    expect(result.current.phase).not.toBe("ready");
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.items).toHaveLength(6);
    expect(result.current.turns).toHaveLength(8);
    expect(result.current.hasMore).toBe(true);

    act(() => {
      core.deliver(core.emit(append(0, "a:7:0", "!")));
      frames.runFrame();
    });
    const last = result.current.items.at(-1);
    expect(last?.kind === "assistant" && last.parts[0]).toMatchObject({
      text: "a7!",
    });

    await act(async () => {
      expect(await result.current.loadMore()).toBe(10);
    });
    expect(result.current.items).toHaveLength(16);
  });

  it("does nothing when disabled or without an id", () => {
    const { result, rerender } = renderHook(
      ({ id, enabled }: { id: string | undefined; enabled: boolean }) =>
        useTimeline(id, { sourceId: SOURCE_ID, enabled }),
      {
        initialProps: {
          id: TIMELINE_ID as string | undefined,
          enabled: false,
        },
      },
    );
    rerender({ id: undefined, enabled: true });
    expect(result.current.phase).toBe("idle");
    expect(core.calls).toEqual([]);
    expect(core.listeners.size).toBe(0);
  });

  it("subscribes on mount and keeps the controller through the grace period", async () => {
    const { unmount } = renderHook(() =>
      useTimeline(TIMELINE_ID, { sourceId: SOURCE_ID }),
    );
    await waitFor(() => expect(core.listeners.size).toBe(1));
    unmount();
    expect(core.listeners.size).toBe(1);
  });
});
