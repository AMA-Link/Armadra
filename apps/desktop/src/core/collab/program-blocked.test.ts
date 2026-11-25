import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { putContextLinks } from "../canvas/context-links";
import { freeLease } from "../drive/lease";
import { controlDispatcher, type ControlOutcome } from "./control";
import { ProgramBlockTracker, programBlocks } from "./program-block";
import { SendPump, programFreeHook } from "./send-pump";
import { resetSendLimits } from "./send-limits";
import { pendingCountFor } from "./send-queue";

/**
 * 终端程序自报的 `blocked`（OSC 7501，契约 §53、§120）是投递的第二道保险，只做
 * 否决：不论状态通道说什么、走的是哪条放行路径，都不往停在审批上的程序里写字。
 */

let fixture: AgentFixture;
let me: string;

async function run(
  verb: string,
  args: Record<string, unknown>,
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, me), args);
}

function ok(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  return outcome.body;
}

function code(outcome: ControlOutcome): string {
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome.code;
}

function age(sessionId: string, ms: number): void {
  fixture.database
    .prepare("UPDATE terminal_sessions SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - ms).toISOString(), sessionId);
}

function quiet(sessionId: string): void {
  fixture.terminal.activity.set(sessionId, {
    pending: false,
    lastInputAt: undefined,
    lastOutputAt: Date.now() - 5_000,
  });
}

function node(
  agentId: string | null,
  drive: { state: string; stateSource: string | undefined },
): { id: string; sessionId: string } {
  const id = fixture.agentNode("Peer", agentId);
  const sessionId = fixture.session(id, agentId ?? "");
  putContextLinks(fixture.database, fixture.workspaceId, me, [
    { id, title: "Peer", kind: "terminal" },
  ]);
  fixture.terminal.drive.set(id, {
    nodeId: id,
    sessionId,
    lease: freeLease(0),
    driveGeneration: 0,
    ...drive,
  } as never);
  return { id, sessionId };
}

beforeEach(() => {
  programBlocks.clear();
  resetSendLimits();
  fixture = agentFixture();
  me = fixture.agentNode("Caller");
  fixture.name(me, "planner");
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
});

describe("a program that reports blocked", () => {
  it("--unverified does not write into it, and a quiet program is delivered once it is clear", async () => {
    const bare = node(null, { state: "idle", stateSource: "observed" });
    quiet(bare.sessionId);
    fixture.terminal.programs.set(bare.sessionId, { state: "blocked" });
    const queued = ok(
      await run("send", { to: bare.id, body: "做", unverified: true }),
    );
    expect(queued).toMatchObject({
      outcome: "queued",
      reason: "TARGET_AWAITING_APPROVAL",
    });
    expect(fixture.terminal.submits).toHaveLength(0);
    fixture.terminal.programs.delete(bare.sessionId);
    const delivered = ok(
      await run("send", { to: bare.id, body: "做", unverified: true }),
    );
    expect(delivered).toMatchObject({ outcome: "delivered" });
  });

  it("an --unverified delivery queued behind blocked is delivered once blocked clears", async () => {
    const bare = node(null, { state: "idle", stateSource: "observed" });
    quiet(bare.sessionId);
    fixture.terminal.programs.set(bare.sessionId, { state: "blocked" });
    expect(
      ok(await run("send", { to: bare.id, body: "做", unverified: true })),
    ).toMatchObject({ outcome: "queued", reason: "TARGET_AWAITING_APPROVAL" });
    expect(pendingCountFor(fixture.database, bare.id, 0)).toBe(1);
    const pump = new SendPump(() => fixture.collab);
    await pump.drain(bare.id);
    expect(fixture.terminal.submits).toHaveLength(0);
    fixture.terminal.programs.delete(bare.sessionId);
    pump.noteFree(bare.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 排队项带着 --unverified：没有状态通道的目标不会以 TARGET_STATE_UNVERIFIED 结束。
    expect(fixture.terminal.submits).toHaveLength(1);
    expect(pendingCountFor(fixture.database, bare.id, 0)).toBe(0);
  });

  describe("a stale blocked", () => {
    const BLOCKED_AT = "2026-11-25T10:00:00.000Z";
    function report(
      nodeId: string,
      fields: {
        doneAt: string;
        lastEventAt?: string;
        updatedAt?: string;
        endedBy?: string;
        source?: string;
      },
    ): void {
      fixture.database
        .prepare(
          "INSERT OR REPLACE INTO agent_status (node_id, workspace_id, agent_id, state, state_source, " +
            "unread, verified, restored, updated_at, last_event_at, ended_by, done_at) " +
            "VALUES (?, ?, 'claude', 'done', ?, 0, 1, 0, ?, ?, ?, ?)",
        )
        .run(
          nodeId,
          fixture.workspaceId,
          fields.source ?? "hook",
          fields.updatedAt ?? fields.doneAt,
          fields.lastEventAt ?? fields.doneAt,
          fields.endedBy ?? null,
          fields.doneAt,
        );
    }
    function setUp() {
      const claude = node("claude", { state: "idle", stateSource: "hook" });
      fixture.terminal.foreground = { command: "claude" };
      fixture.terminal.programs.set(claude.sessionId, {
        state: "blocked",
        updatedAt: BLOCKED_AT,
      });
      return claude;
    }
    const send = async (id: string) =>
      ok(await run("send", { to: id, body: "做" }));

    it("is withdrawn by the CLI's own done that came strictly later", async () => {
      const claude = setUp();
      report(claude.id, { doneAt: "2026-11-25T10:00:30.000Z" });
      expect(await send(claude.id)).toMatchObject({ outcome: "delivered" });
    });

    it("is not withdrawn by anything that only moves updatedAt or lastEventAt", async () => {
      const claude = setUp();
      report(claude.id, {
        doneAt: "2026-11-25T09:59:00.000Z",
        updatedAt: "2026-11-25T10:30:00.000Z",
        lastEventAt: "2026-11-25T10:30:00.000Z",
      });
      expect(await send(claude.id)).toMatchObject({
        outcome: "queued",
        reason: "TARGET_AWAITING_APPROVAL",
      });
    });

    it("is not withdrawn by a done the sweep synthesised", async () => {
      const claude = setUp();
      report(claude.id, {
        doneAt: "2026-11-25T10:05:00.000Z",
        endedBy: "stale",
      });
      expect(await send(claude.id)).toMatchObject({
        outcome: "queued",
        reason: "TARGET_AWAITING_APPROVAL",
      });
    });

    it("is not withdrawn by the transcript channel (grok) even when its done looks later", async () => {
      const claude = setUp();
      report(claude.id, {
        doneAt: "2026-11-25T10:05:00.000Z",
        source: "transcript",
      });
      expect(await send(claude.id)).toMatchObject({
        outcome: "queued",
        reason: "TARGET_AWAITING_APPROVAL",
      });
    });

    it("equal times keep the veto", async () => {
      const claude = setUp();
      report(claude.id, { doneAt: BLOCKED_AT });
      expect(await send(claude.id)).toMatchObject({
        outcome: "queued",
        reason: "TARGET_AWAITING_APPROVAL",
      });
    });
  });

  it("the sweep releases a veto no frame ever released, and wakes the pump once", async () => {
    const claude = node("claude", { state: "idle", stateSource: "hook" });
    fixture.terminal.foreground = { command: "claude" };
    fixture.terminal.programs.set(claude.sessionId, { state: "blocked" });
    expect(ok(await run("send", { to: claude.id, body: "做" }))).toMatchObject({
      outcome: "queued",
    });
    expect(programBlocks.nodes()).toEqual([claude.id]);
    const pump = new SendPump(() => fixture.collab);
    // 还被拦着：清扫不放。
    pump.sweep();
    expect(programBlocks.nodes()).toEqual([claude.id]);
    // idle → blocked → idle，摘要相同，一个帧都没发：清扫发现它不再被拦。
    fixture.terminal.programs.delete(claude.sessionId);
    pump.sweep();
    expect(programBlocks.nodes()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.terminal.submits).toHaveLength(1);
  });

  it("the sweep drops a registration whose node has no session any more", () => {
    programBlocks.vetoed("gone-node");
    new SendPump(() => fixture.collab).sweep();
    expect(programBlocks.nodes()).toEqual([]);
  });

  it("the first delivery to a CLI that starts silently is vetoed too", async () => {
    const codex = node("codex", { state: "starting", stateSource: undefined });
    fixture.terminal.foreground = { command: "codex" };
    age(codex.sessionId, 10_000);
    quiet(codex.sessionId);
    fixture.terminal.programs.set(codex.sessionId, { state: "blocked" });
    const body = ok(await run("send", { to: codex.id, body: "做" }));
    expect(body).toMatchObject({
      outcome: "queued",
      reason: "TARGET_AWAITING_APPROVAL",
    });
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("the first delivery after only a session start is vetoed too", async () => {
    const claude = node("claude", { state: "starting", stateSource: "hook" });
    fixture.terminal.foreground = { command: "claude" };
    fixture.terminal.capture = "❯ \n  ? for shortcuts";
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, state_source, " +
          "unread, verified, restored, session_phase, session_id, updated_at) " +
          "VALUES (?, ?, 'claude', NULL, 'hook', 0, 1, 0, 'start', 'prov-1', ?)",
      )
      .run(claude.id, fixture.workspaceId, new Date().toISOString());
    age(claude.sessionId, 10_000);
    quiet(claude.sessionId);
    fixture.terminal.programs.set(claude.sessionId, { state: "blocked" });
    const body = ok(await run("send", { to: claude.id, body: "做" }));
    expect(body).toMatchObject({
      outcome: "queued",
      reason: "TARGET_AWAITING_APPROVAL",
    });
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("--interrupt does not press Escape on it, even when the channel says busy", async () => {
    const claude = node("claude", { state: "busy", stateSource: "hook" });
    fixture.terminal.foreground = { command: "claude" };
    fixture.terminal.programs.set(claude.sessionId, { state: "blocked" });
    const refused = await run("send", {
      to: claude.id,
      body: "做",
      interrupt: true,
    });
    expect(code(refused)).toBe("TARGET_AWAITING_APPROVAL");
    expect(fixture.terminal.writes).toHaveLength(0);
    expect(fixture.terminal.submits).toHaveLength(0);
  });

  it("a queued delivery leaves the queue once blocked clears, with no agent.status in between", async () => {
    const claude = node("claude", { state: "idle", stateSource: "hook" });
    fixture.terminal.foreground = { command: "claude" };
    fixture.terminal.programs.set(claude.sessionId, { state: "blocked" });
    expect(ok(await run("send", { to: claude.id, body: "做" }))).toMatchObject({
      outcome: "queued",
      reason: "TARGET_AWAITING_APPROVAL",
    });
    expect(pendingCountFor(fixture.database, claude.id, 0)).toBe(1);
    const pump = new SendPump(() => fixture.collab);
    // 还在 blocked：出队也不投。
    await pump.drain(claude.id);
    expect(fixture.terminal.submits).toHaveLength(0);
    // 清掉之后，`noteFree`（`terminal.program` 事件触发的那一下）就能出队。
    fixture.terminal.programs.delete(claude.sessionId);
    pump.noteFree(claude.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.terminal.submits).toHaveLength(1);
    expect(pendingCountFor(fixture.database, claude.id, 0)).toBe(0);
  });
});

describe("a veto the frames never showed", () => {
  it("working → blocked → idle inside one throttle window still wakes the pump", async () => {
    const claude = node("claude", { state: "idle", stateSource: "hook" });
    fixture.terminal.foreground = { command: "claude" };
    // 帧节流：投递读的是即时值，事件里一个 `blocked` 帧都没出现过。
    fixture.terminal.programs.set(claude.sessionId, { state: "blocked" });
    expect(ok(await run("send", { to: claude.id, body: "做" }))).toMatchObject({
      outcome: "queued",
      reason: "TARGET_AWAITING_APPROVAL",
    });
    fixture.terminal.programs.delete(claude.sessionId);
    const freed: string[] = [];
    const hook = programFreeHook({ noteFree: (id) => freed.push(id) });
    // 窗口结束时发出的那一帧已经是 working/idle。
    hook({
      type: "terminal.program",
      nodeId: claude.id,
      status: { state: "idle" },
    });
    expect(freed).toEqual([claude.id]);
  });
});

describe("a queued --unverified item from before a restart", () => {
  it("ends through the gate chain as TARGET_STATE_UNVERIFIED instead of being delivered on a stale say-so", async () => {
    const bare = node(null, { state: "idle", stateSource: "observed" });
    quiet(bare.sessionId);
    fixture.terminal.programs.set(bare.sessionId, { state: "blocked" });
    expect(
      ok(await run("send", { to: bare.id, body: "做", unverified: true })),
    ).toMatchObject({ outcome: "queued" });
    fixture.terminal.programs.delete(bare.sessionId);
    // 「重启」：这个泵比排队项晚起来（排队项的 created_at 早于它）。
    const pump = new SendPump(
      () => fixture.collab,
      undefined,
      Math.floor(Date.now() / 1000) + 10,
    );
    await pump.drain(bare.id);
    expect(fixture.terminal.submits).toHaveLength(0);
    expect(pendingCountFor(fixture.database, bare.id, 0)).toBe(0);
    const row = fixture.database
      .prepare(
        "SELECT state, last_reason, settled_by FROM agent_send_queue WHERE target_node_id = ?",
      )
      .get(bare.id) as {
      state: string;
      last_reason: string;
      settled_by: string;
    };
    expect(row).toEqual({
      state: "cancelled",
      last_reason: "TARGET_STATE_UNVERIFIED",
      settled_by: "gate",
    });
    // 发送方的收件箱里有那条回执，而且说明了为什么。
    const receipt = fixture.database
      .prepare(
        "SELECT body FROM agent_mailbox WHERE message_key LIKE 'receipt:%' AND target_node_id = ?",
      )
      .get(me) as { body: string } | undefined;
    expect(receipt?.body).toContain("TARGET_STATE_UNVERIFIED");
    expect(receipt?.body).toContain("重启");
  });

  it("an item queued after the start still goes out", async () => {
    const bare = node(null, { state: "idle", stateSource: "observed" });
    quiet(bare.sessionId);
    fixture.terminal.programs.set(bare.sessionId, { state: "blocked" });
    ok(await run("send", { to: bare.id, body: "做", unverified: true }));
    fixture.terminal.programs.delete(bare.sessionId);
    const pump = new SendPump(
      () => fixture.collab,
      undefined,
      Math.floor(Date.now() / 1000) - 10,
    );
    await pump.drain(bare.id);
    expect(fixture.terminal.submits).toHaveLength(1);
  });
});

describe("which node a terminal.program event frees", () => {
  const event = (nodeId: string, state?: string) => ({
    type: "terminal.program",
    nodeId,
    status: state === undefined ? undefined : { state },
  });

  it("frees only on the transition out of blocked, not on every frame", () => {
    const tracker = new ProgramBlockTracker();
    // 没 blocked 过：进度帧一律不叫醒。
    expect(tracker.observe(event("n1", "working"))).toBeUndefined();
    expect(tracker.observe(event("n1", "working"))).toBeUndefined();
    expect(tracker.observe(event("n1", "blocked"))).toBeUndefined();
    expect(tracker.observe(event("n1", "blocked"))).toBeUndefined();
    expect(tracker.observe(event("n1", "working"))).toBe("n1");
    // 解除之后再来的帧不再叫醒。
    expect(tracker.observe(event("n1", "working"))).toBeUndefined();
    expect(tracker.observe(event("n1", "idle"))).toBeUndefined();
  });

  it("frees when the record disappears, per node", () => {
    const tracker = new ProgramBlockTracker();
    tracker.observe(event("a", "blocked"));
    tracker.observe(event("b", "blocked"));
    expect(tracker.observe(event("a"))).toBe("a");
    expect(tracker.observe(event("a"))).toBeUndefined();
    expect(tracker.observe(event("b", "idle"))).toBe("b");
  });

  it("ignores other events and sessions without a node", () => {
    const tracker = new ProgramBlockTracker();
    expect(
      tracker.observe({ type: "agent.status", nodeId: "n1" }),
    ).toBeUndefined();
    expect(
      tracker.observe({ type: "terminal.program", status: undefined }),
    ).toBeUndefined();
  });

  it("the hook agent/index.ts installs calls noteFree once, and says the event was its own", () => {
    const freed: string[] = [];
    const hook = programFreeHook({ noteFree: (id) => freed.push(id) });
    expect(hook({ type: "agent.status", nodeId: "n1" })).toBe(false);
    expect(hook(event("n1", "blocked"))).toBe(true);
    expect(hook(event("n1", "working"))).toBe(true);
    expect(hook(event("n1", "working"))).toBe(true);
    expect(freed).toEqual(["n1"]);
  });
});
