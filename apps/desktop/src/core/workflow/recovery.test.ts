import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { type ControlOutcome, controlDispatcher } from "../collab/control";
import { resetWaitTrackers } from "../collab/control/wait";
import { openEvents } from "../collab/router-events";
import {
  deliverRecoveryHint,
  recordInterrupted,
  recoveryHint,
} from "../collab/router-sources";
import { resetSendLimits } from "../collab/send-limits";
import { pendingFor } from "../collab/send-queue";
import { resetInboxWake } from "../collab/wake";
import { RECOVERY_GRACE_MS, RecoveryScan } from "./recovery";

/**
 * 重启恢复（契约 §101.5）：启动扫描只记真正中断的项、一次中断只记一次、
 * 不自动重跑；成员续接后恢复提示只投一次。
 */

const BASE = Date.now();

let fixture: AgentFixture;
let lead: string;
let clock: number;
let alive: Set<string>;
let scan: RecoveryScan;

function result(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  return outcome.body.result as Record<string, unknown>;
}

/** 第一条任务已经投出去、终端也起过了：不再排队。 */
function settle(member: string): void {
  fixture.database
    .prepare(
      "UPDATE agent_send_queue SET state = 'done' WHERE target_node_id = ?",
    )
    .run(member);
  fixture.database
    .prepare(
      "UPDATE agent_dependency_launches SET state = 'launched' WHERE node_id = ?",
    )
    .run(member);
}

async function dispatch(taskId: string): Promise<string> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  const body = result(
    await dispatcher.dispatch("open-agent", callerFor(fixture, lead), {
      agent: "codex",
      task: `do ${taskId}`,
      "task-id": taskId,
    }),
  );
  const member = body.id as string;
  settle(member);
  return member;
}

function status(nodeId: string, state: string): void {
  const at = new Date(clock).toISOString();
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, pending_id, unread, verified, restored, " +
        "updated_at, last_event_at) VALUES (?, ?, 'codex', ?, NULL, 0, 1, 0, ?, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, " +
        "last_event_at = excluded.last_event_at",
    )
    .run(nodeId, fixture.workspaceId, state, at, at);
}

function interrupted() {
  return openEvents(fixture.database, lead, 50).filter(
    (event) => event.kind === "interrupted",
  );
}

function pending(taskId: string): number {
  return Number(
    (
      fixture.database
        .prepare(
          "SELECT recovery_pending AS flag FROM workflow_task_runs WHERE task_id = ?",
        )
        .get(taskId) as { flag: number }
    ).flag,
  );
}

function hints(member: string) {
  return pendingFor(fixture.database, member, 0).filter(
    (item) => item.messageKey?.startsWith("recovery:") === true,
  );
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
  clock = BASE;
  alive = new Set();
  scan = new RecoveryScan({
    database: fixture.database,
    clock: () => clock,
    alive: (nodeId) => alive.has(nodeId),
    record: (run, atMs) => recordInterrupted(fixture.collab, run, atMs),
    deliver: (run) => deliverRecoveryHint(fixture.collab, run),
  });
  // 启动宽限过后才扫。
  clock += 2 * RECOVERY_GRACE_MS;
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
});

describe("the startup scan", () => {
  it("records an interrupted event for a working item with no live session, once", async () => {
    const member = await dispatch("s:t1");
    status(member, "working");
    expect(scan.scan()).toBe(1);
    expect(interrupted()).toHaveLength(1);
    expect(interrupted()[0]).toMatchObject({
      itemId: "s:t1",
      sourceNodeId: member,
    });
    expect(interrupted()[0]?.id).toMatch(/^interrupted:s:t1:/);
    expect(pending("s:t1")).toBe(1);
    // 同一次中断不再记。
    expect(scan.scan()).toBe(0);
    expect(interrupted()).toHaveLength(1);
  });

  it("does not touch the item: no re-run, no delivery", async () => {
    const member = await dispatch("s:t1");
    status(member, "working");
    scan.scan();
    expect(hints(member)).toEqual([]);
    expect(
      fixture.database
        .prepare("SELECT status FROM workflow_task_runs WHERE task_id = 's:t1'")
        .get(),
    ).toEqual({ status: "running" });
  });

  it("skips items whose member is alive, idle, queued or finished", async () => {
    const live = await dispatch("s:live");
    status(live, "working");
    alive.add(live);
    const idle = await dispatch("s:idle");
    status(idle, "idle");
    // 第一条任务还在投递队列里：还没开始，不算中断。
    const queued = result(
      await controlDispatcher()!.dispatch(
        "open-agent",
        callerFor(fixture, lead),
        { agent: "codex", task: "x", "task-id": "s:queued" },
      ),
    ).id as string;
    status(queued, "working");
    const done = await dispatch("s:done");
    status(done, "working");
    fixture.database
      .prepare(
        "UPDATE workflow_task_runs SET status = 'done' WHERE task_id = 's:done'",
      )
      .run();
    expect(scan.scan()).toBe(0);
    expect(interrupted()).toEqual([]);
  });

  it("waits out the startup grace", async () => {
    const member = await dispatch("s:t1");
    status(member, "working");
    clock = BASE + RECOVERY_GRACE_MS / 2;
    expect(scan.scan()).toBe(0);
    clock = BASE + 2 * RECOVERY_GRACE_MS;
    expect(scan.scan()).toBe(1);
  });

  it("records a second interruption after the member resumed and died again", async () => {
    const member = await dispatch("s:t1");
    status(member, "working");
    expect(scan.scan()).toBe(1);
    // 续接：新会话；之后又结束。
    const session = fixture.session(member, "codex");
    alive.add(member);
    clock += 60_000;
    fixture.database
      .prepare(
        "UPDATE terminal_sessions SET status = 'exited', ended_at = ? WHERE id = ?",
      )
      .run(new Date(clock).toISOString(), session);
    alive.delete(member);
    clock += 2 * RECOVERY_GRACE_MS;
    expect(scan.scan()).toBe(1);
    expect(interrupted()).toHaveLength(2);
  });
});

describe("the recovery hint", () => {
  it("is delivered once, when the resumed member reports idle", async () => {
    const member = await dispatch("s:t1");
    status(member, "working");
    scan.scan();
    // 还没有活的会话 / 还没空闲：不投。
    expect(scan.onStatus(member, "idle")).toBe(0);
    alive.add(member);
    expect(scan.onStatus(member, "working")).toBe(0);
    expect(hints(member)).toEqual([]);
    expect(scan.onStatus(member, "idle")).toBe(1);
    const queued = hints(member);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.body).toBe(recoveryHint("s:t1"));
    expect(queued[0]?.origin).toBe("mailbox-wake");
    expect(pending("s:t1")).toBe(0);
    // 每次中断只投一次。
    expect(scan.onStatus(member, "idle")).toBe(0);
    expect(hints(member)).toHaveLength(1);
  });

  it("says what to check first and never to rerun blindly", () => {
    const hint = recoveryHint("s:t1");
    expect(hint).toContain("`s:t1`");
    expect(hint).toContain("worktree");
    expect(hint).toContain("canvas report");
  });

  it("is dropped silently when the item finished meanwhile", async () => {
    const member = await dispatch("s:t1");
    status(member, "working");
    scan.scan();
    fixture.database
      .prepare(
        "UPDATE workflow_task_runs SET status = 'failed' WHERE task_id = 's:t1'",
      )
      .run();
    alive.add(member);
    expect(scan.onStatus(member, "idle")).toBe(0);
    expect(pending("s:t1")).toBe(0);
    expect(hints(member)).toEqual([]);
  });
});
