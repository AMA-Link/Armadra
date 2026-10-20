import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type TimelineItem,
  type TimelineOp,
  type TimelineState,
  acpTurnBeginOps,
  applyTimelineFrame,
  applyTimelineSync,
  emptyTimelineState,
  sortedTimelineItems,
} from "@armadra/shared";

import { tempDir } from "../testing/temp-dir";
import { BlobStore } from "./blobs";
import { TimelineStore } from "./store";
import {
  FakeTimers,
  memoryDatabase,
  msg,
  think,
  toolCall,
  toolUpdate,
  turnCtx,
} from "./testing";
import {
  FIRST_FLUSH_MS,
  FLUSH_INTERVAL_MS,
  SWITCH_GAP_MS,
  type TimelineFrame,
  TimelineWriter,
} from "./writer";

let database: DatabaseSync;
let store: TimelineStore;
let timers: FakeTimers;
let frames: TimelineFrame[];
let writer: TimelineWriter;

const make = (
  extra: Partial<ConstructorParameters<typeof TimelineWriter>[0]> = {},
) =>
  new TimelineWriter({
    store,
    publish: (frame) => frames.push(frame),
    timers,
    ...extra,
  });

beforeEach(() => {
  database = memoryDatabase();
  store = new TimelineStore(database);
  timers = new FakeTimers();
  frames = [];
  writer = make();
  writer.open({ timelineId: "s1", workspaceId: "w", nodeId: "n" });
});

afterEach(() => database.close());

const ctx = (turn = 1, at = timers.now()) => turnCtx(turn, at);

/** 页面的视角：只吃帧，缺口就按库补。 */
function client(): { state: TimelineState; feed(frame: TimelineFrame): void } {
  const self = {
    state: emptyTimelineState(),
    feed(frame: TimelineFrame): void {
      const result = applyTimelineFrame(self.state, frame);
      self.state = result.state;
      if (result.outcome === "gap") {
        self.state = applyTimelineSync(
          self.state,
          store.sync("s1", self.state.seq)!,
        );
      }
    },
  };
  return self;
}

describe("合并刷写", () => {
  it("窗口内的分块合成一帧：库与帧用同一份压实结果，rev 一致", () => {
    writer.turnBegin("s1", ctx(), { text: "hi" });
    frames.length = 0;
    for (const piece of ["你", "好", "，", "世", "界"]) {
      writer.acpUpdate("s1", msg(piece), ctx());
    }
    expect(frames).toHaveLength(0);
    timers.advance(FIRST_FLUSH_MS);
    expect(frames).toHaveLength(1);
    const [frame] = frames;
    // 五个分块：一个 put（首块）+ 并进它的四个 append，压实成一个 put。
    expect(frame?.ops.map((op) => op.op)).toEqual(["put"]);
    const put = frame?.ops[0] as Extract<TimelineOp, { op: "put" }>;
    expect(put.item.kind === "assistant" && put.item.parts).toEqual([
      { type: "text", text: "你好，世界" },
    ]);
    // 库里同一个条目，rev 等于帧里那条 put 的 seq，也等于内存状态里的。
    const stored = store.sync("s1", 0)!.items.find((i) => i.id === put.item.id);
    expect(stored?.rev).toBe(put.seq);
    expect((writer.state("s1")!.items[put.item.id] as TimelineItem).rev).toBe(
      put.seq,
    );
  });

  it("帧首尾相接：from 是上一帧的 to；客户端只吃帧就等于库", () => {
    const viewer = client();
    writer.turnBegin("s1", ctx(), { text: "问" });
    writer.acpUpdate("s1", think("嗯"), ctx());
    timers.advance(200);
    writer.acpUpdate("s1", toolCall("c1"), ctx());
    writer.acpUpdate("s1", toolUpdate("c1", { status: "completed" }), ctx());
    writer.acpUpdate("s1", msg("答"), ctx());
    writer.acpUpdate("s1", msg("复"), ctx());
    timers.advance(200);
    writer.turnEnd("s1", ctx(1, timers.now()), { stopReason: "end_turn" });
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]?.from).toBe(frames[i - 1]?.to);
    }
    expect(frames[0]?.from).toBe(0);
    for (const frame of frames) viewer.feed(frame);
    const reference = applyTimelineSync(
      emptyTimelineState(),
      store.sync("s1", 0)!,
    );
    expect(viewer.state.items).toEqual(reference.items);
    expect(viewer.state.seq).toBe(store.get("s1")?.headSeq);
  });

  it("下一帧看到的是前一帧的结果：序号连续、工具按 toolCallId 合并", () => {
    writer.turnBegin("s1", ctx(), { text: "q" });
    const a = writer.acpUpdate("s1", toolCall("c1", { title: "跑" }), ctx());
    const b = writer.acpUpdate(
      "s1",
      toolUpdate("c1", { status: "completed" }),
      ctx(),
    );
    expect(b[0]!.seq).toBe(a[a.length - 1]!.seq + 1);
    const tool = writer.state("s1")!.items["tool:c1"];
    expect(tool).toMatchObject({
      kind: "tool",
      status: "completed",
      title: "跑",
    });
  });
});

describe("刷写节奏", () => {
  it("第一次最多等 30 ms，之后每 80 ms 一次", () => {
    writer.turnBegin("s1", ctx(), { text: "q" });
    writer.acpUpdate("s1", msg("开"), ctx());
    timers.advance(500);
    frames.length = 0;
    writer.acpUpdate("s1", msg("a"), ctx());
    timers.advance(FIRST_FLUSH_MS - 1);
    expect(frames).toHaveLength(0);
    timers.advance(1);
    expect(frames).toHaveLength(1);
    // 紧接着又来分块：要等满一个 80 ms 的间隔。
    writer.acpUpdate("s1", msg("b"), ctx());
    timers.advance(FLUSH_INTERVAL_MS - 10);
    expect(frames).toHaveLength(1);
    timers.advance(10);
    expect(frames).toHaveLength(2);
  });

  it("1000 个分块/秒的压力下每秒刷写不超过 15 次，内容一个字不少", () => {
    writer.turnBegin("s1", ctx(), { text: "q" });
    writer.flush();
    const before = writer.flushes;
    let expected = "";
    const SECONDS = 4;
    for (let ms = 0; ms < SECONDS * 1000; ms++) {
      const piece = `x${ms % 10}`;
      expected += piece;
      writer.acpUpdate("s1", msg(piece), ctx());
      timers.advance(1);
    }
    timers.advance(FLUSH_INTERVAL_MS);
    expect((writer.flushes - before) / SECONDS).toBeLessThanOrEqual(15);
    const item = Object.values(store.sync("s1", 0)!.items).find(
      (i) => "kind" in i && i.kind === "assistant",
    );
    expect(item && "parts" in item && item.parts).toEqual([
      { type: "text", text: expected },
    ]);
  });

  it("回合开始 / 结束与审批立刻刷写，页面马上看到", () => {
    writer.turnBegin("s1", ctx(), { text: "q" });
    expect(frames).toHaveLength(1);
    writer.put("s1", {
      id: "ap:p1",
      turn: 1,
      ord: 5,
      rev: 0,
      source: "acp",
      at: 1,
      gen: 1,
      kind: "approval",
      pendingId: "p1",
      protocol: "acp",
      options: [],
      state: "pending",
    });
    expect(frames).toHaveLength(2);
    writer.turnEnd("s1", ctx(), { stopReason: "end_turn" });
    expect(frames).toHaveLength(3);
  });

  it("条目切换（文本之后来了工具）尽快刷写，但两次切换刷写至少隔一个间隔", () => {
    writer.turnBegin("s1", ctx(), { text: "q" });
    writer.acpUpdate("s1", msg("先说点"), ctx());
    timers.advance(FIRST_FLUSH_MS);
    frames.length = 0;
    writer.acpUpdate("s1", toolCall("c1"), ctx());
    expect(frames).toHaveLength(0);
    timers.advance(SWITCH_GAP_MS);
    expect(frames).toHaveLength(1);
    // 密集的工具更新（条目已存在，不算切换）不会把刷写次数顶高。
    for (let i = 0; i < 100; i++) {
      writer.acpUpdate("s1", toolUpdate("c1", { title: `t${i}` }), ctx());
      timers.advance(1);
    }
    timers.advance(FLUSH_INTERVAL_MS);
    expect(frames.length).toBeLessThanOrEqual(3);
  });

  it("一窗口里攒的操作太多就强制刷写", () => {
    writer.turnBegin("s1", ctx(), { text: "q" });
    frames.length = 0;
    for (let i = 0; i < 2_100; i++) {
      writer.acpUpdate("s1", toolCall(`c${i}`), ctx());
    }
    expect(frames.length).toBeGreaterThanOrEqual(1);
    writer.flush();
    expect(store.get("s1")?.headSeq).toBe(writer.state("s1")!.seq);
  });
});

describe("重放与缺口", () => {
  function produce(): TimelineFrame[] {
    writer.turnBegin("s1", ctx(), { text: "q" });
    for (let round = 0; round < 6; round++) {
      writer.acpUpdate("s1", think(`想${round}`), ctx());
      writer.acpUpdate("s1", toolCall(`c${round}`), ctx());
      writer.acpUpdate(
        "s1",
        toolUpdate(`c${round}`, { status: "completed" }),
        ctx(),
      );
      writer.acpUpdate("s1", msg(`答${round}`), ctx());
      timers.advance(100);
    }
    writer.turnEnd("s1", ctx(), { stopReason: "end_turn" });
    return [...frames];
  }

  it("重复的帧被丢弃，结果不变", () => {
    const viewer = client();
    for (const frame of produce()) {
      viewer.feed(frame);
      viewer.feed(frame);
    }
    expect(viewer.state.items).toEqual(writer.state("s1")!.items);
  });

  it("丢了中间的帧：下一帧报缺口，按 sync 补齐后收敛", () => {
    const all = produce();
    expect(all.length).toBeGreaterThan(4);
    const viewer = client();
    all.forEach((frame, i) => {
      if (i !== 2) viewer.feed(frame);
    });
    expect(viewer.state.items).toEqual(writer.state("s1")!.items);
    expect(viewer.state.seq).toBe(writer.state("s1")!.seq);
  });

  it("乱序到达的帧（先晚后早）也收敛", () => {
    const all = produce();
    const viewer = client();
    for (const frame of [...all].reverse()) viewer.feed(frame);
    for (const frame of all) viewer.feed(frame);
    expect(viewer.state.items).toEqual(writer.state("s1")!.items);
  });

  it("与 sync 应答交叠的帧（部分已经在应答里）不会把条目改回去", () => {
    const all = produce();
    const viewer = client();
    viewer.state = applyTimelineSync(
      emptyTimelineState(),
      store.sync("s1", 0)!,
    );
    for (const frame of all) viewer.feed(frame);
    expect(sortedTimelineItems(viewer.state)).toEqual(
      sortedTimelineItems(writer.state("s1")!),
    );
  });
});

describe("随机会话", () => {
  it("随机的分块、工具与思考，随机的刷写间隔：库、内存与只吃帧的客户端三者一致", () => {
    // 固定种子的线性同余，失败可复现。
    let seed = 20260420;
    const random = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    const viewer = client();
    for (let round = 0; round < 40; round++) {
      const turn = round + 1;
      writer.turnBegin("s1", ctx(turn), { text: `问${turn}` });
      const steps = 5 + random(30);
      for (let i = 0; i < steps; i++) {
        const pick = random(6);
        if (pick === 0) writer.acpUpdate("s1", think(`想${i}`), ctx(turn));
        else if (pick === 1)
          writer.acpUpdate("s1", toolCall(`c${turn}-${random(4)}`), ctx(turn));
        else if (pick === 2)
          writer.acpUpdate(
            "s1",
            toolUpdate(`c${turn}-${random(4)}`, { status: "completed" }),
            ctx(turn),
          );
        else writer.acpUpdate("s1", msg(`字${i}`), ctx(turn));
        timers.advance(random(3) === 0 ? random(120) : 0);
      }
      writer.turnEnd("s1", ctx(turn), { stopReason: "end_turn" });
    }
    writer.flush();
    const drops = new Set([3, 11, 29]);
    frames.forEach((frame, i) => {
      if (!drops.has(i)) viewer.feed(frame);
    });
    const fromDatabase = applyTimelineSync(
      emptyTimelineState(),
      store.sync("s1", 0)!,
    );
    const live = writer.state("s1")!;
    // 内存只留最近几个回合：在内存里的部分逐个对得上。
    for (const [id, item] of Object.entries(live.items)) {
      expect(fromDatabase.items[id]).toEqual(item);
    }
    expect(viewer.state.items).toEqual(fromDatabase.items);
    expect(viewer.state.seq).toBe(live.seq);
    expect(fromDatabase.seq).toBe(live.seq);
  });
});

describe("持久与恢复", () => {
  it("写库失败时留着窗口、稍后重试，内存状态不回退", () => {
    writer.turnBegin("s1", ctx(), { text: "q" });
    frames.length = 0;
    const warnings: string[] = [];
    const failing = make({ log: { warn: (m) => warnings.push(m) } });
    failing.open({ timelineId: "s1", workspaceId: "w", nodeId: "n" });
    const original = store.apply.bind(store);
    let fail = true;
    store.apply = (...args) => {
      if (fail) throw new Error("disk full");
      return original(...args);
    };
    failing.acpUpdate("s1", msg("别丢"), ctx());
    timers.advance(FIRST_FLUSH_MS);
    expect(warnings).toEqual(["timeline flush failed"]);
    expect(frames).toHaveLength(0);
    fail = false;
    timers.advance(FLUSH_INTERVAL_MS * 4);
    expect(frames).toHaveLength(1);
    expect(store.get("s1")?.headSeq).toBe(failing.state("s1")!.seq);
  });

  it("close 先刷空；之后的写入被丢弃，不再动库", () => {
    writer.turnBegin("s1", ctx(), { text: "q" });
    writer.acpUpdate("s1", msg("最后一句"), ctx());
    writer.close();
    expect(store.get("s1")?.headSeq).toBeGreaterThan(0);
    const head = store.get("s1")!.headSeq;
    expect(() => writer.acpUpdate("s1", msg("x"), ctx())).toThrow();
    expect(store.get("s1")?.headSeq).toBe(head);
  });

  it("新的写入器接着库里的序号写（core 重启后）", () => {
    writer.turnBegin("s1", ctx(), { text: "q" });
    writer.acpUpdate("s1", msg("旧"), ctx());
    writer.flush();
    const head = store.get("s1")!.headSeq;
    const revived = make();
    revived.open({ timelineId: "s1", workspaceId: "w", nodeId: "n" });
    expect(revived.state("s1")!.seq).toBe(head);
    const ops = revived.acpUpdate("s1", msg("新"), ctx());
    expect(ops[0]!.seq).toBe(head + 1);
    expect(revived.nextTurn("s1")).toBe(2);
    expect(revived.currentTurn("s1")).toBe(1);
  });

  it("内存只留最近几个回合，更老的回合只在库里，但读出来是完整的", () => {
    for (let turn = 1; turn <= 12; turn++) {
      writer.turnBegin("s1", ctx(turn), { text: `问${turn}` });
      writer.acpUpdate("s1", msg(`答${turn}`), ctx(turn));
      writer.turnEnd("s1", ctx(turn), { stopReason: "end_turn" });
    }
    const inMemory = Object.values(writer.state("s1")!.items);
    expect(new Set(inMemory.map((i) => i.turn)).size).toBeLessThanOrEqual(6);
    expect(store.snapshot("s1", 50)!.turns).toHaveLength(12);
    expect(writer.nextTurn("s1")).toBe(13);
  });

  it("没有关心的订阅者时照常写；onWrite 在刷写之前就收到应用后的状态", () => {
    const seen: number[] = [];
    const watched = make({ onWrite: (event) => seen.push(event.state.seq) });
    watched.open({ timelineId: "s2", workspaceId: "w", nodeId: "n2" });
    watched.write("s2", (state) =>
      acpTurnBeginOps(state, ctx(1), { text: "q" }),
    );
    expect(seen).toEqual([2]);
  });
});

describe("blob", () => {
  it("图片经 blob 仓存盘，条目里只有 blobId，不带 base64", () => {
    const dir = tempDir("timeline-writer-");
    const withBlobs = make({ blobs: new BlobStore(dir, database) });
    withBlobs.open({ timelineId: "s2", workspaceId: "w", nodeId: "n2" });
    withBlobs.turnBegin("s2", ctx(), { text: "看图" });
    const data = Buffer.from("png-bytes").toString("base64");
    withBlobs.acpUpdate(
      "s2",
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", mimeType: "image/png", data },
      },
      ctx(),
    );
    withBlobs.flush();
    const dump = JSON.stringify(store.sync("s2", 0));
    expect(dump).not.toContain(data);
    expect(dump).toContain('"blobId"');
    const item = store
      .sync("s2", 0)!
      .items.find((i) => "kind" in i && i.kind === "assistant");
    const part = item && "parts" in item ? item.parts[0] : undefined;
    expect(part).toMatchObject({ type: "image", bytes: 9 });
  });
});
