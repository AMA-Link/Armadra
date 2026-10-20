import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type SessionActivity,
  acpTurnBeginOps,
  acpTurnEndOps,
  compareActivityRev,
} from "@armadra/shared";

import {
  ActivityTracker,
  RESTORE_SILENCE_MS,
  contentPhase,
  outcomeOf,
} from "./activity";
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
import { TimelineWriter } from "./writer";

/**
 * 活动状态机的每个转换（设计 §2.4）：提示 → submitting；思考 / 文本 / 工具 →
 * thinking / responding / tool；审批与提问盖过一切；回合结束回 idle 并写结局；
 * 生命周期（启动、恢复、切换、休眠、退出）盖过内容推导。
 */

let database: DatabaseSync;
let timers: FakeTimers;
let changes: SessionActivity[];
let tracker: ActivityTracker;
let writer: TimelineWriter;

beforeEach(() => {
  database = memoryDatabase();
  timers = new FakeTimers();
  changes = [];
  tracker = new ActivityTracker({
    bootId: "boot",
    timers,
    publish: (change) => changes.push(change.activity),
  });
  writer = new TimelineWriter({
    store: new TimelineStore(database),
    publish: () => undefined,
    timers,
    onWrite: (event) => tracker.observe(event.timelineId, event.state),
  });
  writer.open({ timelineId: "s1", workspaceId: "w", nodeId: "n" });
  tracker.bind("s1", "w", "n");
});

afterEach(() => {
  tracker.close();
  database.close();
});

const ctx = (turn = 1) => turnCtx(turn, timers.now());
const phase = (): string | undefined => tracker.get("s1")?.phase;
const phases = (): string[] => changes.map((c) => c.phase);

/** 页面发了提示：先写回合，再报生命周期（顺序与 B3 的接线一致）。 */
function ask(turn = 1): void {
  writer.turnBegin("s1", ctx(turn), { text: "q" });
  tracker.prompt("s1", `t${turn}`);
}

describe("提示与回合", () => {
  it("刚登记是 idle；提示发出 submitting；第一帧文本 responding；回合结束回 idle 并写结局", () => {
    expect(phase()).toBe("idle");
    ask();
    expect(phase()).toBe("submitting");
    writer.acpUpdate("s1", msg("你"), ctx());
    expect(phase()).toBe("responding");
    writer.acpUpdate("s1", msg("好"), ctx());
    writer.turnEnd("s1", ctx(), { stopReason: "end_turn" });
    tracker.turnEnded("s1", outcomeOf("end_turn"));
    expect(phase()).toBe("idle");
    expect(tracker.get("s1")?.lastOutcome).toMatchObject({ kind: "done" });
    expect(tracker.get("s1")?.turnId).toBeUndefined();
    // 写入器先写回合结束（idle），生命周期随后报结局（同阶段，多一个 lastOutcome）。
    expect(phases()).toEqual(["submitting", "responding", "idle", "idle"]);
    expect(changes[2]?.lastOutcome).toBeUndefined();
  });

  it("第一帧是思考 → thinking；之后来文本 → responding", () => {
    ask();
    writer.acpUpdate("s1", think("嗯"), ctx());
    expect(phase()).toBe("thinking");
    writer.acpUpdate("s1", msg("答"), ctx());
    expect(phase()).toBe("responding");
  });

  it("文本流里每个分块都不发事件，只在阶段或细节变化时发", () => {
    ask();
    writer.acpUpdate("s1", msg("a"), ctx());
    const before = changes.length;
    for (let i = 0; i < 200; i++) writer.acpUpdate("s1", msg("x"), ctx());
    expect(changes).toHaveLength(before);
    // 但 lastOutputAt 随最新输出走。
    timers.advance(5_000);
    writer.acpUpdate("s1", msg("y"), ctx());
    expect(tracker.get("s1")?.lastOutputAt).toBe(timers.now());
  });

  it("回合结束的结局：取消、拒绝、上限、出错各有各的种类", () => {
    expect(outcomeOf("cancelled")).toEqual({ kind: "cancelled" });
    expect(outcomeOf("refusal")).toEqual({ kind: "refused" });
    expect(outcomeOf("max_tokens")).toEqual({ kind: "limit" });
    expect(outcomeOf("max_turn_requests")).toEqual({ kind: "limit" });
    expect(outcomeOf("end_turn")).toEqual({ kind: "done" });
    expect(outcomeOf(undefined, { message: "boom" })).toEqual({
      kind: "failed",
      error: "boom",
    });
    ask();
    tracker.turnEnded("s1", outcomeOf(undefined, { message: "boom" }));
    expect(tracker.get("s1")?.lastOutcome).toMatchObject({
      kind: "failed",
      error: "boom",
    });
  });

  it("下一个提示会清掉上一回合的 turnId，lastOutcome 留到新结局覆盖它", () => {
    ask();
    tracker.turnEnded("s1", outcomeOf("cancelled"));
    ask(2);
    expect(tracker.get("s1")).toMatchObject({
      phase: "submitting",
      turnId: "t2",
      lastOutcome: { kind: "cancelled" },
    });
  });
});

describe("工具", () => {
  it("有工具在跑 → tool，带标题、kind 与并发数；全部结束回到最近一个文本阶段", () => {
    ask();
    writer.acpUpdate("s1", msg("我先看看"), ctx());
    writer.acpUpdate(
      "s1",
      toolCall("a", { title: "读 a.ts", kind: "read" }),
      ctx(),
    );
    expect(tracker.get("s1")).toMatchObject({
      phase: "tool",
      detail: { label: "读 a.ts", toolKind: "read", count: 1 },
    });
    writer.acpUpdate(
      "s1",
      toolCall("b", { title: "跑测试", kind: "execute" }),
      ctx(),
    );
    expect(tracker.get("s1")?.detail).toMatchObject({
      label: "跑测试",
      toolKind: "execute",
      count: 2,
    });
    writer.acpUpdate("s1", toolUpdate("a", { status: "completed" }), ctx());
    expect(tracker.get("s1")?.detail).toMatchObject({ count: 1 });
    writer.acpUpdate("s1", toolUpdate("b", { status: "failed" }), ctx());
    // 先前最近的内容是文本（已不在流式里），回到 responding。
    expect(phase()).toBe("responding");
  });

  it("工具之前是思考 → 工具结束回到 thinking；什么内容都没有 → 也是 thinking", () => {
    ask();
    writer.acpUpdate("s1", think("想"), ctx());
    writer.acpUpdate("s1", toolCall("a"), ctx());
    expect(phase()).toBe("tool");
    writer.acpUpdate("s1", toolUpdate("a", { status: "completed" }), ctx());
    expect(phase()).toBe("thinking");

    tracker.turnEnded("s1", outcomeOf("end_turn"));
    ask(2);
    writer.acpUpdate("s1", toolCall("b"), ctx(2));
    writer.acpUpdate("s1", toolUpdate("b", { status: "completed" }), ctx(2));
    expect(phase()).toBe("thinking");
  });

  it("工具在跑时文本继续流：tool 的优先级高于 responding", () => {
    ask();
    writer.acpUpdate("s1", toolCall("a"), ctx());
    writer.acpUpdate("s1", msg("同时在说"), ctx());
    expect(phase()).toBe("tool");
  });
});

function approval(pendingId: string, state: "pending" | "answered") {
  return {
    id: `ap:${pendingId}`,
    turn: 1,
    ord: 50,
    rev: 0,
    source: "acp" as const,
    at: 1,
    gen: 1,
    kind: "approval" as const,
    pendingId,
    protocol: "acp",
    options: [],
    state,
  };
}

describe("审批与提问", () => {
  it("审批挂起 → awaiting_approval，盖过工具；答复后回到先前的阶段", () => {
    ask();
    writer.acpUpdate(
      "s1",
      toolCall("a", { title: "写文件", kind: "edit" }),
      ctx(),
    );
    expect(phase()).toBe("tool");
    writer.put("s1", approval("p1", "pending"));
    expect(phase()).toBe("awaiting_approval");
    writer.put("s1", approval("p1", "answered"));
    expect(phase()).toBe("tool");
  });

  it("提问 → awaiting_input；与审批同在时审批优先", () => {
    ask();
    writer.put("s1", {
      id: "el:e1",
      turn: 1,
      ord: 51,
      rev: 0,
      source: "acp",
      at: 1,
      gen: 1,
      kind: "elicitation",
      pendingId: "e1",
      message: "选一个",
      mode: "form",
      state: "pending",
    });
    expect(phase()).toBe("awaiting_input");
    writer.put("s1", approval("p1", "pending"));
    expect(phase()).toBe("awaiting_approval");
    writer.put("s1", approval("p1", "answered"));
    expect(phase()).toBe("awaiting_input");
  });

  it("回合被取消：挂着的审批被收尾为 cancelled，活动回到 idle", () => {
    ask();
    writer.put("s1", approval("p1", "pending"));
    expect(phase()).toBe("awaiting_approval");
    writer.turnEnd("s1", ctx(), { stopReason: "cancelled" });
    tracker.turnEnded("s1", outcomeOf("cancelled"));
    expect(phase()).toBe("idle");
    expect(tracker.get("s1")?.lastOutcome?.kind).toBe("cancelled");
  });

  it("没有回合在进行时，挂起的审批照样算数（别的端发的提示、重启恢复）", () => {
    writer.put("s1", approval("p9", "pending"));
    expect(phase()).toBe("awaiting_approval");
  });
});

describe("生命周期", () => {
  it("启动的四个阶段各发一次，就绪后回 idle", () => {
    for (const step of [
      "spawn",
      "initialize",
      "session",
      "configure",
    ] as const) {
      tracker.starting("s1", step);
      expect(tracker.get("s1")).toMatchObject({
        phase: "starting",
        detail: { step },
      });
    }
    tracker.ready("s1");
    expect(phase()).toBe("idle");
    expect(changes).toHaveLength(5);
  });

  it("恢复历史：detail.count 是已回放条数，每来一帧重新计 120 s 静默", () => {
    tracker.restoring("s1", 1);
    timers.advance(RESTORE_SILENCE_MS - 1);
    tracker.restoring("s1", 50);
    timers.advance(RESTORE_SILENCE_MS - 1);
    expect(tracker.get("s1")).toMatchObject({
      phase: "restoring",
      detail: { count: 50 },
    });
    timers.advance(1);
    expect(phase()).toBe("idle");
  });

  it("恢复中内容写入不改阶段；就绪后按内容推导", () => {
    tracker.restoring("s1", 0);
    writer.turnBegin("s1", ctx(), { text: "旧问题" });
    writer.acpUpdate("s1", msg("旧回答"), ctx());
    expect(phase()).toBe("restoring");
    writer.turnEnd("s1", ctx(), { stopReason: "end_turn" });
    tracker.ready("s1");
    expect(phase()).toBe("idle");
  });

  it("切换、休眠、退出盖过回合；休眠和退出的会话由下一个提示唤起", () => {
    ask();
    tracker.switching("s1");
    expect(phase()).toBe("switching");
    tracker.ready("s1");
    tracker.sleeping("s1");
    expect(phase()).toBe("sleeping");
    expect(tracker.get("s1")?.turnId).toBeUndefined();
    tracker.exited("s1");
    expect(phase()).toBe("exited");
    ask(2);
    expect(phase()).toBe("submitting");
  });

  it("没登记过的时间线什么都不发，也不抛", () => {
    tracker.starting("nope", "spawn");
    tracker.prompt("nope");
    tracker.turnEnded("nope", { kind: "done" });
    tracker.observe("nope", writer.state("s1")!);
    expect(tracker.get("nope")).toBeUndefined();
    expect(changes).toHaveLength(0);
  });
});

describe("外部信号（终端驱动的 CLI 经 hook）", () => {
  it("hook 说在跑工具 → tool；撤销后按内容推导；说 idle 结束回合", () => {
    tracker.external("s1", {
      phase: "tool",
      detail: { label: "Bash", toolKind: "execute", count: 1 },
      turnId: "h1",
    });
    expect(tracker.get("s1")).toMatchObject({
      phase: "tool",
      turnId: "h1",
      detail: { label: "Bash" },
    });
    tracker.external("s1", { phase: "awaiting_approval" });
    expect(phase()).toBe("awaiting_approval");
    tracker.external("s1", null);
    expect(phase()).toBe("submitting");
    tracker.external("s1", { phase: "idle" });
    expect(phase()).toBe("idle");
  });

  it("内容层里优先级更高的阶段不被较低的 hook 阶段压下去", () => {
    writer.put("s1", approval("p1", "pending"));
    tracker.external("s1", { phase: "thinking", turnId: "h2" });
    expect(phase()).toBe("awaiting_approval");
  });
});

describe("版本与时间", () => {
  it("rev 是 bootId:n，每次发出的变化加一；同 boot 内可比", () => {
    ask();
    writer.acpUpdate("s1", msg("a"), ctx());
    tracker.turnEnded("s1", outcomeOf("end_turn"));
    expect(changes.map((c) => c.rev)).toEqual(["boot:1", "boot:2", "boot:3"]);
    expect(compareActivityRev("boot:3", "boot:2")).toBeGreaterThan(0);
    expect(compareActivityRev("other:1", "boot:2")).toBeNull();
  });

  it("since 只在阶段变化时更新；细节变化不动它", () => {
    ask();
    writer.acpUpdate("s1", toolCall("a"), ctx());
    const since = tracker.get("s1")!.since;
    timers.advance(3_000);
    writer.acpUpdate("s1", toolCall("b", { title: "另一个" }), ctx());
    expect(tracker.get("s1")?.detail?.count).toBe(2);
    expect(tracker.get("s1")?.since).toBe(since);
    timers.advance(3_000);
    writer.acpUpdate("s1", toolUpdate("a", { status: "completed" }), ctx());
    writer.acpUpdate("s1", toolUpdate("b", { status: "completed" }), ctx());
    expect(tracker.get("s1")?.since).toBeGreaterThan(since);
  });

  it("turnStartedAt 记提示发出的时间", () => {
    const at = timers.now();
    ask();
    expect(tracker.get("s1")?.turnStartedAt).toBe(at);
  });
});

describe("重启后的补法与清理", () => {
  it("fallback：活着 idle、休眠 sleeping、其余 exited，rev 用本次 bootId", () => {
    expect(tracker.fallback("alive", 5)).toEqual({
      phase: "idle",
      since: 5,
      rev: "boot:0",
    });
    expect(tracker.fallback("sleeping", 5).phase).toBe("sleeping");
    expect(tracker.fallback("gone", 5).phase).toBe("exited");
  });

  it("drop 之后查不到；close 停掉恢复计时器", () => {
    tracker.restoring("s1", 1);
    expect(timers.scheduled).toBe(1);
    tracker.close();
    expect(timers.scheduled).toBe(0);
    expect(tracker.get("s1")).toBeUndefined();
  });
});

describe("contentPhase（纯函数）", () => {
  it("没有回合在进行时只认挂起的审批；回合条目写了 endedAt 就算收尾", () => {
    ask();
    writer.acpUpdate("s1", msg("a"), ctx());
    const state = writer.state("s1")!;
    expect(contentPhase(state, undefined, false).phase).toBe("idle");
    expect(contentPhase(state, "t1", true).phase).toBe("responding");
    const closed = acpTurnEndOps(state, ctx(), { stopReason: "end_turn" });
    writer.write("s1", () => closed);
    expect(contentPhase(writer.state("s1")!, undefined, false)).toMatchObject({
      phase: "idle",
      active: false,
    });
  });

  it("空状态是 idle", () => {
    const empty = acpTurnBeginOps(
      { seq: 0, head: {}, headRev: 0, items: {}, tombstones: {} },
      ctx(),
    );
    expect(empty.length).toBeGreaterThan(0);
    expect(
      contentPhase(
        { seq: 0, head: {}, headRev: 0, items: {}, tombstones: {} },
        undefined,
        false,
      ).phase,
    ).toBe("idle");
  });
});
