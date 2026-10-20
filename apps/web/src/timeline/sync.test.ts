import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryBackend, createTimelineCache } from "./cache";
import { useTimelineStore, timelineKey } from "./store";
import {
  RETRY_DELAY_MS,
  TimelineController,
  acquireTimeline,
  resetTimelines,
  setFrameScheduler,
} from "./sync";
import {
  FakeCore,
  SOURCE_ID,
  TIMELINE_ID,
  activity,
  append,
  assistant,
  assistantText,
  frame,
  manualScheduler,
  put,
} from "./test-support";

const KEY = timelineKey(SOURCE_ID, TIMELINE_ID);
const entry = () => useTimelineStore.getState().entries[KEY]!;
const textOf = (id: string) => assistantText(entry().byId[id]);

let frames: ReturnType<typeof manualScheduler>;

beforeEach(() => {
  frames = manualScheduler();
  setFrameScheduler(frames.scheduler);
});

afterEach(() => {
  resetTimelines();
  setFrameScheduler();
  vi.useRealTimers();
});

function setup(
  core: FakeCore,
  cache = createTimelineCache(createMemoryBackend()),
) {
  const controller = new TimelineController(SOURCE_ID, TIMELINE_ID, {
    transport: core.transport,
    cache,
  });
  return { controller, cache };
}

async function ready(controller: TimelineController) {
  await controller.start();
  expect(entry().phase).toBe("ready");
}

describe("open", () => {
  it("fetches only the tail 3 turns and the full turn index", async () => {
    const core = new FakeCore().seedTurns(10);
    const { controller } = setup(core);
    await ready(controller);
    expect(core.calls).toEqual(["open"]);
    expect(core.transport.open).toHaveBeenCalledWith(TIMELINE_ID, 3);
    expect(entry().order).toHaveLength(6);
    expect(entry().turns).toHaveLength(10);
    expect(entry().oldestLoadedTurn).toBe(7);
    expect(entry().hasMore).toBe(true);
    expect(entry().fromCache).toBe(false);
  });

  it("buffers frames from before open returns and drops those the snapshot already covers", async () => {
    const core = new FakeCore().seedTurns(1);
    const stale = core.emit(put(0, assistant(0, "old")));
    const fresh = core.emit(append(0, "a:0:0", "!"));
    const { controller } = setup(core);
    // 订阅发生在 open 之前：帧在基线返回前到达。
    const booting = controller.start();
    core.deliver(stale);
    core.deliver(fresh);
    core.deliver(core.emit(append(0, "a:0:0", "?")));
    await booting;
    expect(textOf("a:0:0")).toBe("old!?");
    expect(entry().seq).toBe(core.state.seq);
    expect(core.calls).toEqual(["open"]);
  });

  it("shows an error and retries open", async () => {
    vi.useFakeTimers();
    const core = new FakeCore().seedTurns(1);
    core.failNext = new Error("down");
    const { controller } = setup(core);
    await controller.start();
    expect(entry().phase).toBe("error");
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(entry().phase).toBe("ready");
    expect(core.calls).toEqual(["open", "open"]);
  });
});

describe("frame batching", () => {
  it("commits 100 frames of one animation frame once", async () => {
    const core = new FakeCore().seedTurns(1);
    const { controller } = setup(core);
    await ready(controller);
    const commit = vi.spyOn(useTimelineStore.getState(), "commit");
    useTimelineStore.setState({ commit });
    let expected = "a0";
    for (let i = 0; i < 100; i++) {
      core.deliver(core.emit(append(0, "a:0:0", `${i % 10}`)));
      expected += `${i % 10}`;
    }
    expect(frames.requests).toBe(1);
    expect(textOf("a:0:0")).toBe("a0");
    frames.runFrame();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(textOf("a:0:0")).toBe(expected);
    expect(core.calls).toEqual(["open"]);
  });

  it("keeps the order array when a frame only streams text", async () => {
    const core = new FakeCore().seedTurns(2);
    const { controller } = setup(core);
    await ready(controller);
    const before = entry().order;
    core.deliver(core.emit(append(0, "a:1:0", "x")));
    frames.runFrame();
    expect(entry().order).toBe(before);
    core.deliver(core.emit(put(0, assistant(2, "new"))));
    frames.runFrame();
    expect(entry().order).not.toBe(before);
    expect(entry().order.at(-1)).toBe("a:2:0");
    expect(entry().turns.at(-1)?.turn).toBe(2);
  });
});

describe("dedupe, order and gaps", () => {
  it("drops duplicate frames", async () => {
    const core = new FakeCore().seedTurns(1);
    const { controller } = setup(core);
    await ready(controller);
    const f = core.emit(append(0, "a:0:0", "x"));
    core.deliver(f);
    core.deliver(f);
    core.deliver(f);
    frames.runFrame();
    expect(textOf("a:0:0")).toBe("a0x");
    expect(core.calls).toEqual(["open"]);
  });

  it("restores order of frames arriving out of order inside one animation frame", async () => {
    const core = new FakeCore().seedTurns(1);
    const { controller } = setup(core);
    await ready(controller);
    const f1 = core.emit(append(0, "a:0:0", "1"));
    const f2 = core.emit(append(0, "a:0:0", "2"));
    const f3 = core.emit(append(0, "a:0:0", "3"));
    core.deliver(f3);
    core.deliver(f1);
    core.deliver(f2);
    frames.runFrame();
    expect(textOf("a:0:0")).toBe("a0123");
    expect(core.calls).toEqual(["open"]);
  });

  it("syncs after the local seq when a frame is missing, then converges", async () => {
    const core = new FakeCore().seedTurns(1);
    const { controller } = setup(core);
    await ready(controller);
    const seqBefore = entry().seq;
    core.emit(append(0, "a:0:0", "lost"));
    core.deliver(core.emit(append(0, "a:0:0", "kept")));
    frames.runFrame();
    await vi.waitFor(() => expect(core.calls).toContain(`sync:${seqBefore}`));
    await vi.waitFor(() => expect(textOf("a:0:0")).toBe("a0lostkept"));
    expect(entry().seq).toBe(core.state.seq);
    expect(core.calls.filter((c) => c === "open")).toHaveLength(1);
  });

  it("does not re-apply a frame that a concurrent sync already covered", async () => {
    const core = new FakeCore().seedTurns(1);
    const { controller } = setup(core);
    await ready(controller);
    const seqBefore = entry().seq;
    core.emit(append(0, "a:0:0", "A"));
    const late = core.emit(append(0, "a:0:0", "B"));
    core.deliver(late);
    frames.runFrame();
    await vi.waitFor(() => expect(textOf("a:0:0")).toBe("a0AB"));
    core.deliver(late);
    frames.runFrame();
    expect(textOf("a:0:0")).toBe("a0AB");
    expect(core.calls).toEqual(["open", `sync:${seqBefore}`]);
  });

  it("ignores frames of other timelines", async () => {
    const core = new FakeCore().seedTurns(1);
    const { controller } = setup(core);
    await ready(controller);
    const other = frame(0, 99, [put(1, assistant(5))], "someone-else");
    core.deliver(other);
    expect(frames.pending).toBe(false);
  });
});

describe("cache first", () => {
  it("renders the cache, then syncs without calling open", async () => {
    const core = new FakeCore().seedTurns(4);
    const cache = createTimelineCache(createMemoryBackend());
    vi.useFakeTimers();
    const first = setup(core, cache).controller;
    await ready(first);
    first.dispose();
    expect(entry).toBeDefined();
    const seqAtCache = core.state.seq;
    core.emit(append(0, "a:3:0", "+"));
    core.emit(put(0, assistant(4, "fresh")));
    vi.useRealTimers();

    const second = setup(core, cache).controller;
    const booting = second.start();
    // 缓存先显示：基线（sync）返回之前就已经有内容。
    await vi.waitFor(() => expect(entry().order.length).toBeGreaterThan(0));
    await booting;
    expect(core.calls).toEqual(["open", `sync:${seqAtCache}`]);
    expect(textOf("a:3:0")).toBe("a3+");
    expect(entry().order.at(-1)).toBe("a:4:0");
    expect(entry().fromCache).toBe(false);
  });

  it("marks cache content as unconfirmed until sync returns", async () => {
    const core = new FakeCore().seedTurns(2);
    const cache = createTimelineCache(createMemoryBackend());
    vi.useFakeTimers();
    const first = setup(core, cache).controller;
    await ready(first);
    first.dispose();
    vi.useRealTimers();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = core.transport.sync;
    core.transport.sync = async (id, after) => {
      await gate;
      return original(id, after);
    };
    const second = setup(core, cache).controller;
    const booting = second.start();
    await vi.waitFor(() => expect(entry().fromCache).toBe(true));
    expect(entry().order).toHaveLength(4);
    release();
    await booting;
    expect(entry().fromCache).toBe(false);
  });

  it("persists the cache after a throttled delay", async () => {
    const core = new FakeCore().seedTurns(2);
    const cache = createTimelineCache(createMemoryBackend());
    vi.useFakeTimers();
    const { controller } = setup(core, cache);
    await controller.start();
    expect(await cache.load(SOURCE_ID, TIMELINE_ID)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_500);
    const saved = await cache.load(SOURCE_ID, TIMELINE_ID);
    expect(saved?.seq).toBe(core.state.seq);
    expect(saved?.items).toHaveLength(4);
  });

  it("clears the cache and reopens when head_seq went backwards", async () => {
    const core = new FakeCore().seedTurns(3);
    const cache = createTimelineCache(createMemoryBackend());
    vi.useFakeTimers();
    const first = setup(core, cache).controller;
    await ready(first);
    first.dispose();
    vi.useRealTimers();
    // core 的库回退：新状态的 seq 比缓存里的小。
    const restarted = new FakeCore().seedTurns(1);
    const second = setup(restarted, cache).controller;
    await second.start();
    expect(restarted.calls).toEqual([`sync:6`, "open"]);
    expect(entry().seq).toBe(restarted.state.seq);
    expect(entry().order).toHaveLength(2);
    expect(entry().turns).toHaveLength(1);
  });

  it("reopens when a result's headSeq is behind without an error code", async () => {
    const core = new FakeCore().seedTurns(3);
    const { controller } = setup(core);
    await ready(controller);
    core.state = new FakeCore().seedTurns(1).state;
    core.reconnect();
    await vi.waitFor(() => expect(core.calls).toContain("open"));
    await vi.waitFor(() => expect(entry().order).toHaveLength(2));
    expect(core.calls.filter((c) => c === "open")).toHaveLength(2);
  });
});

describe("reconnect", () => {
  it("syncs once from the local seq and fills in what was missed", async () => {
    const core = new FakeCore().seedTurns(1);
    const { controller } = setup(core);
    await ready(controller);
    const seq = entry().seq;
    core.emit(append(0, "a:0:0", " offline"));
    core.emit(put(0, assistant(1, "while away")));
    core.reconnect();
    await vi.waitFor(() => expect(textOf("a:1:0")).toBe("while away"));
    expect(textOf("a:0:0")).toBe("a0 offline");
    expect(core.calls).toEqual(["open", `sync:${seq}`]);
  });
});

describe("paging", () => {
  it("loads older turns before the oldest loaded one and ends when exhausted", async () => {
    const core = new FakeCore().seedTurns(10);
    const { controller } = setup(core);
    await ready(controller);
    expect(await controller.loadMore()).toBe(10);
    expect(core.calls.at(-1)).toBe("page:7");
    expect(entry().oldestLoadedTurn).toBe(2);
    expect(entry().hasMore).toBe(true);
    expect(entry().order).toHaveLength(16);
    expect(entry().order[0]).toBe("u:2");
    expect(await controller.loadMore()).toBe(4);
    expect(entry().oldestLoadedTurn).toBe(0);
    expect(entry().hasMore).toBe(false);
    expect(await controller.loadMore()).toBe(0);
    expect(core.calls.filter((c) => c.startsWith("page:"))).toHaveLength(2);
    expect(entry().order).toHaveLength(20);
  });

  it("shares one request between concurrent loadMore calls", async () => {
    const core = new FakeCore().seedTurns(10);
    const { controller } = setup(core);
    await ready(controller);
    await Promise.all([controller.loadMore(), controller.loadMore()]);
    expect(core.calls.filter((c) => c.startsWith("page:"))).toHaveLength(1);
  });

  it("keeps live streaming working across a page load", async () => {
    const core = new FakeCore().seedTurns(10);
    const { controller } = setup(core);
    await ready(controller);
    await controller.loadMore();
    core.deliver(core.emit(append(0, "a:9:0", "z")));
    frames.runFrame();
    expect(textOf("a:9:0")).toBe("a9z");
    expect(entry().hasMore).toBe(true);
  });

  it("reports an error without losing loaded content", async () => {
    const core = new FakeCore().seedTurns(10);
    const { controller } = setup(core);
    await ready(controller);
    core.failNext = new Error("page failed");
    expect(await controller.loadMore()).toBe(0);
    expect(entry().loadingMore).toBe(false);
    expect(entry().hasMore).toBe(true);
    expect(entry().order).toHaveLength(6);
  });
});

describe("activity and lifecycle", () => {
  it("stores the snapshot activity and ignores older revisions", async () => {
    const core = new FakeCore().seedTurns(1);
    core.currentActivity = activity(5, "thinking");
    const { controller } = setup(core);
    await ready(controller);
    const activityOf = () => useTimelineStore.getState().activities[KEY];
    expect(activityOf()?.phase).toBe("thinking");
    core.deliverActivity(activity(4, "idle"));
    expect(activityOf()?.phase).toBe("thinking");
    core.deliverActivity(activity(6, "responding"));
    expect(activityOf()?.phase).toBe("responding");
  });

  it("takes the later activity when bootId differs (core restarted)", async () => {
    const core = new FakeCore().seedTurns(1);
    core.currentActivity = activity(50, "tool");
    const { controller } = setup(core);
    await ready(controller);
    core.deliverActivity({ ...activity(1, "idle"), rev: "other:1" });
    expect(useTimelineStore.getState().activities[KEY]?.phase).toBe("idle");
  });

  it("shares one controller per timeline and disposes after the grace period", async () => {
    vi.useFakeTimers();
    const core = new FakeCore().seedTurns(1);
    const deps = {
      transport: core.transport,
      cache: createTimelineCache(null),
    };
    const a = acquireTimeline(SOURCE_ID, TIMELINE_ID, deps);
    const b = acquireTimeline(SOURCE_ID, TIMELINE_ID, deps);
    expect(a.controller).toBe(b.controller);
    await vi.advanceTimersByTimeAsync(0);
    expect(core.listeners.size).toBe(1);
    a.release();
    b.release();
    expect(core.listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(core.listeners.size).toBe(0);
    expect(useTimelineStore.getState().entries[KEY]).toBeUndefined();
  });

  it("keeps the controller when re-acquired inside the grace period", async () => {
    vi.useFakeTimers();
    const core = new FakeCore().seedTurns(1);
    const deps = {
      transport: core.transport,
      cache: createTimelineCache(null),
    };
    const a = acquireTimeline(SOURCE_ID, TIMELINE_ID, deps);
    await vi.advanceTimersByTimeAsync(0);
    a.release();
    const b = acquireTimeline(SOURCE_ID, TIMELINE_ID, deps);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(b.controller).toBe(a.controller);
    expect(core.listeners.size).toBe(1);
    expect(core.calls).toEqual(["open"]);
  });
});

describe("frames that arrive after the snapshot", () => {
  it("applies buffered frames beyond headSeq once the snapshot lands", async () => {
    const core = new FakeCore().seedTurns(1);
    const { controller } = setup(core);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = core.transport.open;
    core.transport.open = async (id, tail) => {
      const snapshot = await original(id, tail);
      await gate;
      return snapshot;
    };
    const booting = controller.start();
    await vi.waitFor(() => expect(core.calls).toContain("open"));
    core.deliver(core.emit(append(0, "a:0:0", "!")));
    release();
    await booting;
    frames.runFrame();
    expect(textOf("a:0:0")).toBe("a0!");
    expect(entry().seq).toBe(core.state.seq);
  });
});
