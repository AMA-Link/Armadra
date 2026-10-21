import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchWorkspaceEvent } from "@/api/events";

import { RuntimeRequestError } from "@/api/request";
import {
  createSourceTransport,
  isCursorAhead,
  isTimelineMissing,
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

  it("reads the error shapes core and old hosts really return", () => {
    // core 的 `fail("not_found")` 经 HTTP 与控制面都是 `{ code, status }`。
    expect(isTimelineMissing({ code: "not_found", status: 404 })).toBe(true);
    expect(
      isTimelineMissing(new RuntimeRequestError(404, "x", "not_found")),
    ).toBe(true);
    // 旧主机没有这条路由：只有状态码，或 not_implemented。
    expect(isTimelineMissing(new RuntimeRequestError(404, "x"))).toBe(true);
    expect(isTimelineMissing({ code: "not_implemented" })).toBe(true);
    // cursor_ahead（409）是另一回事：整份重开，不是没有时间线。
    expect(
      isCursorAhead(new RuntimeRequestError(409, "x", "cursor_ahead")),
    ).toBe(true);
    expect(
      isTimelineMissing(new RuntimeRequestError(409, "x", "cursor_ahead")),
    ).toBe(false);
    expect(isTimelineMissing(new Error("offline"))).toBe(false);
  });
});
