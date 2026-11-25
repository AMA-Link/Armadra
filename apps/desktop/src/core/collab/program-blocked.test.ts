import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { putContextLinks } from "../canvas/context-links";
import { freeLease } from "../drive/lease";
import { controlDispatcher, type ControlOutcome } from "./control";
import { SendPump, nodeFreedByProgram } from "./send-pump";
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

describe("which node a terminal.program event frees", () => {
  it("frees on any state but blocked, and when the record is gone", () => {
    const at = (status?: { state: string }) =>
      nodeFreedByProgram({ type: "terminal.program", nodeId: "n1", status });
    expect(at({ state: "blocked" })).toBeUndefined();
    for (const state of ["idle", "working", "done", "error"]) {
      expect(at({ state })).toBe("n1");
    }
    expect(at(undefined)).toBe("n1");
  });

  it("ignores other events and sessions without a node", () => {
    expect(
      nodeFreedByProgram({ type: "agent.status", nodeId: "n1" }),
    ).toBeUndefined();
    expect(
      nodeFreedByProgram({ type: "terminal.program", status: undefined }),
    ).toBeUndefined();
  });
});
