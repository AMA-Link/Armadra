import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { setStallSource, stalledOf } from "../agent/stalled";
import { recordReport } from "./work-items";
import { TriggerRules } from "../push/triggers";
import { listSessions } from "../terminal/install";
import { type ControlOutcome, controlDispatcher } from "../collab/control";
import { resetWaitTrackers } from "../collab/control/wait";
import { resetSendLimits } from "../collab/send-limits";
import { pendingFor } from "../collab/send-queue";
import { queueWatchWake, resetInboxWake } from "../collab/wake";
import {
  ProgressWatchdog,
  type WatchdogThresholds,
  type WatchdogWake,
} from "./progress-watchdog";
import { TaskWatch } from "./task-watch";

/**
 * 进展看门狗（契约 §91）：三种判定的触发与不触发、去重、状态恢复后重新计时、
 * 标记随 `agent.status` 帧走、协调者收到一条唤醒、只提示不处置。
 */

const MINUTE = 60_000;
const BASE = Date.now();

let fixture: AgentFixture;
let lead: string;
let clock: number;
let limits: WatchdogThresholds;
let output: Map<string, number>;
let wakes: WatchdogWake[];
let dog: ProgressWatchdog;

function result(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  return outcome.body.result as Record<string, unknown>;
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
  fixture.session(member, "codex");
  fixture.database
    .prepare(
      "UPDATE agent_send_queue SET state = 'done' WHERE target_node_id = ?",
    )
    .run(member);
  return member;
}

function report(
  nodeId: string,
  state: string,
  minutesAgo: number,
  extra: { pendingId?: string; lastMessage?: string } = {},
): void {
  const at = new Date(clock - minutesAgo * MINUTE).toISOString();
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, pending_id, unread, verified, restored, " +
        "updated_at, last_event_at) VALUES (?, ?, 'codex', ?, ?, 0, 1, 0, ?, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, pending_id = excluded.pending_id, " +
        "updated_at = excluded.updated_at, last_event_at = excluded.last_event_at",
    )
    .run(nodeId, fixture.workspaceId, state, extra.pendingId ?? null, at, at);
}

function statusFrames(nodeId: string): { stalled?: string }[] {
  const frames: { nodeId?: string; stalled?: string }[] = [];
  for (const { event } of fixture.events) {
    if (event.type !== "agent.status") continue;
    frames.push(event.status as { nodeId?: string; stalled?: string });
  }
  return frames.filter((status) => status.nodeId === nodeId);
}

function wakeQueue(): ReturnType<typeof pendingFor> {
  return pendingFor(fixture.database, lead, 0).filter(
    (item) => item.origin === "mailbox-wake",
  );
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
  clock = BASE;
  limits = { stalledMs: 10 * MINUTE, needsHumanMs: 15 * MINUTE };
  output = new Map();
  wakes = [];
  dog = new ProgressWatchdog({
    database: fixture.database,
    publish: () => fixture.collab.publish,
    thresholds: () => limits,
    lastOutputAt: (nodeId) => output.get(nodeId),
    running: () => true,
    wake: (wake) => {
      wakes.push(wake);
      queueWatchWake(fixture.collab, wake);
    },
    clock: () => clock,
  });
  setStallSource(dog);
});

afterEach(() => {
  setStallSource(undefined);
  fixture.close();
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
});

describe("stalled", () => {
  it("marks a working node that has been silent past the threshold, once", async () => {
    const member = await dispatch("s:t1");
    report(member, "working", 11, { lastMessage: "SECRET terminal text" });
    expect(dog.scan()).toBe(1);

    const frames = statusFrames(member);
    expect(frames.at(-1)?.stalled).toBe("stalled");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      coordinatorNodeId: lead,
      memberNodeId: member,
      taskId: "s:t1",
      reason: "stalled",
      minutes: 11,
    });
    const queued = wakeQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.targetNodeId).toBe(lead);
    expect(queued[0]?.body).toContain("11 分钟");
    expect(queued[0]?.body).not.toContain("SECRET");
    expect(fixture.nudged).toContain(lead);

    // 同一个判定不重复提示：没有新帧、没有新唤醒。
    const frameCount = statusFrames(member).length;
    expect(dog.scan()).toBe(0);
    expect(statusFrames(member)).toHaveLength(frameCount);
    expect(wakes).toHaveLength(1);
  });

  it("does not mark a node with a recent report, recent output, or the rule switched off", async () => {
    const member = await dispatch("s:t2");
    report(member, "working", 9);
    expect(dog.scan()).toBe(0);

    report(member, "working", 30);
    output.set(member, clock - 2 * MINUTE);
    expect(dog.scan()).toBe(0);

    output.delete(member);
    limits = { stalledMs: 0, needsHumanMs: 15 * MINUTE };
    expect(dog.scan()).toBe(0);
    expect(wakes).toHaveLength(0);
    expect(dog.size()).toBe(0);
  });

  it("skips nodes without a live session or whose CLI said it ended", async () => {
    const member = await dispatch("s:t3");
    report(member, "working", 30);
    fixture.database
      .prepare(
        "UPDATE agent_status SET session_phase = 'end' WHERE node_id = ?",
      )
      .run(member);
    expect(dog.scan()).toBe(0);
  });

  it("drops the mark on the node's next report and times again afterwards", async () => {
    const member = await dispatch("s:t4");
    report(member, "working", 11);
    expect(dog.scan()).toBe(1);
    const row = fixture.database
      .prepare(
        "SELECT state, last_event_at AS lastEventAt FROM agent_status WHERE node_id = ?",
      )
      .get(member) as { state: string; lastEventAt: string };
    expect(stalledOf({ nodeId: member, ...row })).toBe("stalled");

    // 新的上报：指纹对不上，帧上立刻不带标记，不必等下一次扫描。
    report(member, "working", 0);
    const fresh = fixture.database
      .prepare(
        "SELECT state, last_event_at AS lastEventAt FROM agent_status WHERE node_id = ?",
      )
      .get(member) as { state: string; lastEventAt: string };
    expect(stalledOf({ nodeId: member, ...fresh })).toBeUndefined();

    // 扫描发现不再满足：摘掉标记并推一帧不带标记的。
    expect(dog.scan()).toBe(0);
    expect(dog.size()).toBe(0);
    expect(statusFrames(member).at(-1)?.stalled).toBeUndefined();

    // 重新计时：又静默超过阈值，再提示一次。
    clock += 11 * MINUTE;
    expect(dog.scan()).toBe(1);
    expect(wakes).toHaveLength(2);
    expect(statusFrames(member).at(-1)?.stalled).toBe("stalled");
  });
});

describe("one of each", () => {
  it("a silent working node yields exactly one marked frame, one push draft and one coordinator wake across repeated scans", async () => {
    const member = await dispatch("s:t0");
    report(member, "working", 12, { lastMessage: "TERMINAL-OUTPUT-SECRET" });
    for (let round = 0; round < 4; round += 1) {
      clock += MINUTE;
      dog.scan();
    }
    // 页面：带标记的帧只有一帧。
    expect(
      statusFrames(member).filter((frame) => frame.stalled === "stalled"),
    ).toHaveLength(1);
    // 推送：把看门狗发出去的帧原样喂给推送规则，只出一条草稿，且不带终端原文。
    const rules = new TriggerRules();
    const drafts = fixture.events
      .map((entry) => rules.draft(entry.workspaceId, entry.event))
      .filter((draft) => draft !== undefined);
    expect(drafts.map((draft) => draft.kind)).toEqual(["stalled"]);
    expect(JSON.stringify(drafts)).not.toContain("TERMINAL-OUTPUT-SECRET");
    // 协调者：一条唤醒，经同一条队列。
    expect(wakes).toHaveLength(1);
    expect(wakeQueue()).toHaveLength(1);
  });
});

describe("session list", () => {
  it("carries the mark so a reload or reconnect rebuilds it, and drops it with the next report", async () => {
    const member = await dispatch("s:t9");
    report(member, "working", 11);
    dog.scan();
    const rows = () =>
      listSessions(fixture.database, fixture.workspaceId, () => true).filter(
        (row) => row.nodeId === member,
      );
    expect(rows()[0]?.stalled).toBe("stalled");
    report(member, "working", 0);
    expect(rows()[0]?.stalled).toBeUndefined();
  });
});

describe("idle waiting", () => {
  it("marks an idle member whose task has no conclusion", async () => {
    const member = await dispatch("s:t5");
    report(member, "done", 11);
    // 任务也是 11 分钟以前开始的。
    fixture.database
      .prepare("UPDATE workflow_task_runs SET started_at = ? WHERE task_id = ?")
      .run(clock - 12 * MINUTE, "s:t5");
    expect(dog.scan()).toBe(1);
    expect(statusFrames(member).at(-1)?.stalled).toBe("idleWaiting");
    expect(wakes[0]).toMatchObject({ reason: "idleWaiting", taskId: "s:t5" });
    expect(dog.scan()).toBe(0);
  });

  it("stays quiet while the first task is still queued, after a conclusion post, or when the task has ended", async () => {
    const member = await dispatch("s:t6");
    fixture.database
      .prepare("UPDATE workflow_task_runs SET started_at = ? WHERE task_id = ?")
      .run(clock - 30 * MINUTE, "s:t6");
    report(member, "done", 20);

    // 投递还没完成。
    fixture.database
      .prepare(
        "UPDATE agent_send_queue SET state = 'queued' WHERE target_node_id = ?",
      )
      .run(member);
    expect(dog.scan()).toBe(0);
    fixture.database
      .prepare(
        "UPDATE agent_send_queue SET state = 'done' WHERE target_node_id = ?",
      )
      .run(member);

    // 成员 post 过这个任务的结论。
    fixture.database
      .prepare(
        "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, message_key, body, created_at, expires_at) " +
          "VALUES ('m1', ?, ?, ?, 'task:s:t6:result', 'done', ?, ?)",
      )
      .run(
        fixture.workspaceId,
        member,
        lead,
        Math.floor(clock / 1000),
        Math.floor(clock / 1000) + 3600,
      );
    expect(dog.scan()).toBe(0);
    fixture.database.prepare("DELETE FROM agent_mailbox").run();

    // 任务已经结束。
    fixture.database
      .prepare(
        "UPDATE workflow_task_runs SET status = 'done' WHERE task_id = ?",
      )
      .run("s:t6");
    expect(dog.scan()).toBe(0);
    expect(wakes).toHaveLength(0);
  });
});

describe("idle waiting and work-item stages", () => {
  it("does not call it idle waiting once the item is with a person (person/*), and does again when the report is cleared", async () => {
    const member = await dispatch("s:t10");
    fixture.database
      .prepare("UPDATE workflow_task_runs SET started_at = ? WHERE task_id = ?")
      .run(clock - 30 * MINUTE, "s:t10");
    report(member, "done", 20);
    // 成员报了 ready：工作项在 `person/review`，是在等人验收。
    recordReport(fixture.database, "s:t10", {
      state: "ready",
      summary: "done",
      attention: undefined,
      nowMs: clock - 5 * MINUTE,
    });
    expect(dog.scan()).toBe(0);
    expect(wakes).toHaveLength(0);
    expect(wakeQueue()).toHaveLength(0);

    // 报告撤掉之后（回到 idle），照常判空等。
    fixture.database
      .prepare(
        "UPDATE workflow_task_runs SET report_json = NULL WHERE task_id = ?",
      )
      .run("s:t10");
    expect(dog.scan()).toBe(1);
    expect(wakes[0]).toMatchObject({ reason: "idleWaiting" });
  });
});

describe("needs a human", () => {
  it("marks a node waiting for a person past the threshold, without waking anyone when it is not a task member", () => {
    const loner = fixture.agentNode("loner", "claude");
    fixture.session(loner, "claude");
    report(loner, "blocked", 14, { pendingId: "p1" });
    expect(dog.scan()).toBe(0);

    report(loner, "blocked", 16, { pendingId: "p1" });
    expect(dog.scan()).toBe(1);
    expect(statusFrames(loner).at(-1)?.stalled).toBe("needsHuman");
    expect(wakes).toHaveLength(0);
    expect(dog.scan()).toBe(0);
  });

  it("wakes the coordinator with a message that does not ask it to answer for the person", async () => {
    const member = await dispatch("s:t7");
    report(member, "waiting", 20);
    expect(dog.scan()).toBe(1);
    const body = wakeQueue()[0]?.body ?? "";
    expect(body).toContain("等人处理");
    expect(body).toContain("不要替人回答");
  });
});

describe("advisory only", () => {
  it("never writes input into the node or changes its state", async () => {
    const member = await dispatch("s:t8");
    report(member, "working", 40);
    const before = fixture.database
      .prepare(
        "SELECT state, last_event_at FROM agent_status WHERE node_id = ?",
      )
      .get(member);
    dog.scan();
    expect(
      fixture.database
        .prepare(
          "SELECT state, last_event_at FROM agent_status WHERE node_id = ?",
        )
        .get(member),
    ).toEqual(before);
    expect(fixture.terminal.writes).toHaveLength(0);
    expect(fixture.terminal.terminated).toHaveLength(0);
  });
});

describe("task watch tick", () => {
  it("rides the 60 second scan instead of arming its own timer", () => {
    let ticks = 0;
    const watch = new TaskWatch({
      database: fixture.database,
      publish: () => fixture.collab.publish,
      everyMs: false,
      onTick: () => {
        ticks += 1;
      },
    });
    watch.sweep();
    expect(ticks).toBe(0);
    watch.tick();
    expect(ticks).toBe(1);
    watch.stop();
    watch.tick();
    expect(ticks).toBe(1);
  });
});
