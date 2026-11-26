import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { EventBus } from "../bus";
import { getContextLinks } from "../canvas/context-links";
import { loadBoard } from "../canvas/documents";
import { resetSendLimits } from "../collab/send-limits";
import { resetInboxWake } from "../collab/wake";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { parseDraft } from "./draft";
import { WorkflowEngine } from "./engine";
import { type EventFrame, TriggerRules } from "../push/triggers";
import {
  type TemplateRow,
  insertTemplate,
  recordVerdict,
  runById,
  stepOfRun,
  stepsOf,
} from "./store";
import type { WorkflowDraft } from "./types";

/**
 * 运行引擎的验收（补全架构 §5.4）：三种步骤、关卡等人、取消、页面不在也推进、
 * 重启后续跑。
 *
 * 没有页面、没有真 CLI：终端桥是 fixture 的桩，角色节点「起来」由用例记下；
 * 投递落地就是把排队项改成 `done`（出队泵投出去之后就是这一行），节点的一轮
 * 就是往 `agent_status` 写 working / done——与 hook 上报落库之后一样。
 */

let fixture: AgentFixture;
let clock: number;
let launched: string[];
let engine: WorkflowEngine;

const DRAFT = {
  version: 1,
  title: "双人审查",
  params: [
    { name: "scopeA", type: "string" },
    { name: "scopeB", type: "string", default: "src/b" },
  ],
  roles: [
    { id: "reviewerA", agentId: "claude", permissionMode: "plan" },
    { id: "reviewerB", agentId: "codex" },
    { id: "lead", agentId: "claude" },
  ],
  links: [
    { from: "lead", to: "reviewerA", role: "supervises" },
    { from: "lead", to: "reviewerB", role: "supervises" },
  ],
  steps: [
    { id: "s1", kind: "prompt", role: "reviewerA", prompt: "审查 {{scopeA}}" },
    { id: "s2", kind: "prompt", role: "reviewerB", prompt: "审查 {{scopeB}}" },
    {
      id: "s3",
      kind: "collect",
      role: "lead",
      from: ["s1", "s2"],
      prompt: "汇总两份结论",
      after: ["s1", "s2"],
    },
    { id: "s4", kind: "gate", label: "合并前确认", after: ["s3"] },
    { id: "s5", kind: "prompt", role: "lead", prompt: "合并", after: ["s4"] },
  ],
};

function template(draft: unknown = DRAFT): TemplateRow {
  const parsed: WorkflowDraft = parseDraft(draft, {
    validAgentId: () => true,
  });
  return insertTemplate(fixture.database, {
    id: uuidV7(),
    name: parsed.title,
    template: parsed,
    createdFromDraft: null,
    createdAt: clock,
  });
}

function newEngine(): WorkflowEngine {
  return new WorkflowEngine({
    database: fixture.database,
    collab: () => fixture.collab,
    clock: () => clock,
    sweepEveryMs: false,
    launch: (node) => launched.push(node.nodeId),
  });
}

/** 节点报一次状态：写行，时刻往前走一秒。 */
function report(
  nodeId: string,
  state: string,
  verdict: { errored?: boolean } = {},
): void {
  clock += 1_000;
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, " +
        "restored, last_event_at, errored, interrupted, updated_at) " +
        "VALUES (?, ?, 'claude', ?, 0, 1, 0, ?, ?, 0, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, " +
        "last_event_at = excluded.last_event_at, errored = excluded.errored, " +
        "updated_at = excluded.updated_at",
    )
    .run(
      nodeId,
      fixture.workspaceId,
      state,
      new Date(clock).toISOString(),
      state === "done" ? (verdict.errored === true ? 1 : 0) : null,
      rfc3339(),
    );
  engine.handleEvent({ type: "agent.status", status: { nodeId, state } });
}

/** 节点开始了一轮，hook 上报里带着这一轮的提示词。 */
function startTurn(nodeId: string, prompt: string): void {
  report(nodeId, "working");
  engine.handleEvent({
    type: "agent.status",
    status: { nodeId, state: "working", lastMessage: prompt },
  });
}

const WAKE = "收件箱有 1 条新消息，运行 `armadra-hook canvas inbox` 查看。";

/** 出队泵把排给这个节点的那条投出去了。 */
function delivered(nodeId: string): string {
  const row = fixture.database
    .prepare(
      "SELECT id, body FROM agent_send_queue WHERE target_node_id = ? AND state = 'queued' ORDER BY created_at",
    )
    .get(nodeId) as { id: string; body: string } | undefined;
  if (row === undefined) throw new Error(`nothing queued for ${nodeId}`);
  fixture.database
    .prepare("UPDATE agent_send_queue SET state = 'done' WHERE id = ?")
    .run(row.id);
  return row.body;
}

function post(source: string, target: string, key: string, body: string) {
  fixture.database
    .prepare(
      "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, message_key, body, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      uuidV7(),
      fixture.workspaceId,
      source,
      target,
      key,
      body,
      Math.floor(clock / 1000),
      Math.floor(clock / 1000) + 86_400,
    );
}

/** 一轮：投递落地 → 忙 → 干净地结束。答投进去的正文。 */
async function turn(runId: string, nodeId: string): Promise<string> {
  const body = delivered(nodeId);
  await engine.progress(runId);
  report(nodeId, "working");
  await engine.progress(runId);
  report(nodeId, "done");
  await engine.progress(runId);
  return body;
}

function statuses(runId: string): Record<string, string> {
  return Object.fromEntries(
    stepsOf(fixture.database, runId).map((step) => [step.stepId, step.status]),
  );
}

function events(type: string): Record<string, unknown>[] {
  return fixture.events
    .map((entry) => entry.event as unknown as Record<string, unknown>)
    .filter((event) => event.type === type);
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  fixture = agentFixture();
  clock = Date.now();
  launched = [];
  engine = newEngine();
});

afterEach(async () => {
  await engine.stop();
  fixture.close();
});

describe("starting a run", () => {
  it("lays out a Frame, an anchor and one linked node per role, and launches them", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "src/a" },
      boardId: fixture.boardId,
    });
    expect(run.status).toBe("running");
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    const frame = document.nodes.find((node) => node.id === run.frameId);
    expect(frame?.type).toBe("group");
    const anchor = document.nodes.find((node) => node.id === run.anchorNodeId);
    expect(anchor?.parentId).toBe(frame?.id);
    expect(Object.keys(run.roles).sort()).toEqual([
      "lead",
      "reviewerA",
      "reviewerB",
    ]);
    const reviewerA = document.nodes.find(
      (node) => node.id === run.roles.reviewerA,
    );
    expect(reviewerA?.parentId).toBe(frame?.id);
    expect(reviewerA?.data).toMatchObject({
      kind: "terminal",
      agent: { id: "claude", permissionMode: "plan" },
    });
    // 起点便签向每个角色一条主从线，草案的两条线照原样。
    const supervised = document.edges.filter(
      (edge) => edge.source === run.anchorNodeId,
    );
    expect(supervised).toHaveLength(3);
    expect(
      document.edges.some(
        (edge) =>
          edge.source === run.roles.lead &&
          edge.target === run.roles.reviewerB &&
          edge.role === "supervises",
      ),
    ).toBe(true);
    // 链接文档由 core 随这次保存按边重算：起点便签把每个角色读作自己的从
    // （它是投递的发起方，出队时按它的文档授权）；每个角色把便签读作主。
    expect(
      getContextLinks(fixture.database, run.anchorNodeId as string)
        .links.map((link) => link.role)
        .sort(),
    ).toEqual(Object.values(run.roles).map(() => "sub"));
    for (const role of Object.values(run.roles)) {
      expect(
        getContextLinks(fixture.database, role).links.find(
          (link) => link.id === run.anchorNodeId,
        )?.role,
      ).toBe("main");
    }
    expect(launched.sort()).toEqual(Object.values(run.roles).sort());
    // 两个没有依赖的步骤当场开始，提示词按参数代入（缺省值也算）。
    expect(statuses(run.id)).toMatchObject({
      s1: "running",
      s2: "running",
      s3: "pending",
      s4: "pending",
      s5: "pending",
    });
    const queued = fixture.database
      .prepare(
        "SELECT source_node_id, target_node_id, body, origin FROM agent_send_queue ORDER BY body",
      )
      .all() as {
      source_node_id: string;
      target_node_id: string;
      body: string;
      origin: string;
    }[];
    expect(queued.map((row) => row.body)).toEqual(["审查 src/a", "审查 src/b"]);
    expect(
      queued.every(
        (row) =>
          row.source_node_id === run.anchorNodeId &&
          row.origin === "first-task",
      ),
    ).toBe(true);
    expect(events("workflow.run")[0]).toMatchObject({
      runId: run.id,
      status: "running",
    });
  });

  it("records the node that started a hosted run and reads it back", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "src" },
      boardId: fixture.boardId,
      startedByNodeId: "node-ama",
    });
    expect(run.startedByNodeId).toBe("node-ama");
    expect(runById(fixture.database, run.id)?.startedByNodeId).toBe("node-ama");
  });

  it("precheck rejects like a real start and writes nothing", () => {
    expect(() =>
      engine.precheck({
        template: template().template,
        boardId: fixture.boardId,
      }),
    ).toThrowError(expect.objectContaining({ code: "missing_param" }));
    expect(() =>
      engine.precheck({
        template: template().template,
        params: { scopeA: "x" },
        boardId: "no-such-board",
      }),
    ).toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("refuses a missing parameter and an unsupported permission mode before touching the board", async () => {
    await expect(
      engine.startRun({ template: template(), boardId: fixture.boardId }),
    ).rejects.toMatchObject({ code: "missing_param" });
    const unsupported = {
      ...DRAFT,
      roles: [
        { id: "only", agentId: "custom:nothing", permissionMode: "plan" },
      ],
      links: [],
      steps: [{ id: "s1", kind: "prompt", role: "only", prompt: "x" }],
      params: [],
    };
    await expect(
      engine.startRun({
        template: template(unsupported),
        boardId: fixture.boardId,
      }),
    ).rejects.toMatchObject({ code: "permission_mode_unsupported" });
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    expect(document.nodes).toHaveLength(0);
  });
});

describe("the three step kinds", () => {
  it("runs prompt → collect → gate → prompt to success", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "src/a" },
      boardId: fixture.boardId,
    });
    const { reviewerA, reviewerB, lead } = run.roles as {
      reviewerA: string;
      reviewerB: string;
      lead: string;
    };

    // 投出去之前、节点早先的一次 done 不算这一轮的。
    report(reviewerA, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).s1).toBe("running");

    delivered(reviewerA);
    await engine.progress(run.id);
    report(reviewerA, "working");
    post(reviewerA, lead, "review-a", "A 的结论");
    report(reviewerA, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).s1).toBe("done");
    expect(stepOfRun(fixture.database, run.id, "s1")?.outcome).toMatchObject({
      outputs: [{ key: "review-a", body: "A 的结论", target: lead }],
    });
    expect(statuses(run.id).s3).toBe("pending");

    delivered(reviewerB);
    await engine.progress(run.id);
    report(reviewerB, "working");
    post(reviewerB, reviewerA, "review-b", "B 的结论");
    report(reviewerB, "done");
    await engine.progress(run.id);
    expect(statuses(run.id)).toMatchObject({
      s2: "done",
      s3: "running",
    });

    // collect：B 的结论（发给了别人）放进 lead 的收件箱；A 的本来就在那里。
    const inbox = fixture.database
      .prepare(
        "SELECT source_node_id, message_key, body FROM agent_mailbox WHERE target_node_id = ? ORDER BY sequence",
      )
      .all(lead) as {
      source_node_id: string;
      message_key: string;
      body: string;
    }[];
    expect(inbox.map((row) => row.body)).toEqual(["A 的结论", "B 的结论"]);
    expect(inbox[1]).toMatchObject({
      source_node_id: reviewerB,
      message_key: `workflow:${run.id}:s2:0`,
    });

    const collected = await turn(run.id, lead);
    expect(collected).toContain("汇总两份结论");
    expect(collected).toContain("canvas inbox");
    expect(statuses(run.id)).toMatchObject({ s3: "done", s4: "waiting" });
    expect(runById(fixture.database, run.id)?.status).toBe("waiting");
    expect(events("workflow.gate").at(-1)).toMatchObject({
      runId: run.id,
      stepId: "s4",
      label: "合并前确认",
      state: "waiting",
      nodeId: run.frameId,
    });
    // 推送规则认得这一帧：叫人，深链指向运行的 Frame（补全架构 §10）。
    const gateFrame = events("workflow.gate").at(-1) as unknown as EventFrame;
    expect(new TriggerRules().draft(run.workspaceId, gateFrame)).toMatchObject({
      kind: "workflowGate",
      nodeId: run.frameId,
    });

    // 关卡等人：怎么推都不动。
    await engine.sweep();
    expect(statuses(run.id).s5).toBe("pending");

    await engine.answerGate(run.id, "s4", "approve", "可以合");
    expect(stepOfRun(fixture.database, run.id, "s4")?.outcome).toEqual({
      decision: "approve",
      note: "可以合",
    });
    expect(statuses(run.id).s5).toBe("running");
    expect(runById(fixture.database, run.id)?.status).toBe("running");
    expect(await turn(run.id, lead)).toBe("合并");
    const finished = runById(fixture.database, run.id);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.endedAt).not.toBeNull();
    await expect(
      engine.answerGate(run.id, "s4", "approve"),
    ).rejects.toMatchObject({ code: "gate_not_waiting" });
  });

  it("fails the run when a gate is rejected, skipping what waited on it", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    const { reviewerA, reviewerB, lead } = run.roles as {
      reviewerA: string;
      reviewerB: string;
      lead: string;
    };
    await turn(run.id, reviewerA);
    await turn(run.id, reviewerB);
    await turn(run.id, lead);
    await engine.answerGate(run.id, "s4", "reject");
    expect(statuses(run.id)).toMatchObject({ s4: "failed", s5: "skipped" });
    const finished = runById(fixture.database, run.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.reason).toBe("s4:rejected");
    expect(events("workflow.gate").at(-1)).toMatchObject({ state: "rejected" });
  });

  it("fails a step whose turn ends in an error, and skips its dependents", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    const { reviewerA, reviewerB } = run.roles as {
      reviewerA: string;
      reviewerB: string;
    };
    delivered(reviewerA);
    await engine.progress(run.id);
    report(reviewerA, "working");
    report(reviewerA, "done", { errored: true });
    await engine.progress(run.id);
    expect(stepOfRun(fixture.database, run.id, "s1")).toMatchObject({
      status: "failed",
      reason: "turnFailed",
    });
    expect(statuses(run.id)).toMatchObject({
      s3: "skipped",
      s4: "skipped",
      s5: "skipped",
    });
    // 独立的那一支照常跑完，然后整次运行落 failed。
    expect(runById(fixture.database, run.id)?.status).toBe("running");
    await turn(run.id, reviewerB);
    expect(runById(fixture.database, run.id)?.status).toBe("failed");
  });

  it("re-delivers an expired prompt, and gives up after the third attempt", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    const reviewerA = run.roles.reviewerA as string;
    const expire = () =>
      fixture.database
        .prepare(
          "UPDATE agent_send_queue SET state = 'expired', last_reason = 'TARGET_STARTING' " +
            "WHERE target_node_id = ? AND state = 'queued'",
        )
        .run(reviewerA);
    expire();
    await engine.progress(run.id);
    expect(stepOfRun(fixture.database, run.id, "s1")).toMatchObject({
      status: "running",
      attempts: 2,
    });
    expire();
    await engine.progress(run.id);
    expire();
    await engine.progress(run.id);
    expect(stepOfRun(fixture.database, run.id, "s1")).toMatchObject({
      status: "failed",
      reason: "TARGET_STARTING",
      attempts: 3,
    });
  });
});

describe("cancelling", () => {
  it("cancels the steps and takes back the prompts still queued, leaving the nodes", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    await engine.cancel(run.id);
    const finished = runById(fixture.database, run.id);
    expect(finished?.status).toBe("cancelled");
    expect(new Set(Object.values(statuses(run.id)))).toEqual(
      new Set(["cancelled"]),
    );
    const states = fixture.database
      .prepare("SELECT DISTINCT state FROM agent_send_queue")
      .all() as { state: string }[];
    expect(states.map((row) => row.state)).toEqual(["cancelled"]);
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    expect(document.nodes.some((node) => node.id === run.roles.lead)).toBe(
      true,
    );
    await expect(engine.cancel(run.id)).rejects.toMatchObject({
      code: "run_finished",
    });
  });
});

describe("without a page", () => {
  it("advances on bus events alone", async () => {
    const bus = new EventBus();
    await engine.stop();
    engine = new WorkflowEngine({
      database: fixture.database,
      collab: () => fixture.collab,
      bus,
      clock: () => clock,
      sweepEveryMs: false,
      launch: (node) => launched.push(node.nodeId),
    });
    engine.start();
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    const reviewerA = run.roles.reviewerA as string;
    delivered(reviewerA);
    for (const state of ["working", "done"]) {
      clock += 1_000;
      fixture.database
        .prepare(
          "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, " +
            "restored, last_event_at, errored, interrupted, updated_at) VALUES (?, ?, 'claude', ?, 0, 1, 0, ?, 0, 0, ?) " +
            "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, last_event_at = excluded.last_event_at",
        )
        .run(
          reviewerA,
          fixture.workspaceId,
          state,
          new Date(clock).toISOString(),
          rfc3339(),
        );
      bus.emit("workspace.event", {
        workspaceId: fixture.workspaceId,
        event: { type: "agent.status", status: { nodeId: reviewerA, state } },
      });
      await engine.progress(run.id);
    }
    expect(statuses(run.id).s1).toBe("done");
  });
});

describe("restarting", () => {
  it("picks a run up where it was from the database alone", async () => {
    const run = await engine.startRun({
      template: template(),
      params: { scopeA: "a" },
      boardId: fixture.boardId,
    });
    const reviewerA = run.roles.reviewerA as string;
    delivered(reviewerA);
    await engine.progress(run.id);
    await engine.stop();

    // core 不在的时候节点干完了这一轮：状态已经在库里。
    clock += 1_000;
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, " +
          "restored, last_event_at, errored, interrupted, updated_at) VALUES (?, ?, 'claude', 'done', 0, 1, 0, ?, 0, 0, ?)",
      )
      .run(
        reviewerA,
        fixture.workspaceId,
        new Date(clock).toISOString(),
        rfc3339(),
      );

    engine = newEngine();
    await engine.sweep();
    expect(statuses(run.id)).toMatchObject({ s1: "done", s2: "running" });
    expect(runById(fixture.database, run.id)?.status).toBe("running");
  });
});

const VDRAFT = {
  version: 2,
  title: "带验证的汇总",
  params: [],
  roles: [
    { id: "dev", agentId: "claude" },
    { id: "ui", agentId: "claude" },
    { id: "lead", agentId: "claude", tier: "strong" },
  ],
  links: [
    { from: "lead", to: "dev", role: "supervises" },
    { from: "lead", to: "ui", role: "supervises" },
  ],
  contract: {
    text: "约定第一段\n\n约定第二段",
    owns: { dev: ["src/a/**"], ui: ["src/b/**"] },
  },
  steps: [
    { id: "a", kind: "prompt", role: "dev", prompt: "做 A" },
    { id: "b", kind: "prompt", role: "ui", prompt: "做 B" },
    {
      id: "c",
      kind: "collect",
      role: "lead",
      from: ["a", "b"],
      after: ["a", "b"],
      prompt: "汇总并验证",
      verify: { commands: ["pnpm test"], checklist: ["无遗漏"] },
    },
  ],
};

function inboxOf(nodeId: string): { key: string; body: string }[] {
  return fixture.database
    .prepare(
      "SELECT message_key AS key, body FROM agent_mailbox WHERE target_node_id = ? ORDER BY sequence",
    )
    .all(nodeId) as { key: string; body: string }[];
}

function verdict(
  runId: string,
  round: number,
  pass: boolean,
  issues: { role: string | null; text: string }[] = [],
): void {
  recordVerdict(fixture.database, runId, "c", {
    round,
    pass,
    issues,
    at: clock,
  });
}

/** 起一次带验证的运行，跑完 a、b，停在汇总角色刚被投递 c 的时候。 */
async function startVerifying() {
  const run = await engine.startRun({
    template: template(VDRAFT),
    boardId: fixture.boardId,
  });
  const { dev, ui, lead } = run.roles as {
    dev: string;
    ui: string;
    lead: string;
  };
  delivered(dev);
  post(dev, lead, "a1", "A 的产出一");
  await engine.progress(run.id);
  report(dev, "working");
  report(dev, "done");
  await engine.progress(run.id);
  await turn(run.id, ui);
  return { run, dev, ui, lead };
}

describe("workflow v2 injection", () => {
  it("puts the contract and verify note in the inbox, not in the body or the outputs", async () => {
    const { run, lead } = await startVerifying();
    expect(statuses(run.id).c).toBe("running");
    const keys = inboxOf(lead).map((row) => row.key);
    expect(keys).toContain(`workflow:${run.id}:contract:0`);
    expect(keys).toContain(`workflow:${run.id}:contract:1`);
    expect(keys).toContain(`workflow:${run.id}:verify:c:0`);
    const verifyNote = inboxOf(lead).find((row) =>
      row.key.endsWith("verify:c:0"),
    )?.body as string;
    expect(verifyNote).toContain("pnpm test");
    expect(verifyNote).toContain("canvas_workflow_verdict");
    const first = inboxOf(lead).find((row) => row.key.endsWith("contract:0"));
    expect(first?.body).toContain("你负责的路径");
    expect(first?.body).toContain("其他角色负责的路径");

    const body = await turnBody(run.id, lead);
    expect(body).toContain("汇总并验证");
    expect(body).toContain("canvas inbox");
    expect(body).toContain("canvas_workflow_verdict");
    expect(body).not.toContain("a、b");
    expect([...body.split("\n").at(-1)!].length).toBeLessThanOrEqual(200);
  });

  it("a mailbox-wake turn that ends first is not the step's turn (#1034)", async () => {
    const { run, lead } = await startVerifying();
    delivered(lead);
    await engine.progress(run.id);
    // 唤醒的那一轮先开始、先结束；步骤的提示词排在它后面。
    startTurn(lead, WAKE);
    report(lead, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).c).toBe("running");
    // 步骤自己的那一轮结束才算数。
    startTurn(lead, "汇总并验证\n（来源步骤的结论……）");
    verdict(run.id, 0, true);
    report(lead, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).c).toBe("done");
  });

  it("counts the step's own turn end when its prompt came first, and gives up waiting for it after the grace (#1034)", async () => {
    const { run, lead } = await startVerifying();
    delivered(lead);
    await engine.progress(run.id);
    startTurn(lead, "汇总并验证\n（来源步骤的结论……）");
    verdict(run.id, 0, true);
    report(lead, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).c).toBe("done");

    // 另一次运行：只见到别人的提示词，自己的从没出现；过了时限照旧放行。
    resetSendLimits();
    const second = await startVerifying();
    delivered(second.lead);
    await engine.progress(second.run.id);
    startTurn(second.lead, WAKE);
    report(second.lead, "done");
    await engine.progress(second.run.id);
    expect(statuses(second.run.id).c).toBe("running");
    clock += 130_000;
    verdict(second.run.id, 0, true);
    report(second.lead, "done");
    await engine.progress(second.run.id);
    expect(statuses(second.run.id).c).toBe("done");
  });

  it("an end that lands right after the step starts, before any prompt of its own, is not the step's (#1034)", async () => {
    const { run, dev, ui, lead } = await startVerifying();
    // 汇总角色之前报过提示词（上一轮的），这一步刚开始就来了一个迟到的结束。
    startTurn(lead, "上一轮的提示词");
    delivered(lead);
    await engine.progress(run.id);
    report(lead, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).c).toBe("running");
    startTurn(lead, "汇总并验证\n（来源步骤的结论……）");
    verdict(run.id, 0, true);
    report(lead, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).c).toBe("done");
    expect(dev).not.toBe(ui);
  });

  it("a wake turn between two rounds of a collect does not settle the new round (#1034)", async () => {
    const { run, dev, ui, lead } = await startVerifying();
    delivered(lead);
    await engine.progress(run.id);
    report(lead, "working");
    verdict(run.id, 0, false, [{ role: "dev", text: "缺测试" }]);
    report(lead, "done");
    await engine.progress(run.id);
    delivered(dev);
    await engine.progress(run.id);
    report(dev, "working");
    post(dev, ui, "a2", "A 的产出二");
    report(dev, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).c).toBe("running");
    delivered(lead);
    await engine.progress(run.id);
    // 第二轮的提示词之前，收件箱唤醒那一轮先跑完。
    startTurn(lead, WAKE);
    report(lead, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).c).toBe("running");
    expect(stepOfRun(fixture.database, run.id, "c")?.reason).not.toBe(
      "verdictMissing",
    );
    startTurn(lead, "汇总并验证\n（来源步骤的结论……）");
    verdict(run.id, 1, true);
    report(lead, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).c).toBe("done");
    expect(runById(fixture.database, run.id)?.status).toBe("succeeded");
  });

  it("sends a failed verdict back, re-gathers with new keys and only counts the new round", async () => {
    const { run, dev, ui, lead } = await startVerifying();
    delivered(lead);
    await engine.progress(run.id);
    report(lead, "working");
    verdict(run.id, 0, false, [{ role: "dev", text: "测试挂了" }]);
    report(lead, "done");
    await engine.progress(run.id);

    expect(statuses(run.id)).toMatchObject({
      a: "running",
      b: "done",
      c: "pending",
    });
    expect(stepOfRun(fixture.database, run.id, "a")?.round).toBe(1);
    expect(stepOfRun(fixture.database, run.id, "c")).toMatchObject({
      round: 1,
      reason: "verifyFailed",
    });
    expect(runById(fixture.database, run.id)?.status).toBe("running");
    const feedback = delivered(dev);
    expect(feedback).toContain("测试挂了");
    expect(feedback).toContain("步骤 c");

    await engine.progress(run.id);
    report(dev, "working");
    post(dev, ui, "a2", "A 的产出二");
    report(dev, "done");
    await engine.progress(run.id);
    expect(stepOfRun(fixture.database, run.id, "a")?.outcome).toMatchObject({
      outputs: [{ key: "a2", body: "A 的产出二" }],
    });
    expect(
      stepOfRun(fixture.database, run.id, "a")?.outcome?.outputs,
    ).toHaveLength(1);
    expect(statuses(run.id).c).toBe("running");
    const keys = inboxOf(lead).map((row) => row.key);
    expect(keys).toContain(`workflow:${run.id}:a:1:0`);
    expect(keys).toContain(`workflow:${run.id}:verify:c:1`);
    // 合约只放一次。
    expect(keys.filter((key) => key.includes(":contract:"))).toHaveLength(3);

    delivered(lead);
    await engine.progress(run.id);
    report(lead, "working");
    verdict(run.id, 1, true);
    report(lead, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).c).toBe("done");
    expect(
      stepOfRun(fixture.database, run.id, "c")?.outcome?.verdict,
    ).toMatchObject({
      pass: true,
    });
    expect(runById(fixture.database, run.id)?.status).toBe("succeeded");
  });

  it("escalates a missing verdict to a gate, survives a restart, and obeys approve / reject", async () => {
    const { run, lead } = await startVerifying();
    await turn(run.id, lead);
    expect(statuses(run.id).c).toBe("waiting");
    expect(stepOfRun(fixture.database, run.id, "c")?.reason).toBe(
      "verdictMissing",
    );
    expect(runById(fixture.database, run.id)?.status).toBe("waiting");
    expect(events("workflow.gate").at(-1)).toMatchObject({
      stepId: "c",
      state: "waiting",
      reason: "verdictMissing",
      label: "c",
    });
    expect(
      events("workflow.run").some(
        (event) => event.stepId === "c" && event.stepStatus === "waiting",
      ),
    ).toBe(true);

    await engine.stop();
    engine = newEngine();
    await engine.sweep();
    expect(statuses(run.id).c).toBe("waiting");

    await engine.answerGate(run.id, "c", "approve", "先这样");
    expect(statuses(run.id).c).toBe("done");
    expect(stepOfRun(fixture.database, run.id, "c")?.outcome).toMatchObject({
      decision: "approve",
      note: "先这样",
    });
    expect(runById(fixture.database, run.id)?.status).toBe("succeeded");
  });

  it("fails the collect and skips downstream when the human rejects an escalation", async () => {
    const { run, lead } = await startVerifying();
    await turn(run.id, lead);
    await engine.answerGate(run.id, "c", "reject");
    expect(statuses(run.id).c).toBe("failed");
    expect(runById(fixture.database, run.id)?.status).toBe("failed");
  });

  it("escalates when the retries are used up", async () => {
    const draft = {
      ...VDRAFT,
      steps: VDRAFT.steps.map((step) =>
        step.id === "c" ? { ...step, maxRetries: 0 } : step,
      ),
    };
    const run = await engine.startRun({
      template: template(draft),
      boardId: fixture.boardId,
    });
    const { dev, ui, lead } = run.roles as Record<string, string>;
    await turn(run.id, dev as string);
    await turn(run.id, ui as string);
    delivered(lead as string);
    await engine.progress(run.id);
    report(lead as string, "working");
    verdict(run.id, 0, false, [{ role: null, text: "不行" }]);
    report(lead as string, "done");
    await engine.progress(run.id);
    expect(statuses(run.id).c).toBe("waiting");
    expect(stepOfRun(fixture.database, run.id, "c")?.reason).toBe(
      "verifyFailed",
    );
  });

  it("writes the tier into the node data: mapped model for claude, native tier for ama", async () => {
    const draft = {
      ...VDRAFT,
      roles: [
        { id: "dev", agentId: "claude", tier: "strong" },
        { id: "ui", agentId: "ama", tier: "light" },
        { id: "lead", agentId: "claude" },
      ],
    };
    const make = async (supports: boolean) => {
      engine = new WorkflowEngine({
        database: fixture.database,
        collab: () => fixture.collab,
        clock: () => clock,
        sweepEveryMs: false,
        launch: (node) => launched.push(node.nodeId),
        amaSupportsTier: () => supports,
      });
      const run = await engine.startRun({
        template: template(draft),
        boardId: fixture.boardId,
      });
      const document = loadBoard(
        fixture.database,
        fixture.workspaceId,
        fixture.boardId,
      );
      const agentOf = (id: string) =>
        (
          document.nodes.find((node) => node.id === run.roles[id])?.data as {
            agent: Record<string, unknown>;
          }
        ).agent;
      return { dev: agentOf("dev"), ui: agentOf("ui") };
    };
    const on = await make(true);
    expect(on.dev).toMatchObject({ id: "claude", model: "opus" });
    expect(on.dev).not.toHaveProperty("tier");
    expect(on.ui).toMatchObject({ id: "ama", tier: "light" });
    const off = await make(false);
    expect(off.ui).not.toHaveProperty("tier");
  });
});

/** 一轮，答投进去的正文（不推进验证结论）。 */
async function turnBody(runId: string, nodeId: string): Promise<string> {
  return turn(runId, nodeId);
}
