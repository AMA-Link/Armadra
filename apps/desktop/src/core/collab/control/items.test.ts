import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentFixture,
  agentFixture,
  callerFor,
} from "../../agent/fixture";
import { taskRun } from "../../workflow/task-runs";
import { type ControlOutcome, controlDispatcher } from ".";
import { resetSendLimits } from "../send-limits";
import { resetInboxWake } from "../wake";
import { resetWaitTrackers } from "./wait";

/**
 * 工作项账本的三个动词（#682）：成员 `report` / `handback`，协调者 `items`。
 * 守的是：派发时写下标题、来源与授权；待决问题的单槽三种语义；只有要紧的报告
 * 才惊动协调者；同一项只能交回一次；谁能看哪一项。
 */

let fixture: AgentFixture;
let lead: string;

async function run(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, nodeId), args);
}

function ok(outcome: ControlOutcome): {
  message: string;
  result: Record<string, unknown>;
} {
  if (!outcome.ok) {
    throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  }
  return outcome.body as { message: string; result: Record<string, unknown> };
}

function refused(outcome: ControlOutcome): { status: number; message: string } {
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome;
}

async function dispatch(taskId: string, origin?: string): Promise<string> {
  const body = ok(
    await run(lead, "open-agent", {
      agent: "codex",
      task: `do ${taskId}`,
      "task-id": taskId,
      name: `task ${taskId}`,
      ...(origin === undefined ? {} : { origin }),
    }),
  );
  return body.result.id as string;
}

/** 协调者收件箱里的消息正文。 */
function leadInbox(): string[] {
  const rows = fixture.database
    .prepare(
      "SELECT body FROM agent_mailbox WHERE target_node_id = ? ORDER BY sequence",
    )
    .all(lead) as { body: string }[];
  return rows.map((row) => row.body);
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
});

describe("派发写账本", () => {
  it("open-agent --task-id 记下标题、来源与授权；--origin 优先于任务正文", async () => {
    await dispatch("t1", "把登录页的按钮改成蓝色");
    const run1 = taskRun(fixture.database, "t1");
    expect(run1?.title).toBe("task t1");
    expect(run1?.origin).toMatchObject({
      kind: "coordinator",
      ref: lead,
      text: "把登录页的按钮改成蓝色",
    });
    expect(run1?.mandate).toMatchObject({
      by: { nodeId: lead, title: "lead" },
      basis: "asked",
      scope: "task t1",
    });
    await dispatch("t2");
    expect(taskRun(fixture.database, "t2")?.origin?.text).toBe("do t2");
  });

  it("team 的每个成员各有一项工作项", async () => {
    const body = ok(
      await run(lead, "team", {
        member: ["codex|甲|做 A", "claude|乙|做 B"],
        origin: "把 A 和 B 都做了",
      }),
    );
    const members = body.result.members as { id: string }[];
    expect(members).toHaveLength(2);
    for (const member of members) {
      const item = taskRun(fixture.database, `team:${member.id}`);
      expect(item).toMatchObject({
        coordinatorNodeId: lead,
        nodeId: member.id,
        status: "running",
      });
      expect(item?.origin).toMatchObject({
        kind: "team",
        text: "把 A 和 B 都做了",
      });
    }
    const listed = ok(await run(lead, "items")).result;
    expect(listed.total).toBe(2);
  });
});

describe("report", () => {
  it("单槽：给出就换、省略就留、--clear-action 才清", async () => {
    const member = await dispatch("t1");
    ok(
      await run(member, "report", {
        state: "progress",
        summary: "在改",
        "human-action": "用哪种蓝？",
      }),
    );
    expect(taskRun(fixture.database, "t1")?.attention?.question).toBe(
      "用哪种蓝？",
    );
    ok(await run(member, "report", { state: "progress", summary: "还在改" }));
    expect(taskRun(fixture.database, "t1")?.attention?.question).toBe(
      "用哪种蓝？",
    );
    ok(
      await run(member, "report", {
        state: "progress",
        summary: "换个问法",
        "human-action": "主色还是强调色？",
      }),
    );
    expect(taskRun(fixture.database, "t1")?.attention?.question).toBe(
      "主色还是强调色？",
    );
    ok(
      await run(member, "report", {
        state: "progress",
        summary: "定了",
        "clear-action": true,
      }),
    );
    expect(taskRun(fixture.database, "t1")?.attention).toBeNull();
  });

  it("只有 ready / blocked / failed 与带问题的报告才进协调者收件箱", async () => {
    const member = await dispatch("t1");
    ok(await run(member, "report", { state: "progress", summary: "第一步" }));
    ok(await run(member, "report", { state: "waiting", summary: "等构建" }));
    expect(leadInbox()).toEqual([]);
    const ready = ok(
      await run(member, "report", { state: "ready", summary: "改好了" }),
    );
    expect(ready.result).toMatchObject({
      stage: "person/review",
      notified: true,
    });
    expect(leadInbox()).toHaveLength(1);
    expect(leadInbox()[0]).toContain("[工作项 t1] ready：改好了");
    expect(leadInbox()[0]).toContain("canvas items --item t1");
  });

  it("只有阶段变了或要紧的报告才推 workflow.task 帧", async () => {
    const member = await dispatch("t1");
    // 节点还没起来时是 working/queued；造一个活着的会话，进度报告前后都是 working。
    fixture.session(member, "codex");
    const frames = () =>
      fixture.events.filter((entry) => entry.event.type === "workflow.task")
        .length;
    ok(await run(member, "report", { state: "progress", summary: "第一步" }));
    const settled = frames();
    ok(await run(member, "report", { state: "progress", summary: "第二步" }));
    expect(frames()).toBe(settled);
    ok(await run(member, "report", { state: "ready", summary: "好了" }));
    expect(frames()).toBe(settled + 1);
  });

  it("名下有两项时要 --item；名下一项都没有就拒绝", async () => {
    const member = await dispatch("t1");
    // 同一个节点再挂一项（重试换节点的反方向：直接造一行）。
    fixture.database
      .prepare(
        "INSERT INTO workflow_task_runs (task_id, coordinator_node_id, runner_id, node_id, status, started_at) " +
          "VALUES ('t9', ?, 'codex', ?, 'running', ?)",
      )
      .run(lead, member, Date.now());
    const twice = refused(
      await run(member, "report", { state: "progress", summary: "x" }),
    );
    expect(twice.status).toBe(400);
    expect(twice.message).toContain("--item");
    ok(
      await run(member, "report", {
        state: "progress",
        summary: "x",
        item: "t9",
      }),
    );

    const stranger = fixture.agentNode("stranger", "codex");
    const none = refused(
      await run(stranger, "report", { state: "ready", summary: "我做完了" }),
    );
    expect(none.status).toBe(404);
  });

  it("不能报别人名下的项", async () => {
    await dispatch("t1");
    const other = await dispatch("t2");
    const wrong = refused(
      await run(other, "report", { state: "ready", summary: "x", item: "t1" }),
    );
    expect(wrong.status).toBe(404);
  });

  it("参数不对当场拒绝", async () => {
    const member = await dispatch("t1");
    expect(
      refused(await run(member, "report", { state: "done", summary: "x" }))
        .status,
    ).toBe(400);
    expect(
      refused(await run(member, "report", { state: "ready" })).status,
    ).toBe(400);
    expect(
      refused(
        await run(member, "report", {
          state: "ready",
          summary: "x",
          "human-action": "问",
          "clear-action": true,
        }),
      ).status,
    ).toBe(400);
    expect(
      refused(
        await run(member, "report", {
          state: "ready",
          summary: "长".repeat(301),
        }),
      ).status,
    ).toBe(400);
  });
});

describe("handback", () => {
  it("同一项只能交回一次，交回会告诉协调者", async () => {
    const member = await dispatch("t1");
    ok(await run(member, "handback", { reason: "这不是前端的事" }));
    expect(
      leadInbox().some((body) => body.includes("交回：这不是前端的事")),
    ).toBe(true);
    const again = refused(
      await run(member, "handback", { reason: "再交一次" }),
    );
    expect(again.status).toBe(409);
  });
});

describe("items", () => {
  it("要人处理的排在前面，带阶段、最近报告与待决问题", async () => {
    const a = await dispatch("a");
    const b = await dispatch("b");
    await dispatch("c");
    ok(await run(a, "report", { state: "progress", summary: "做着" }));
    ok(await run(b, "report", { state: "ready", summary: "做好了" }));
    const listed = ok(await run(lead, "items"));
    const rows = listed.result.items as {
      item: string;
      stage: string;
      report: unknown;
    }[];
    expect(rows[0]).toMatchObject({ item: "b", stage: "person/review" });
    expect(listed.message).toContain("做好了");
    const review = ok(
      await run(lead, "items", { stage: "person/review" }),
    ).result;
    expect(review.total).toBe(1);
  });

  it("分页给出下一页的 offset", async () => {
    for (const id of ["a", "b", "c"]) await dispatch(id);
    const first = ok(await run(lead, "items", { limit: 2 }));
    expect((first.result.items as unknown[]).length).toBe(2);
    expect(first.result.nextOffset).toBe(2);
    expect(first.message).toContain("--offset 2");
    const second = ok(await run(lead, "items", { limit: 2, offset: 2 }));
    expect((second.result.items as unknown[]).length).toBe(1);
    expect(second.result.nextOffset).toBeUndefined();
  });

  it("单项详情：授权、来源原文（长的要 --full）与报告历史", async () => {
    const member = await dispatch("t1", "原话".repeat(1_500));
    ok(await run(member, "report", { state: "progress", summary: "第一步" }));
    ok(await run(member, "handback", { reason: "超出范围" }));
    const shown = ok(await run(lead, "items", { item: "t1" }));
    expect(shown.message).toContain("授权：lead 派发");
    expect(shown.message).toContain("--full");
    expect(shown.message).toContain("progress：第一步");
    expect(shown.message).toContain("交回：超出范围");
    const full = ok(await run(lead, "items", { item: "t1", full: true }));
    expect(full.message).toContain("原话".repeat(1_500));
    expect(full.message).not.toContain("（原文更长");
  });

  it("成员只看得到自己那一项，别人的与不存在答同一句", async () => {
    const a = await dispatch("a");
    await dispatch("b");
    ok(await run(a, "items", { item: "a" }));
    expect(refused(await run(a, "items", { item: "b" })).status).toBe(404);
    expect(refused(await run(a, "items", { item: "zzz" })).status).toBe(404);
  });

  it("重试换节点时上一轮的报告与问题作废", async () => {
    const member = await dispatch("t1");
    ok(
      await run(member, "report", {
        state: "failed",
        summary: "构建挂了",
        "human-action": "要不要换分支？",
      }),
    );
    fixture.database
      .prepare(
        "UPDATE workflow_task_runs SET status = 'failed' WHERE task_id = 't1'",
      )
      .run();
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(member);
    await dispatch("t1");
    const again = taskRun(fixture.database, "t1");
    expect(again?.status).toBe("running");
    expect(again?.report).toBeNull();
    expect(again?.attention).toBeNull();
  });
});
