import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type TimelineItem,
  type TimelineOp,
  type TimelineState,
  acpTurnBeginOps,
  acpTurnEndOps,
  acpUpdateToOps,
  applyTimelineOps,
  applyTimelineSync,
  compactTimelineOps,
  emptyTimelineState,
  sortedTimelineItems,
  timelineChangesSince,
  timelineStateFrom,
  turnIndexOf,
} from "@armadra/shared";

import { CursorAheadError, TimelineStore } from "./store";
import {
  memoryDatabase,
  msg,
  think,
  toolCall,
  toolUpdate,
  turnCtx,
} from "./testing";

/**
 * 迁移 0052 上的存取：写入与压实、`sync(after)` 对任意游标与全量应用一致、翻页、
 * 回合索引与共享层 `turnIndexOf` 对拍。
 */

let database: DatabaseSync;
let store: TimelineStore;

beforeEach(() => {
  database = memoryDatabase();
  store = new TimelineStore(database);
  store.ensure({ id: "s1", workspaceId: "w", nodeId: "n" }, 1);
});

afterEach(() => database.close());

/** 把一个脚本化的会话（若干回合）逐批写进库，返回每批之后的内存状态。 */
function run(turns: number): { states: TimelineState[]; final: TimelineState } {
  let state = emptyTimelineState();
  const states: TimelineState[] = [];
  const flush = (ops: TimelineOp[]): void => {
    if (ops.length === 0) return;
    state = applyTimelineOps(state, ops).state;
    const compacted = compactTimelineOps(ops);
    store.apply("s1", compacted, state.seq, 100 + state.seq);
    states.push(state);
  };
  for (let turn = 1; turn <= turns; turn++) {
    const ctx = (at: number) => turnCtx(turn, turn * 1000 + at);
    const batch = (...updates: unknown[]): TimelineOp[] => {
      const ops: TimelineOp[] = [];
      let local = state;
      for (const update of updates) {
        const part = acpUpdateToOps(local, update, ctx(ops.length));
        local = applyTimelineOps(local, part).state;
        ops.push(...part);
      }
      return ops;
    };
    flush(acpTurnBeginOps(state, ctx(0), { text: `问题 ${turn}` }));
    flush(batch(think("想一想"), think("再想")));
    flush(batch(toolCall(`c${turn}`, { title: "读文件" })));
    flush(batch(msg("答"), msg("复"), msg(` ${turn}`)));
    flush(
      batch(
        toolUpdate(`c${turn}`, {
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "ok" } }],
        }),
      ),
    );
    flush(
      batch({ sessionUpdate: "usage_update", used: turn * 10, size: 1000 }),
    );
    flush(acpTurnEndOps(state, ctx(9), { stopReason: "end_turn" }));
  }
  return { states, final: state };
}

const allItems = (state: TimelineState): TimelineItem[] =>
  sortedTimelineItems(state);

describe("TimelineStore.ensure", () => {
  it("幂等，归属以第一次为准", () => {
    store.ensure({ id: "s1", workspaceId: "other", nodeId: "other" }, 99);
    expect(store.get("s1")).toMatchObject({
      workspaceId: "w",
      nodeId: "n",
      headSeq: 0,
      createdAtMs: 1,
    });
  });
});

describe("TimelineStore.apply", () => {
  it("put / append / remove / head 落到最新完整值，head_seq 推到批末", () => {
    const { final } = run(2);
    const row = store.get("s1");
    expect(row?.headSeq).toBe(final.seq);
    expect(row?.headRev).toBe(final.headRev);
    expect(row?.head).toEqual(final.head);
    const synced = store.sync("s1", 0);
    expect(synced?.items).toHaveLength(Object.keys(final.items).length);
    const state = applyTimelineSync(emptyTimelineState(), synced!);
    expect(state.items).toEqual(final.items);
    expect(state.seq).toBe(final.seq);
  });

  it("已经被更新的 rev 盖过的操作不生效（重放无害）", () => {
    const { final } = run(1);
    const before = JSON.stringify(store.sync("s1", 0));
    const stale: TimelineOp[] = Object.values(final.items).map((item, i) => ({
      seq: i + 1,
      op: "put",
      item: { ...item, rev: i + 1 },
    }));
    store.apply("s1", stale, final.seq, 1);
    expect(JSON.stringify(store.sync("s1", 0))).toBe(before);
    expect(store.get("s1")?.headSeq).toBe(final.seq);
  });

  it("remove 留墓碑，之后 sync 把删除传出去；更晚的 put 让它复活", () => {
    run(1);
    const head = store.get("s1")!.headSeq;
    store.apply(
      "s1",
      [{ seq: head + 1, op: "remove", itemId: "u:t1" }],
      head + 1,
      1,
    );
    const after = store.sync("s1", head);
    expect(after?.items).toEqual([
      { id: "u:t1", rev: head + 1, deleted: true },
    ]);
    expect(store.tailItems("s1", 5).some((i) => i.id === "u:t1")).toBe(false);
    const revived: TimelineItem = {
      id: "u:t1",
      turn: 1,
      ord: 1,
      rev: head + 2,
      source: "acp",
      at: 1,
      gen: 1,
      kind: "user",
      text: "回来了",
    };
    store.apply(
      "s1",
      [{ seq: head + 2, op: "put", item: revived }],
      head + 2,
      1,
    );
    expect(store.sync("s1", head + 1)?.items).toEqual([revived]);
  });

  it("append 到不存在或已删的条目静默跳过", () => {
    store.apply(
      "s1",
      [{ seq: 1, op: "append", itemId: "nope", delta: { text: "x" } }],
      1,
      1,
    );
    expect(store.sync("s1", 0)?.items).toEqual([]);
    expect(store.get("s1")?.headSeq).toBe(1);
  });

  it("一批里出错整批回滚", () => {
    run(1);
    const before = JSON.stringify(store.sync("s1", 0));
    const bad = {
      seq: 99,
      op: "put",
      item: { id: "x" },
    } as unknown as TimelineOp;
    expect(() => store.apply("s1", [bad], 99, 1)).toThrow();
    expect(JSON.stringify(store.sync("s1", 0))).toBe(before);
    // 回滚后还能继续写（没有悬着的事务）。
    expect(() => store.apply("s1", [], 99, 1)).not.toThrow();
    store.apply("s1", [{ seq: 100, op: "head", head: { title: "t" } }], 100, 1);
    expect(store.get("s1")?.head.title).toBe("t");
  });

  it("时间线不存在时抛错，不留悬着的事务", () => {
    expect(() =>
      store.apply("nope", [{ seq: 1, op: "head", head: { title: "x" } }], 1, 1),
    ).toThrow();
    store.apply("s1", [{ seq: 1, op: "head", head: { title: "y" } }], 1, 1);
    expect(store.get("s1")?.head.title).toBe("y");
  });
});

describe("TimelineStore.sync", () => {
  it("对任意游标：从那个游标的状态补增量，等于全量应用", () => {
    const { states, final } = run(4);
    const full = applyTimelineSync(emptyTimelineState(), store.sync("s1", 0)!);
    expect(full.items).toEqual(final.items);
    for (const mid of states) {
      const caught = applyTimelineSync(mid, store.sync("s1", mid.seq)!);
      expect(caught.items).toEqual(final.items);
      expect(caught.head).toEqual(final.head);
      expect(caught.seq).toBe(final.seq);
    }
  });

  it("与共享层的参考实现 timelineChangesSince 逐游标一致", () => {
    const { final } = run(3);
    for (let after = 0; after <= final.seq; after += 3) {
      const mine = store.sync("s1", after)!;
      const reference = timelineChangesSince(final, after);
      expect(mine.headSeq).toBe(reference.headSeq);
      expect(mine.items.map((i) => `${i.id}@${i.rev}`)).toEqual(
        reference.items.map((i) => `${i.id}@${i.rev}`),
      );
      expect(mine.head).toEqual(reference.head);
    }
  });

  it("头部值只在变过之后才带", () => {
    const { final } = run(1);
    expect(store.sync("s1", 0)?.head).toBeDefined();
    expect(store.sync("s1", final.seq)?.head).toBeUndefined();
    expect(store.sync("s1", final.seq)?.items).toEqual([]);
  });

  it("游标比 head_seq 还大答 CursorAheadError，没有这条时间线答 undefined", () => {
    const { final } = run(1);
    expect(() => store.sync("s1", final.seq + 1)).toThrow(CursorAheadError);
    expect(store.sync("nope", 0)).toBeUndefined();
  });
});

describe("TimelineStore 读取", () => {
  it("snapshot 带尾部 N 个回合、全部回合的索引，且与 turnIndexOf 对拍", () => {
    const { final } = run(6);
    const snapshot = store.snapshot("s1", 2)!;
    expect(snapshot.headSeq).toBe(final.seq);
    expect(new Set(snapshot.items.map((i) => i.turn))).toEqual(new Set([5, 6]));
    expect(snapshot.turns).toEqual(turnIndexOf(Object.values(final.items)));
    expect(snapshot.turns).toHaveLength(6);
    expect(snapshot.turns[0]?.headText).toBe("问题 1");
  });

  it("page 取 beforeTurn 之前的若干回合，按显示顺序", () => {
    run(8);
    const page = store.page("s1", 6, 3)!;
    expect([...new Set(page.map((i) => i.turn))]).toEqual([3, 4, 5]);
    expect(page.map((i) => `${i.turn}.${i.ord}`)).toEqual(
      [...page]
        .sort((a, b) => a.turn - b.turn || a.ord - b.ord)
        .map((i) => `${i.turn}.${i.ord}`),
    );
    expect(store.page("s1", 1, 5)).toEqual([]);
    expect(store.page("nope", 6)).toBeUndefined();
  });

  it("loadState 还原序号、头部值和尾部回合，可以接着写", () => {
    const { final } = run(5);
    const loaded = store.loadState("s1", 2);
    expect(loaded.seq).toBe(final.seq);
    expect(loaded.head).toEqual(final.head);
    expect(Object.values(loaded.items).every((i) => i.turn >= 4)).toBe(true);
    const next = acpUpdateToOps(loaded, msg("续"), turnCtx(5, 9_000));
    expect(next[0]?.seq).toBe(final.seq + 1);
    expect(store.maxTurn("s1")).toBe(5);
  });

  it("从库里读回的条目与内存状态逐字段相等（含 rev）", () => {
    const { final } = run(2);
    const restored = timelineStateFrom({
      headSeq: final.seq,
      items: store.tailItems("s1", 10),
    });
    expect(restored.items).toEqual(final.items);
    expect(allItems(restored)).toEqual(allItems(final));
  });
});

describe("TimelineStore 清理", () => {
  it("remove 连条目一起删；orphans 只列节点已不在库里且够旧的", () => {
    run(1);
    expect(store.orphans(Number.MAX_SAFE_INTEGER)).toEqual(["s1"]);
    expect(store.orphans(0)).toEqual([]);
    store.remove("s1");
    expect(store.get("s1")).toBeUndefined();
    expect(
      database.prepare("SELECT COUNT(*) AS n FROM timeline_items").get(),
    ).toEqual({ n: 0 });
  });
});
