import { applyTimelineOps, emptyTimelineState } from "@armadra/shared";
import { beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_ENTRY,
  entryFromState,
  extendTurns,
  nextOrder,
  useTimelineStore,
} from "./store";
import { activity, append, assistant, put, user } from "./test-support";

const stateWith = (...ops: ReturnType<typeof put>[]) =>
  applyTimelineOps(emptyTimelineState(), ops).state;

beforeEach(() => useTimelineStore.getState().reset());

describe("nextOrder", () => {
  it("sorts by turn, ord and id", () => {
    const state = stateWith(
      put(1, assistant(1)),
      put(2, user(0)),
      put(3, user(1)),
    );
    expect(nextOrder([], {}, state.items)).toEqual(["u:0", "u:1", "a:1:0"]);
  });

  it("reuses the previous array when only content changed", () => {
    const first = stateWith(put(1, user(0)), put(2, assistant(0)));
    const order = nextOrder([], {}, first.items);
    const next = applyTimelineOps(first, [append(3, "a:0:0", "x")]).state;
    expect(nextOrder(order, first.items, next.items)).toBe(order);
  });

  it("resorts when an item moves or disappears", () => {
    const first = stateWith(put(1, user(0)), put(2, assistant(0)));
    const order = nextOrder([], {}, first.items);
    const moved = applyTimelineOps(first, [
      put(3, { ...assistant(0), ord: -1 }),
    ]).state;
    expect(nextOrder(order, first.items, moved.items)).toEqual([
      "a:0:0",
      "u:0",
    ]);
    const removed = applyTimelineOps(first, [
      { seq: 3, op: "remove", itemId: "u:0" },
    ]).state;
    expect(nextOrder(order, first.items, removed.items)).toEqual(["a:0:0"]);
  });
});

describe("entryFromState", () => {
  it("derives hasMore from the turn index and the oldest loaded turn", () => {
    const state = stateWith(put(1, user(2)), put(2, assistant(2)));
    const turns = [0, 1, 2].map((turn) => ({
      turnId: `t${turn}`,
      turn,
      startedAt: 0,
      headText: "",
      counts: { items: 2, tools: 0, thoughts: 0, messages: 1 },
    }));
    const partial = entryFromState(EMPTY_ENTRY, state, {
      turns,
      oldestLoadedTurn: 2,
    });
    expect(partial.hasMore).toBe(true);
    const all = entryFromState(partial, state, { oldestLoadedTurn: 0 });
    expect(all.hasMore).toBe(false);
  });

  it("adds turns that streamed in after the snapshot", () => {
    const state = stateWith(put(1, user(3)));
    const entry = entryFromState(EMPTY_ENTRY, state, {
      turns: [],
      oldestLoadedTurn: 3,
    });
    expect(entry.turns.map((turn) => turn.turn)).toEqual([3]);
    expect(extendTurns(entry.turns, [user(3)])).toBe(entry.turns);
  });
});

describe("activity", () => {
  it("keeps the newer revision and takes the later one across boots", () => {
    const { setActivity } = useTimelineStore.getState();
    setActivity("k", activity(5, "tool"));
    setActivity("k", activity(4, "idle"));
    setActivity("k", activity(5, "idle"));
    expect(useTimelineStore.getState().activities.k?.phase).toBe("tool");
    setActivity("k", activity(6, "responding"));
    expect(useTimelineStore.getState().activities.k?.phase).toBe("responding");
    setActivity("k", { ...activity(1, "sleeping"), rev: "boot2:1" });
    expect(useTimelineStore.getState().activities.k?.phase).toBe("sleeping");
  });
});
