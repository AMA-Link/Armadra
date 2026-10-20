import { describe, expect, it } from "vitest";
import {
  type TimelineItem,
  type TimelineOp,
  type TimelineState,
  activityGroups,
  applyTimelineFrame,
  applyTimelineOps,
  applyTimelineSync,
  compactTimelineOps,
  emptyTimelineState,
  mergeStreamChunk,
  mergeToolCall,
  sortedTimelineItems,
  timelineChangesSince,
  timelineStateFrom,
  turnIndexOf,
} from "../src/index.js";
import {
  assistant,
  notice,
  rng,
  thought,
  tool,
  user,
} from "./timeline-fixtures.js";

const put = (seq: number, item: TimelineItem): TimelineOp => ({
  seq,
  op: "put",
  item,
});
const append = (seq: number, itemId: string, text: string): TimelineOp => ({
  seq,
  op: "append",
  itemId,
  delta: { text },
});

function run(ops: TimelineOp[], from = emptyTimelineState()): TimelineState {
  return applyTimelineOps(from, ops).state;
}

function textOf(state: TimelineState, id: string): string {
  const item = state.items[id];
  if (item?.kind === "assistant") {
    return item.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  }
  return item?.kind === "thought" || item?.kind === "user" ? item.text : "";
}

describe("applyTimelineOps", () => {
  it("put 的 rev 等于操作序号，append 接在最后一个文本部件上", () => {
    const state = run([
      put(1, assistant("a:1:1", 1, 1, "he")),
      append(2, "a:1:1", "llo"),
    ]);
    expect(textOf(state, "a:1:1")).toBe("hello");
    expect(state.items["a:1:1"]?.rev).toBe(2);
    expect(state.seq).toBe(2);
  });

  it("传入顺序不要紧，按序号排序后应用", () => {
    const state = run([
      append(2, "a:1:1", "b"),
      put(1, assistant("a:1:1", 1, 1, "a")),
    ]);
    expect(textOf(state, "a:1:1")).toBe("ab");
  });

  it("重放同一批操作无害（条目级幂等）", () => {
    const ops = [put(1, assistant("a", 1, 1, "x")), append(2, "a", "y")];
    const once = run(ops);
    const twice = run(ops, once);
    expect(twice).toEqual(once);
  });

  it("迟到的旧 put 不会盖掉新值，墓碑挡住删除之后的旧 put", () => {
    const state = run([put(5, user("u", 1, 1, "new"))]);
    expect(run([put(3, user("u", 1, 1, "old"))], state).items.u).toMatchObject({
      text: "new",
      rev: 5,
    });
    const removed = run([
      put(1, user("u", 1, 1)),
      { seq: 2, op: "remove", itemId: "u" },
    ]);
    expect(removed.items.u).toBeUndefined();
    expect(removed.tombstones.u).toBe(2);
    expect(run([put(1, user("u", 1, 1))], removed).items.u).toBeUndefined();
    // 删除之后更新的 put 可以让它复活，并清掉墓碑。
    const revived = run([put(9, user("u", 1, 1, "again"))], removed);
    expect(revived.items.u).toBeDefined();
    expect(revived.tombstones.u).toBeUndefined();
  });

  it("append 的目标不在本地：计入 orphans；目标已被删：不算", () => {
    expect(
      applyTimelineOps(emptyTimelineState(), [append(1, "zz", "x")]).orphans,
    ).toBe(1);
    const removed = run([{ seq: 4, op: "remove", itemId: "zz" }]);
    expect(applyTimelineOps(removed, [append(5, "zz", "x")]).orphans).toBe(0);
  });

  it("append 到不收文本的条目被忽略；指定部件下标", () => {
    const base = run([put(1, tool("c", 1, 1))]);
    expect(applyTimelineOps(base, [append(2, "tool:c", "x")]).applied).toBe(0);
    const parts = assistant("a", 1, 1, "t");
    parts.parts.push(
      { type: "resource_link", uri: "u", name: "n" },
      { type: "text", text: "z" },
    );
    const state = run([
      put(1, parts),
      { seq: 2, op: "append", itemId: "a", delta: { text: "!", part: 0 } },
      append(3, "a", "?"),
    ]);
    const item = state.items.a;
    expect(
      item?.kind === "assistant" &&
        item.parts.map((p) => (p.type === "text" ? p.text : p.type)),
    ).toEqual(["t!", "resource_link", "z?"]);
  });

  it("head 合并，null 清掉字段，旧序号不生效", () => {
    const state = run([
      { seq: 1, op: "head", head: { title: "a", usage: { used: 1, size: 2 } } },
      { seq: 2, op: "head", head: { title: null } },
      { seq: 1, op: "head", head: { title: "stale" } },
    ]);
    expect(state.head).toEqual({ title: null, usage: { used: 1, size: 2 } });
    expect(state.headRev).toBe(2);
  });
});

describe("applyTimelineFrame", () => {
  const frame = (from: number, to: number, ops: TimelineOp[]) => ({
    from,
    to,
    ops,
  });

  it("顺序帧应用，重复帧丢弃，缺口帧要求同步", () => {
    let state = emptyTimelineState();
    const f1 = frame(0, 1, [put(1, user("u", 1, 1))]);
    const f2 = frame(1, 2, [append(2, "u", "!")]);
    const f3 = frame(2, 3, [append(3, "u", "?")]);
    const r1 = applyTimelineFrame(state, f1);
    expect(r1.outcome).toBe("applied");
    state = r1.state;
    expect(applyTimelineFrame(state, f1).outcome).toBe("duplicate");
    const gap = applyTimelineFrame(state, f3);
    expect(gap.outcome).toBe("gap");
    expect(gap.syncAfter).toBe(1);
    expect(gap.state).toBe(state);
    state = applyTimelineFrame(state, f2).state;
    state = applyTimelineFrame(state, f3).state;
    expect(textOf(state, "u")).toBe("hi!?");
    expect(state.seq).toBe(3);
  });

  it("交叠帧（本地已经走过一部分）也应用，已有的部分不重复", () => {
    let state = run([put(1, user("u", 1, 1, "a")), append(2, "u", "b")]);
    const overlap = frame(1, 3, [append(2, "u", "b"), append(3, "u", "c")]);
    const result = applyTimelineFrame(state, overlap);
    expect(result.outcome).toBe("applied");
    state = result.state;
    expect(textOf(state, "u")).toBe("abc");
    expect(state.seq).toBe(3);
  });

  it("空帧也把 seq 推到 to", () => {
    const next = applyTimelineFrame(
      emptyTimelineState(),
      frame(0, 4, []),
    ).state;
    expect(next.seq).toBe(4);
  });
});

describe("applyTimelineSync / timelineChangesSince", () => {
  it("只带 rev 大于游标的条目和墓碑，头部值变了才带", () => {
    const server = run([
      put(1, user("u1", 1, 1)),
      put(2, user("u2", 1, 2)),
      { seq: 3, op: "remove", itemId: "u1" },
      { seq: 4, op: "head", head: { title: "t" } },
    ]);
    const all = timelineChangesSince(server, 0);
    expect(all.items.map((i) => i.id).sort()).toEqual(["u1", "u2"]);
    expect(all.head).toEqual({ title: "t" });
    const tail = timelineChangesSince(server, 3);
    expect(tail.items).toEqual([]);
    expect(tail.head).toEqual({ title: "t" });
    expect(timelineChangesSince(server, 4).head).toBeUndefined();
    expect(timelineChangesSince(server, 4).headSeq).toBe(4);
  });

  it("同步把删除传出去，且迟到的旧应答不会倒退", () => {
    const server = run([put(1, user("u1", 1, 1)), put(2, user("u2", 1, 2))]);
    let client = applyTimelineSync(
      emptyTimelineState(),
      timelineChangesSince(server, 0),
    );
    expect(Object.keys(client.items).sort()).toEqual(["u1", "u2"]);
    const later = run([{ seq: 3, op: "remove", itemId: "u1" }], server);
    client = applyTimelineSync(client, timelineChangesSince(later, client.seq));
    expect(client.items.u1).toBeUndefined();
    expect(client.seq).toBe(3);
    const stale = applyTimelineSync(client, timelineChangesSince(server, 0));
    expect(stale.items.u1).toBeUndefined();
    expect(stale.seq).toBe(3);
  });

  it("timelineStateFrom 用快照恢复，之后的帧接得上", () => {
    const server = run([put(1, user("u", 1, 1)), append(2, "u", "x")]);
    const snapshot = timelineStateFrom({
      headSeq: server.seq,
      items: Object.values(server.items),
    });
    const next = applyTimelineFrame(snapshot, {
      from: 2,
      to: 3,
      ops: [append(3, "u", "y")],
    });
    expect(next.outcome).toBe("applied");
    expect(textOf(next.state, "u")).toBe("hix" + "y");
  });
});

/* ------------------------------ 性质测试 ------------------------------ */

interface Script {
  readonly frames: { from: number; to: number; ops: TimelineOp[] }[];
  readonly states: TimelineState[];
}

/** 随机脚本：服务端一步一个操作，再随机切成帧。 */
function script(seed: number): Script {
  const random = rng(seed);
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(random() * list.length)] as T;
  let server = emptyTimelineState();
  const ops: TimelineOp[] = [];
  let counter = 0;
  const steps = 8 + Math.floor(random() * 40);
  for (let i = 0; i < steps; i++) {
    const seq = server.seq + 1;
    const ids = Object.keys(server.items);
    const roll = random();
    let op: TimelineOp;
    if (roll < 0.3 || ids.length === 0) {
      counter++;
      const turn = 1 + Math.floor(counter / 5);
      const kind = pick([
        "user",
        "assistant",
        "thought",
        "tool",
        "notice",
      ] as const);
      const id = `${kind}-${counter}`;
      const item =
        kind === "user"
          ? user(id, turn, counter)
          : kind === "assistant"
            ? assistant(id, turn, counter, `t${counter}`)
            : kind === "thought"
              ? thought(id, turn, counter, `h${counter}`)
              : kind === "tool"
                ? tool(id, turn, counter)
                : notice(id, turn, counter);
      op = put(seq, item);
    } else if (roll < 0.65) {
      const textual = ids.filter((id) => /^(user|assistant|thought)/.test(id));
      op =
        textual.length > 0
          ? append(seq, pick(textual), `+${seq}`)
          : { seq, op: "head", head: { title: `T${seq}` } };
    } else if (roll < 0.8) {
      const id = pick(ids);
      const current = server.items[id] as TimelineItem;
      op = put(
        seq,
        current.kind === "tool"
          ? { ...current, status: "completed", title: `x${seq}` }
          : { ...current },
      );
    } else if (roll < 0.9) {
      op = { seq, op: "remove", itemId: pick(ids) };
    } else {
      op = {
        seq,
        op: "head",
        head: { title: `T${seq}`, usage: { used: seq, size: 1000 } },
      };
    }
    server = applyTimelineOps(server, [op]).state;
    ops.push(op);
  }
  // 切帧，同时记下每个帧边界上的服务端状态（同步应答可以取任意一个）。
  const frames: Script["frames"] = [];
  const states: TimelineState[] = [];
  let cursor = 0;
  let replay = emptyTimelineState();
  while (cursor < ops.length) {
    const size = 1 + Math.floor(random() * 4);
    const slice = ops.slice(cursor, cursor + size);
    frames.push({ from: cursor, to: cursor + slice.length, ops: slice });
    replay = applyTimelineOps(replay, slice).state;
    states.push(replay);
    cursor += slice.length;
  }
  return { frames, states };
}

function projection(state: TimelineState) {
  return {
    seq: state.seq,
    head: state.head,
    items: sortedTimelineItems(state),
  };
}

describe("性质：重复、乱序、丢帧最终收敛", () => {
  it("1000 组随机投递，客户端与服务端最终一致", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const { frames, states } = script(seed);
      const random = rng(seed * 7919);
      const delivered: typeof frames = [];
      for (const frame of frames) {
        if (random() < 0.2) continue;
        delivered.push(frame);
        if (random() < 0.35) delivered.push(frame);
      }
      for (let i = delivered.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [delivered[i], delivered[j]] = [
          delivered[j] as never,
          delivered[i] as never,
        ];
      }
      let client = emptyTimelineState();
      for (const frame of delivered) {
        const result = applyTimelineFrame(client, frame);
        client = result.state;
        if (result.outcome === "gap") {
          // 应答来自某个不早于客户端游标的服务端状态。
          const candidates = states.filter((s) => s.seq >= client.seq);
          const reply = candidates[Math.floor(random() * candidates.length)];
          if (reply !== undefined) {
            client = applyTimelineSync(
              client,
              timelineChangesSince(reply, client.seq),
            );
          }
        }
      }
      const server = states[states.length - 1] as TimelineState;
      if (client.seq < server.seq) {
        client = applyTimelineSync(
          client,
          timelineChangesSince(server, client.seq),
        );
      }
      expect(projection(client), `seed ${seed}`).toEqual(projection(server));
    }
  });

  it("按序投递一次与随便怎么重放，结果相同", () => {
    for (let seed = 2000; seed < 2100; seed++) {
      const { frames, states } = script(seed);
      let once = emptyTimelineState();
      for (const frame of frames) once = applyTimelineFrame(once, frame).state;
      expect(projection(once)).toEqual(
        projection(states[states.length - 1] as TimelineState),
      );
      let replayed = once;
      for (const frame of frames)
        replayed = applyTimelineFrame(replayed, frame).state;
      expect(replayed).toEqual(once);
    }
  });

  it("压实后的操作与原操作得到同一个状态", () => {
    for (let seed = 3000; seed < 3200; seed++) {
      const { frames } = script(seed);
      const ops = frames.flatMap((frame) => frame.ops);
      const compact = compactTimelineOps(ops);
      expect(compact.length).toBeLessThanOrEqual(ops.length);
      expect(run(compact), `seed ${seed}`).toEqual(run(ops));
    }
  });
});

describe("compactTimelineOps", () => {
  it("相邻 append 合并，append 并进 put，被覆盖的丢弃", () => {
    const ops = [
      put(1, assistant("a", 1, 1, "x")),
      append(2, "a", "y"),
      append(3, "a", "z"),
      { seq: 4, op: "head" as const, head: { title: "1" } },
      { seq: 5, op: "head" as const, head: { title: "2" } },
      put(6, user("u", 1, 2)),
      { seq: 7, op: "remove" as const, itemId: "u" },
    ];
    const compact = compactTimelineOps(ops);
    expect(compact.map((op) => `${op.seq}${op.op}`)).toEqual([
      "3put",
      "5head",
      "7remove",
    ]);
    expect(textOf(run(compact), "a")).toBe("xyz");
  });
});

/* ----------------------------- 流式文本合并 ----------------------------- */

describe("mergeStreamChunk", () => {
  const long = "0123456789abcdefXYZ";
  it("续写：追加", () => {
    expect(mergeStreamChunk("ab", "cd")).toEqual({
      text: "abcd",
      mode: "append",
    });
    expect(mergeStreamChunk("", "cd")).toEqual({ text: "cd", mode: "append" });
  });
  it("快照式分块：以已有文本开头就整体替换", () => {
    expect(mergeStreamChunk(long, long + " tail more text")).toEqual({
      text: long + " tail more text",
      mode: "snapshot",
    });
  });
  it("重复：已有文本以新块结尾，或新块就是已有文本", () => {
    const text = "head " + long;
    expect(mergeStreamChunk(text, long)).toEqual({ text, mode: "duplicate" });
    expect(mergeStreamChunk(long, long)).toEqual({
      text: long,
      mode: "duplicate",
    });
    expect(mergeStreamChunk("x", "")).toEqual({ text: "x", mode: "duplicate" });
  });
  it("短块（真实的重复 token）一律追加，不被当成重复", () => {
    expect(mergeStreamChunk("a\n", "\n").text).toBe("a\n\n");
    expect(mergeStreamChunk("ha", "ha").text).toBe("haha");
    expect(mergeStreamChunk("--", "--").text).toBe("----");
  });
  it("阈值可调", () => {
    expect(mergeStreamChunk("ha", "ha", 2).mode).toBe("duplicate");
  });
});

/* ------------------------------ 工具调用合并 ------------------------------ */

describe("mergeToolCall", () => {
  it("第一次：取补丁的字段，缺的给默认值", () => {
    const fields = mergeToolCall(
      undefined,
      { title: "Read a", toolKind: "read" },
      10,
    );
    expect(fields).toMatchObject({
      toolKind: "read",
      title: "Read a",
      status: "pending",
      content: [],
      locations: [],
      startedAt: 10,
    });
    expect(fields.endedAt).toBeUndefined();
  });
  it("content 整体替换，没带的字段保留，空标题不覆盖", () => {
    const first = tool("c", 1, 1, {
      title: "T",
      content: [{ type: "text", text: "a" }],
      locations: [{ path: "/x" }],
    });
    const next = mergeToolCall(
      first,
      { title: "", content: [{ type: "text", text: "b" }] },
      20,
    );
    expect(next.title).toBe("T");
    expect(next.content).toEqual([{ type: "text", text: "b" }]);
    expect(next.locations).toEqual([{ path: "/x" }]);
    expect(mergeToolCall(first, {}, 20).content).toEqual(first.content);
  });
  it("状态只前进不后退，终态之后不再变，第一次到终态记 endedAt", () => {
    const running = tool("c", 1, 1, { status: "in_progress", startedAt: 5 });
    expect(mergeToolCall(running, { status: "pending" }, 9).status).toBe(
      "in_progress",
    );
    const done = mergeToolCall(running, { status: "completed" }, 9);
    expect(done.status).toBe("completed");
    expect(done.endedAt).toBe(9);
    expect(done.startedAt).toBe(5);
    const doneItem = tool("c", 1, 1, { ...done });
    const again = mergeToolCall(
      doneItem,
      { status: "failed", title: "late" },
      30,
    );
    expect(again.status).toBe("completed");
    expect(again.endedAt).toBe(9);
    expect(again.title).toBe("late");
  });
  it("直接以终态创建（没有先 pending）也记 endedAt", () => {
    const fields = mergeToolCall(undefined, { status: "failed" }, 7);
    expect(fields.status).toBe("failed");
    expect(fields.endedAt).toBe(7);
  });
});

/* -------------------------------- 活动组 -------------------------------- */

describe("activityGroups", () => {
  it("连续的工具和思考折成一组，摘要按 kind 计数，用户消息和助手消息隔开", () => {
    const items: TimelineItem[] = [
      user("u", 1, 1),
      thought("th", 1, 2, "x", false),
      tool("r1", 1, 3, { toolKind: "read", status: "completed" }),
      tool("r2", 1, 4, { toolKind: "read", status: "completed" }),
      tool("e1", 1, 5, { toolKind: "edit", status: "failed" }),
      tool("x1", 1, 6, { toolKind: "execute", status: "completed" }),
      assistant("a", 1, 7, "done", false),
      tool("s1", 1, 8, { toolKind: "search", status: "completed" }),
    ];
    const entries = activityGroups(items);
    expect(entries.map((e) => e.type)).toEqual([
      "item",
      "group",
      "item",
      "item",
    ]);
    const group = entries[1];
    expect(group?.type === "group" && group.summary).toEqual({
      reads: 2,
      edits: 1,
      commands: 1,
      searches: 0,
      fetches: 0,
      thoughts: 1,
      others: 0,
      failed: 1,
    });
    expect(group?.type === "group" && group.id).toBe("g:th");
    expect(group?.type === "group" && group.running).toBe(false);
  });

  it("有工具没结束或思考在流时 running；id 随成员追加不变", () => {
    const base: TimelineItem[] = [
      tool("a", 1, 1, { status: "completed" }),
      tool("b", 1, 2, { status: "in_progress" }),
    ];
    const first = activityGroups(base)[0];
    expect(first?.type === "group" && first.running).toBe(true);
    const more = activityGroups([...base, thought("t", 1, 3, "", true)])[0];
    expect(more?.type === "group" && more.id).toBe(
      first?.type === "group" && first.id,
    );
    const streaming = activityGroups([
      tool("a", 1, 1, { status: "completed" }),
      thought("t", 1, 2, "x", true),
    ])[0];
    expect(streaming?.type === "group" && streaming.running).toBe(true);
  });

  it("单个成员不折叠（minRun 可调），跨回合不连成一组", () => {
    expect(activityGroups([tool("a", 1, 1)]).map((e) => e.type)).toEqual([
      "item",
    ]);
    expect(
      activityGroups([tool("a", 1, 1)], { minRun: 1 }).map((e) => e.type),
    ).toEqual(["group"]);
    const across = activityGroups([tool("a", 1, 9), tool("b", 2, 1)]);
    expect(across.map((e) => e.type)).toEqual(["item", "item"]);
  });

  it("子代理内部的调用挂在它下面，不进顶层", () => {
    const items: TimelineItem[] = [
      tool("sub", 1, 1, { toolKind: "subagent", status: "in_progress" }),
      tool("c1", 1, 2, { parentToolCallId: "sub" }),
      tool("c2", 1, 3, { parentToolCallId: "sub" }),
      tool("lost", 1, 4, { parentToolCallId: "missing" }),
    ];
    const entries = activityGroups(items);
    expect(entries).toHaveLength(1);
    const group = entries[0];
    expect(group?.type === "group" && group.items.map((i) => i.id)).toEqual([
      "tool:sub",
      "tool:lost",
    ]);
    const solo = activityGroups(items.slice(0, 3));
    expect(
      solo[0]?.type === "item" && solo[0].children?.map((c) => c.id),
    ).toEqual(["tool:c1", "tool:c2"]);
  });
});

describe("turnIndexOf", () => {
  it("按回合数条目，取第一句用户消息的前 80 个字符", () => {
    const long = "字".repeat(100);
    const index = turnIndexOf([
      user("u1", 1, 1, long),
      assistant("a1", 1, 2, "x"),
      tool("t", 1, 3),
      thought("h", 1, 4, "x"),
      user("u2", 2, 1, "second"),
    ]);
    expect(index).toHaveLength(2);
    expect(index[0]).toMatchObject({
      turn: 1,
      counts: { items: 4, tools: 1, thoughts: 1, messages: 1 },
    });
    expect(Array.from(index[0]?.headText ?? "")).toHaveLength(80);
    expect(index[1]?.headText).toBe("second");
  });
});
