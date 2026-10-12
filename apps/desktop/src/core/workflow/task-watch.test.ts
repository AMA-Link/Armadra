import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { type ControlOutcome, controlDispatcher } from "../collab/control";
import { resetWaitTrackers } from "../collab/control/wait";
import { resetSendLimits } from "../collab/send-limits";
import { resetInboxWake } from "../collab/wake";
import { finishTask, reopenTask, taskRun } from "./task-runs";
import { TaskWatch } from "./task-watch";

/**
 * core 自己盯着 `running` 的任务行（契约 §15.7，G5-09）：没人 `wait` 时也落
 * 结束、每次换状态推一帧 `workflow.task`，`wait` 读到已结束的行立即答。
 */

let fixture: AgentFixture;
let lead: string;
let watch: TaskWatch;

async function run(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, nodeId), args);
}

function result(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  }
  return outcome.body.result as Record<string, unknown>;
}

function report(nodeId: string, state: string, at: number): void {
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, " +
        "updated_at, last_event_at) VALUES (?, ?, 'codex', ?, 0, 1, 0, ?, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, last_event_at = excluded.last_event_at",
    )
    .run(
      nodeId,
      fixture.workspaceId,
      state,
      new Date(at).toISOString(),
      new Date(at).toISOString(),
    );
}

function deliverAll(nodeId: string): void {
  fixture.database
    .prepare(
      "UPDATE agent_send_queue SET state = 'done' WHERE target_node_id = ?",
    )
    .run(nodeId);
}

async function openTask(taskId: string): Promise<string> {
  const body = result(
    await run(lead, "open-agent", {
      agent: "codex",
      task: `do ${taskId}`,
      "task-id": taskId,
    }),
  );
  return body.id as string;
}

function taskFrames(): { taskId: string; status: string }[] {
  return fixture.events
    .map((entry) => entry.event)
    .filter((event) => event.type === "workflow.task")
    .map((event) => {
      const frame = event as { taskId: string; status: string };
      return { taskId: frame.taskId, status: frame.status };
    });
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
  watch = new TaskWatch({
    database: fixture.database,
    publish: () => fixture.collab.publish,
    everyMs: false,
  });
});

afterEach(() => {
  watch.stop();
  fixture.close();
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
});

describe("task watch", () => {
  it("publishes workflow.task when a task starts, and settles a clean turn with nobody waiting", async () => {
    const member = await openTask("s1:t1");
    expect(taskFrames()).toEqual([{ taskId: "s1:t1", status: "running" }]);
    const frame = fixture.events.find(
      (entry) => entry.event.type === "workflow.task",
    );
    expect(frame?.workspaceId).toBe(fixture.workspaceId);
    expect(frame?.event).toMatchObject({
      boardId: fixture.boardId,
      coordinatorNodeId: lead,
      nodeId: member,
    });

    // 还排着：不落。
    expect(watch.sweep()).toBe(0);
    deliverAll(member);
    report(member, "working", 1_000);
    expect(watch.sweep()).toBe(0);
    report(member, "done", 2_000);
    expect(watch.sweep()).toBe(1);
    expect(taskRun(fixture.database, "s1:t1")?.status).toBe("done");
    expect(taskFrames().at(-1)).toEqual({ taskId: "s1:t1", status: "done" });
    // 落过的不再落，也不再推。
    expect(watch.sweep()).toBe(0);
    expect(taskFrames()).toHaveLength(2);
  });

  it("settles a retried task from the member's result post, leaving the post unacknowledged", async () => {
    const member = await openTask("s1:t2");
    finishTask(
      fixture.database,
      "s1:t2",
      "failed",
      { reason: "turnFailed" },
      1_000,
    );
    // 人在抽屉里点了重试：行回到 running，协调者不会再 wait。
    expect(reopenTask(fixture.database, "s1:t2", 2_000)).toBe(true);
    deliverAll(member);
    report(member, "working", 3_000);
    watch.sweep();
    expect(
      await run(member, "post", {
        to: lead,
        key: "task:s1:t2:result",
        body: "all green",
      }),
    ).toMatchObject({ ok: true });
    expect(watch.sweep()).toBe(1);
    const row = taskRun(fixture.database, "s1:t2");
    expect(row?.status).toBe("done");
    expect(row?.result).toMatchObject({ text: "all green", task: "do s1:t2" });
    const unread = fixture.database
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_mailbox WHERE message_key = 'task:s1:t2:result' AND acknowledged_at IS NULL",
      )
      .get() as { n: number };
    expect(Number(unread.n)).toBe(1);
  });

  it("settles a failed turn and a deleted member", async () => {
    const failing = await openTask("s1:t3");
    const deleted = await openTask("s1:t4");
    deliverAll(failing);
    report(failing, "working", 1_000);
    watch.sweep();
    fixture.database
      .prepare(
        "UPDATE agent_status SET state = 'done', errored = 1, last_event_at = ? WHERE node_id = ?",
      )
      .run(new Date(2_000).toISOString(), failing);
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(deleted);
    expect(watch.sweep()).toBe(2);
    expect(taskRun(fixture.database, "s1:t3")).toMatchObject({
      status: "failed",
      result: { reason: "turnFailed" },
    });
    expect(taskRun(fixture.database, "s1:t4")).toMatchObject({
      status: "failed",
      result: { reason: "nodeDeleted" },
    });
  });

  it("leaves the ending to a coordinator that is waiting, with its own baseline", async () => {
    const member = await openTask("s1:t8");
    deliverAll(member);
    // 协调者在等：取基准、看到这一轮在跑。
    const first = result(
      await run(lead, "wait", { task: "s1:t8", timeout: "0" }),
    );
    expect(first.status).toBe("running");
    report(member, "working", 1_000);
    watch.sweep();
    report(member, "done", 2_000);
    // 刚等过：只看不落。
    expect(watch.sweep()).toBe(0);
    expect(taskRun(fixture.database, "s1:t8")?.status).toBe("running");
    const answer = result(
      await run(lead, "wait", { task: "s1:t8", timeout: "0" }),
    );
    expect(answer.status).toBe("done");
    expect(taskRun(fixture.database, "s1:t8")?.status).toBe("done");
  });

  it("lets wait answer at once from a row the watch already settled", async () => {
    const member = await openTask("s1:t5");
    deliverAll(member);
    report(member, "working", 1_000);
    watch.sweep();
    report(member, "done", 2_000);
    watch.sweep();
    const started = Date.now();
    const answer = result(
      await run(lead, "wait", { task: "s1:t5", timeout: "5" }),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(answer).toMatchObject({ status: "done" });

    const other = await openTask("s1:t7");
    finishTask(
      fixture.database,
      "s1:t7",
      "failed",
      { reason: "turnInterrupted" },
      3_000,
    );
    expect(other).not.toBe(member);
    expect(
      result(await run(lead, "wait", { task: "s1:t7", timeout: "5" })),
    ).toMatchObject({ status: "failed", reason: "turnInterrupted" });
  });
});
