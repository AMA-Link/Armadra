import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchWorkspaceEvent } from "@/api/events";

import {
  createSourceTransport,
  isCursorAhead,
  setTimelineTransportFactory,
  timelineTransportFor,
} from "./api";
import { activity, append, assistant, frame, put } from "./test-support";

afterEach(() => setTimelineTransportFactory());

const dispatch = (event: Record<string, unknown>, sourceId: string) =>
  dispatchWorkspaceEvent(event as never, sourceId);

describe("source transport events", () => {
  it("routes delta and activity events of its own source only", () => {
    const transport = createSourceTransport("remote-1");
    const listener = {
      delta: vi.fn(),
      activity: vi.fn(),
      reconnected: vi.fn(),
    };
    const off = transport.subscribe(listener);
    const delta = frame(0, 2, [put(1, assistant(0)), append(2, "a:0:0", "x")]);
    dispatch({ type: "timeline.delta", ...delta }, "remote-1");
    dispatch({ type: "timeline.delta", ...delta }, "other");
    dispatch(
      {
        type: "timeline.activity",
        timelineId: "sess-1",
        nodeId: "node-1",
        activity: activity(1),
      },
      "remote-1",
    );
    // 形状不对的帧不会进数据层。
    dispatch({ type: "timeline.delta", timelineId: "sess-1" }, "remote-1");
    expect(listener.delta).toHaveBeenCalledTimes(1);
    expect(listener.delta.mock.calls[0]![0].ops).toHaveLength(2);
    expect(listener.activity).toHaveBeenCalledTimes(1);
    off();
    dispatch({ type: "timeline.delta", ...delta }, "remote-1");
    expect(listener.delta).toHaveBeenCalledTimes(1);
  });
});

describe("transport factory", () => {
  it("memoizes one transport per source", () => {
    const factory = vi.fn(() => createSourceTransport("x"));
    setTimelineTransportFactory(factory);
    expect(timelineTransportFor("a")).toBe(timelineTransportFor("a"));
    timelineTransportFor("b");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("recognises cursor_ahead errors", () => {
    expect(isCursorAhead({ code: "cursor_ahead" })).toBe(true);
    expect(isCursorAhead(new Error("x"))).toBe(false);
  });
});
