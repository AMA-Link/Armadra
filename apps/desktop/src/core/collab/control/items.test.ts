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
import { ORIGIN_SEGMENT_BYTES, originSegment } from "./items";

/**
 * 工作项账本的三个动词（契约 §90）：`report` 的单槽三种语义、没有工作项就拒绝、
 * `handback` 只能一次、`items` 分页与单项详情。
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

function result(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  }
  return outcome.body.result as Record<string, unknown>;
}

function refused(outcome: ControlOutcome): { status: number; code: string } {
  if (outcome.ok) throw new Error("expected a refusal");
  return { status: outcome.status, code: outcome.code };
}

async function dispatch(
  taskId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return result(
    await run(lead, "open-agent", {
      agent: "codex",
      task: `do ${taskId}`,
      "task-id": taskId,
      name: `member ${taskId}`,
      ...extra,
    }),
  ).id as string;
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

describe("the ledger row", () => {
  it("is written at dispatch with a title, an origin and an immutable mandate", async () => {
    const member = await dispatch("s1:t1", { task: "fix the login" });
    const row = taskRun(fixture.database, "s1:t1")!;
    expect(row).toMatchObject({
      nodeId: member,
      title: "fix the login",
      origin: { kind: "human", ref: lead, text: "fix the login" },
      mandate: { by: lead, basis: "asked", scope: "dispatch" },
      report: null,
      attention: null,
    });
    const mandate = row.mandate;
    // 报告、交回都不改授权。
    result(await run(member, "report", { state: "progress", summary: "x" }));
    result(await run(member, "handback", { item: "s1:t1", reason: "y" }));
    expect(taskRun(fixture.database, "s1:t1")!.mandate).toEqual(mandate);
  });

  it("takes --item-title over the node name", async () => {
    await dispatch("s1:t9", {
      "item-title": "审查登录",
      task: "审查登录接口\n\nWhen done, report",
    });
    expect(taskRun(fixture.database, "s1:t9")!.title).toBe("审查登录");
  });

  it("caps the title at 80 characters", async () => {
    await dispatch("s1:long", { title: "题".repeat(120) });
    expect([
      ...(taskRun(fixture.database, "s1:long")!.title ?? ""),
    ]).toHaveLength(80);
  });

  it("gives every canvas_team member a row", async () => {
    const body = result(
      await run(lead, "team", {
        member: ["codex|实现|实现登录", "claude|审阅|审阅实现"],
      }),
    ) as { members: { id: string; item: string }[] };
    expect(body.members).toHaveLength(2);
    for (const member of body.members) {
      expect(taskRun(fixture.database, member.item)).toMatchObject({
        nodeId: member.id,
        coordinatorNodeId: lead,
        status: "running",
      });
    }
    expect(taskRun(fixture.database, body.members[0]!.item)!.title).toBe(
      "实现",
    );
  });
});

describe("report", () => {
  it("defaults to the only running item under the node", async () => {
    const member = await dispatch("s1:t1");
    const body = result(
      await run(member, "report", { state: "progress", summary: "half way" }),
    );
    expect(body).toMatchObject({ item: "s1:t1", state: "progress" });
    expect(taskRun(fixture.database, "s1:t1")!.report).toMatchObject({
      state: "progress",
      summary: "half way",
    });
  });

  it("is refused when nothing is under the node's name", async () => {
    const stranger = fixture.agentNode("stranger", "codex");
    expect(
      refused(await run(stranger, "report", { state: "ready", summary: "x" })),
    ).toEqual({ status: 404, code: "no_work_item" });
    // 协调者自己名下也没有。
    expect(
      refused(await run(lead, "report", { state: "ready", summary: "x" })).code,
    ).toBe("no_work_item");
  });

  it("will not report on somebody else's item", async () => {
    await dispatch("s1:t1");
    const other = await dispatch("s1:t2");
    expect(
      refused(
        await run(other, "report", {
          state: "ready",
          summary: "x",
          item: "s1:t1",
        }),
      ).code,
    ).toBe("item_not_found");
  });

  it("asks for --item when two are running, and when none is", async () => {
    const member = await dispatch("s1:t1");
    // 同一个节点再挂一行：重试换绑之类会出现。
    fixture.database
      .prepare(
        "INSERT INTO workflow_task_runs (task_id, coordinator_node_id, runner_id, node_id, status, started_at) " +
          "VALUES ('s1:t2', ?, 'codex', ?, 'running', 5)",
      )
      .run(lead, member);
    expect(
      refused(await run(member, "report", { state: "ready", summary: "x" }))
        .code,
    ).toBe("ambiguous_item");
    fixture.database
      .prepare("UPDATE workflow_task_runs SET status = 'done'")
      .run();
    expect(
      refused(await run(member, "report", { state: "ready", summary: "x" }))
        .code,
    ).toBe("no_running_item");
    result(
      await run(member, "report", {
        state: "ready",
        summary: "x",
        item: "s1:t2",
      }),
    );
  });

  it("holds the question slot: given replaces, omitted keeps, cleared removes", async () => {
    const member = await dispatch("s1:t1");
    const attention = () => taskRun(fixture.database, "s1:t1")!.attention;

    result(
      await run(member, "report", {
        state: "waiting",
        summary: "stuck",
        "human-action": "A or B?",
      }),
    );
    expect(attention()).toMatchObject({ question: "A or B?" });

    result(await run(member, "report", { state: "progress", summary: "next" }));
    expect(attention()).toMatchObject({ question: "A or B?" });

    result(
      await run(member, "report", {
        state: "waiting",
        summary: "still",
        "human-action": "C or D?",
      }),
    );
    expect(attention()).toMatchObject({ question: "C or D?" });

    result(
      await run(member, "report", {
        state: "progress",
        summary: "answered",
        "clear-action": true,
      }),
    );
    expect(attention()).toBeNull();
  });

  it("validates its arguments", async () => {
    const member = await dispatch("s1:t1");
    const code = async (args: Record<string, unknown>) =>
      refused(await run(member, "report", args)).code;
    expect(await code({ state: "done", summary: "x" })).toBe("bad_request");
    expect(await code({ state: "ready" })).toBe("bad_request");
    expect(await code({ state: "ready", summary: "x".repeat(301) })).toBe(
      "bad_request",
    );
    expect(
      await code({
        state: "ready",
        summary: "x",
        "human-action": "q",
        "clear-action": true,
      }),
    ).toBe("bad_request");
    expect(
      await code({ state: "ready", summary: "x", "human-action": true }),
    ).toBe("bad_request");
    result(
      await run(member, "report", { state: "ready", summary: "x".repeat(300) }),
    );
  });

  it("keeps a bounded history, newest last", async () => {
    const member = await dispatch("s1:t1");
    for (let index = 0; index < 25; index += 1) {
      result(
        await run(member, "report", {
          state: "progress",
          summary: `step ${index}`,
        }),
      );
    }
    const row = taskRun(fixture.database, "s1:t1")!;
    expect(row.reports).toHaveLength(20);
    expect(row.reports.at(-1)?.summary).toBe("step 24");
    expect(row.report?.summary).toBe("step 24");
  });

  it("moves the stage and tells the board with a workflow.task frame", async () => {
    const member = await dispatch("s1:t1");
    const before = fixture.events.length;
    expect(
      result(await run(member, "report", { state: "ready", summary: "done" }))
        .stage,
    ).toBe("person/review");
    expect(taskRun(fixture.database, "s1:t1")!.stage).toBe("person/review");
    expect(
      fixture.events
        .slice(before)
        .some((entry) => entry.event.type === "workflow.task"),
    ).toBe(true);
  });
});

describe("handback", () => {
  it("is allowed once per item", async () => {
    const member = await dispatch("s1:t1");
    result(
      await run(member, "handback", { item: "s1:t1", reason: "not mine" }),
    );
    expect(taskRun(fixture.database, "s1:t1")!.handback).toMatchObject({
      reason: "not mine",
    });
    expect(
      refused(
        await run(member, "handback", { item: "s1:t1", reason: "again" }),
      ),
    ).toEqual({ status: 409, code: "already_handed_back" });
    expect(taskRun(fixture.database, "s1:t1")!.handback?.reason).toBe(
      "not mine",
    );
  });

  it("needs an item of its own and a reason of at most 100 characters", async () => {
    const member = await dispatch("s1:t1");
    const other = await dispatch("s1:t2");
    expect(
      refused(await run(member, "handback", { item: "s1:t2", reason: "x" }))
        .code,
    ).toBe("item_not_found");
    expect(refused(await run(member, "handback", { reason: "x" })).code).toBe(
      "bad_request",
    );
    expect(
      refused(
        await run(other, "handback", {
          item: "s1:t2",
          reason: "x".repeat(101),
        }),
      ).code,
    ).toBe("bad_request");
  });
});

describe("items", () => {
  async function seed(count: number): Promise<string[]> {
    const members: string[] = [];
    for (let index = 0; index < count; index += 1) {
      members.push(await dispatch(`s1:t${index}`, { title: `job ${index}` }));
    }
    return members;
  }

  it("lists one line per item, person/* first", async () => {
    const members = await seed(3);
    result(
      await run(members[1]!, "report", {
        state: "waiting",
        summary: "need a call",
        "human-action": "A or B?",
      }),
    );
    const outcome = await run(lead, "items");
    const body = result(outcome) as {
      items: { id: string; stage: string }[];
      total: number;
    };
    expect(body.total).toBe(3);
    expect(body.items[0]).toMatchObject({
      id: "s1:t1",
      stage: "person/answer",
    });
    const text = (outcome as { ok: true; body: { message: string } }).body
      .message;
    const first = text.split("\n")[0]!;
    expect(first).toContain("s1:t1");
    expect(first).toContain("job 1");
    expect(first).toContain("person/answer");
    expect(first).toContain("waiting: need a call");
    expect(first).toContain("? A or B?");
  });

  it("filters by stage", async () => {
    const members = await seed(2);
    result(await run(members[0]!, "report", { state: "ready", summary: "ok" }));
    const body = result(
      await run(lead, "items", { stage: "person/review" }),
    ) as {
      items: { id: string }[];
    };
    expect(body.items.map((item) => item.id)).toEqual(["s1:t0"]);
    expect(refused(await run(lead, "items", { stage: "nope" })).code).toBe(
      "bad_request",
    );
  });

  it("pages with limit and offset and says where to continue", async () => {
    await seed(5);
    const first = result(await run(lead, "items", { limit: 2 })) as {
      items: unknown[];
      next: number | null;
      total: number;
    };
    expect(first).toMatchObject({ total: 5, next: 2 });
    expect(first.items).toHaveLength(2);
    const second = result(
      await run(lead, "items", { limit: 2, offset: 2 }),
    ) as { items: { id: string }[]; next: number | null };
    expect(second.next).toBe(4);
    const last = result(await run(lead, "items", { limit: 2, offset: 4 })) as {
      items: unknown[];
      next: number | null;
    };
    expect(last.items).toHaveLength(1);
    expect(last.next).toBeNull();
    const seen = new Set<string>();
    for (const offset of [0, 2, 4]) {
      const page = result(await run(lead, "items", { limit: 2, offset })) as {
        items: { id: string }[];
      };
      for (const item of page.items) seen.add(item.id);
    }
    expect(seen.size).toBe(5);
  });

  it("shows one item with its history, mandate and the origin text in segments", async () => {
    const long = "题".repeat(1500); // 4500 bytes
    const member = await dispatch("s1:big", { task: long, title: "big" });
    result(await run(member, "report", { state: "progress", summary: "one" }));
    result(await run(member, "report", { state: "ready", summary: "two" }));
    const first = result(await run(lead, "items", { item: "s1:big" })) as {
      mandate: { by: string };
      reports: { summary: string }[];
      origin: { text: string; to: number; size: number; next: number | null };
    };
    expect(first.mandate.by).toBe(lead);
    expect(first.reports.map((entry) => entry.summary)).toEqual(["one", "two"]);
    expect(first.origin.size).toBe(4500);
    expect(first.origin.next).toBe(first.origin.to);
    let text = first.origin.text;
    let next = first.origin.next;
    while (next !== null) {
      const more = result(
        await run(lead, "items", { item: "s1:big", offset: next }),
      ) as { origin: { text: string; next: number | null } };
      text += more.origin.text;
      next = more.origin.next;
    }
    expect(text).toBe(long);
  });

  it("answers 404 for an unknown item and shows a member only its own", async () => {
    const members = await seed(2);
    expect(refused(await run(lead, "items", { item: "nope" })).code).toBe(
      "item_not_found",
    );
    const own = result(await run(members[0]!, "items")) as {
      items: { id: string }[];
    };
    expect(own.items.map((item) => item.id)).toEqual(["s1:t0"]);
    expect(
      refused(await run(members[0]!, "items", { item: "s1:t1" })).code,
    ).toBe("item_not_found");
  });
});

describe("originSegment", () => {
  it("cuts on character boundaries so the segments join back into the text", () => {
    const text = `a${"题".repeat(2000)}b`;
    let offset = 0;
    let joined = "";
    for (;;) {
      const part = originSegment(text, offset);
      expect(part.to - part.from).toBeLessThanOrEqual(ORIGIN_SEGMENT_BYTES);
      joined += part.text;
      if (part.to >= part.size) break;
      offset = part.to;
    }
    expect(joined).toBe(text);
  });
});

describe("the stage read from the board's facts", () => {
  async function stageOf(taskId: string): Promise<string> {
    return (
      result(await run(lead, "items", { item: taskId })) as { stage: string }
    ).stage;
  }

  /** 成员已经起来了：依赖编排的启动行落成 launched，首条任务也投完了。 */
  function started(nodeId: string): void {
    fixture.database
      .prepare(
        "UPDATE agent_dependency_launches SET state = 'launched' WHERE node_id = ?",
      )
      .run(nodeId);
    fixture.database
      .prepare(
        "UPDATE agent_send_queue SET state = 'done' WHERE target_node_id = ?",
      )
      .run(nodeId);
  }

  function setStatus(nodeId: string, state: string): void {
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at, last_event_at) " +
          "VALUES (?, ?, 'codex', ?, 0, 1, 0, ?, ?) " +
          "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state",
      )
      .run(
        nodeId,
        fixture.workspaceId,
        state,
        new Date().toISOString(),
        new Date().toISOString(),
      );
  }

  it("queued while the member has not started or its first task waits, person/delivery when the delivery died", async () => {
    const member = await dispatch("s1:t1");
    expect(await stageOf("s1:t1")).toBe("working/queued");
    started(member);
    fixture.database
      .prepare(
        "UPDATE agent_send_queue SET state = 'queued' WHERE target_node_id = ?",
      )
      .run(member);
    expect(await stageOf("s1:t1")).toBe("working/queued");
    fixture.database
      .prepare(
        "UPDATE agent_send_queue SET state = 'expired' WHERE target_node_id = ?",
      )
      .run(member);
    expect(await stageOf("s1:t1")).toBe("person/delivery");
    // 缓存列跟着走，但以函数为准。
    expect(taskRun(fixture.database, "s1:t1")!.stage).toBe("person/delivery");
  });

  it("idle when the node is idle with nothing unread, working when mail waits", async () => {
    const member = await dispatch("s1:t1");
    started(member);
    setStatus(member, "working");
    expect(await stageOf("s1:t1")).toBe("working");
    setStatus(member, "idle");
    expect(await stageOf("s1:t1")).toBe("idle");
    fixture.database
      .prepare(
        "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, message_key, body, created_at, expires_at) " +
          "VALUES ('m1', ?, ?, ?, 'k1', 'hi', 1, 9999999999)",
      )
      .run(fixture.workspaceId, lead, member);
    expect(await stageOf("s1:t1")).toBe("working");
  });

  it("a stale cached stage is overridden by the facts", async () => {
    const member = await dispatch("s1:t1");
    started(member);
    fixture.database
      .prepare("UPDATE workflow_task_runs SET stage = 'person/review'")
      .run();
    expect(await stageOf("s1:t1")).toBe("working");
    expect(taskRun(fixture.database, "s1:t1")!.stage).toBe("working");
  });
});
