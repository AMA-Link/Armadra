import { describe, expect, it } from "vitest";

import {
  workflowDraftSchema,
  workflowFrozenScheduleSchema,
  workflowRunSchema,
  workflowUpgradeResultSchema,
  workspaceEventSchema,
} from "../src/index.js";

/**
 * 草案 schema（契约 §15.1）。与 core 的 `workflow/draft.ts` 是同一套规则，
 * `apps/desktop/src/core/workflow/draft.test.ts` 用同样的样本钉住那一边。
 */

function sample(): Record<string, unknown> {
  return {
    version: 1,
    title: "双人代码审查",
    params: [{ name: "scopeA", type: "string" }],
    roles: [
      { id: "reviewerA", agentId: "claude", permissionMode: "plan" },
      { id: "reviewerB", agentId: "custom:reviewer" },
      { id: "lead", agentId: "ama", permissionMode: "default" },
    ],
    links: [{ from: "lead", to: "reviewerA" }],
    steps: [
      {
        id: "s1",
        kind: "prompt",
        role: "reviewerA",
        prompt: "审查 {{scopeA}}",
      },
      { id: "s2", kind: "prompt", role: "reviewerB", prompt: "审查 B" },
      {
        id: "s3",
        kind: "collect",
        role: "lead",
        from: ["s1", "s2"],
        prompt: "汇总",
        after: ["s1", "s2"],
      },
      { id: "s4", kind: "gate", label: "合并前人工确认", after: ["s3"] },
    ],
    source: { boardId: "b", proposedBy: "ama" },
  };
}

describe("workflowDraftSchema", () => {
  it("accepts the design's sample and fills defaults", () => {
    const parsed = workflowDraftSchema.parse(sample());
    expect(parsed.links[0]).toEqual({
      from: "lead",
      to: "reviewerA",
      role: "peer",
    });
    expect(parsed.steps[1]?.after).toEqual([]);
  });

  it("rejects an unknown agentId", () => {
    const draft = sample();
    (draft.roles as Record<string, unknown>[])[0]!.agentId = "gpt-cli";
    expect(workflowDraftSchema.safeParse(draft).success).toBe(false);
  });

  it("rejects an after cycle and dangling references", () => {
    const cycle = sample();
    (cycle.steps as Record<string, unknown>[])[0]!.after = ["s4"];
    expect(workflowDraftSchema.safeParse(cycle).success).toBe(false);

    const ghost = sample();
    (ghost.steps as Record<string, unknown>[])[0]!.role = "ghost";
    expect(workflowDraftSchema.safeParse(ghost).success).toBe(false);

    const outside = sample();
    (outside.steps as Record<string, unknown>[])[2]!.after = ["s1"];
    expect(workflowDraftSchema.safeParse(outside).success).toBe(false);
  });
});

describe("run and event shapes", () => {
  it("parses a run and the three workflow events", () => {
    expect(
      workflowRunSchema.safeParse({
        id: "r",
        templateId: "t",
        templateVersion: 1,
        title: "x",
        workspaceId: "w",
        boardId: "b",
        frameId: "f",
        params: { scope: "src" },
        status: "waiting",
        reason: null,
        roles: { worker: "n" },
        startedAt: "2026-10-03T00:00:00.000Z",
        endedAt: null,
        steps: [
          {
            stepId: "s1",
            kind: "gate",
            role: null,
            status: "waiting",
            nodeId: null,
            startedAt: "2026-10-03T00:00:00.000Z",
            endedAt: null,
            reason: null,
            outputs: [],
            decision: null,
            note: null,
          },
        ],
      }).success,
    ).toBe(true);
    for (const event of [
      { type: "workflow.draft", draftId: "d", boardId: "b", status: "pending" },
      { type: "workflow.run", runId: "r", boardId: "b", status: "running" },
      {
        type: "workflow.gate",
        runId: "r",
        boardId: "b",
        stepId: "s",
        label: "l",
        state: "waiting",
      },
      {
        type: "workflow.task",
        taskId: "sess:t1",
        boardId: "b",
        coordinatorNodeId: "lead",
        nodeId: "m",
        status: "done",
      },
    ]) {
      expect(workspaceEventSchema.safeParse(event).success).toBe(true);
    }
    expect(
      workspaceEventSchema.safeParse({
        type: "workflow.task",
        taskId: "t",
        boardId: "b",
        coordinatorNodeId: "lead",
        nodeId: "m",
        status: "blocked",
      }).success,
    ).toBe(false);
  });
});

describe("模板升级（契约 §15.6 追加）", () => {
  it("冻结计划与升级答复的形状", () => {
    expect(
      workflowFrozenScheduleSchema.safeParse({
        scheduleId: "p",
        workspaceId: "ws",
        templateVersion: 1,
        reason: "missing_params",
        missingParams: ["owner"],
        unknownParams: [],
      }).success,
    ).toBe(true);
    expect(
      workflowFrozenScheduleSchema.safeParse({
        scheduleId: "p",
        workspaceId: "ws",
        templateVersion: 1,
        reason: "forbidden",
        missingParams: [],
        unknownParams: [],
      }).success,
    ).toBe(false);
    expect(
      workflowUpgradeResultSchema.safeParse({
        upgraded: [{ scheduleId: "a", revision: 3 }],
        frozen: [
          {
            scheduleId: "b",
            reason: "forbidden",
            missingParams: [],
            unknownParams: [],
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("草案 v2（契约 §15.1 追加）", () => {
  function v2(): Record<string, unknown> {
    const draft = sample();
    draft.version = 2;
    draft.description = "# 说明";
    draft.contract = {
      text: "共享约定",
      owns: { reviewerA: ["src/a/"], lead: ["docs/**"] },
    };
    (draft.roles as Record<string, unknown>[])[0]!.tier = "strong";
    const collect = (draft.steps as Record<string, unknown>[])[2]!;
    collect.verify = { commands: ["pnpm test"], checklist: ["无遗漏"] };
    collect.maxRetries = 1;
    return draft;
  }

  it("reads v1, v2 and old revision numbers", () => {
    for (const version of [1, 2, 4]) {
      const draft = sample();
      draft.version = version;
      expect(workflowDraftSchema.safeParse(draft).success).toBe(true);
    }
    expect(
      workflowDraftSchema.safeParse({ ...sample(), version: 0 }).success,
    ).toBe(false);
  });

  it("accepts v2 fields and does not rewrite them", () => {
    const parsed = workflowDraftSchema.parse(v2());
    expect(parsed.contract?.owns?.reviewerA).toEqual(["src/a/"]);
    expect(parsed.roles[0]?.tier).toBe("strong");
    const plain = workflowDraftSchema.parse(sample());
    expect("contract" in plain).toBe(false);
    expect("description" in plain).toBe(false);
    const collect = plain.steps[2]!;
    expect("verify" in collect).toBe(false);
    expect("maxRetries" in collect).toBe(false);
  });

  it("rejects bad tier, verify, maxRetries and owns", () => {
    const tier = v2();
    (tier.roles as Record<string, unknown>[])[0]!.tier = "ultra";
    expect(workflowDraftSchema.safeParse(tier).success).toBe(false);

    const empty = v2();
    (empty.steps as Record<string, unknown>[])[2]!.verify = {
      commands: [],
      checklist: null,
    };
    expect(workflowDraftSchema.safeParse(empty).success).toBe(false);

    const retries = v2();
    (retries.steps as Record<string, unknown>[])[2]!.maxRetries = 4;
    expect(workflowDraftSchema.safeParse(retries).success).toBe(false);

    const orphan = v2();
    const step = (orphan.steps as Record<string, unknown>[])[2]!;
    delete step.verify;
    expect(workflowDraftSchema.safeParse(orphan).success).toBe(false);

    const owns = v2();
    (owns.contract as { owns: Record<string, string[]> }).owns.ghost = ["x"];
    expect(workflowDraftSchema.safeParse(owns).success).toBe(false);

    const long = v2();
    (long.contract as { text: string }).text = "x".repeat(6001);
    expect(workflowDraftSchema.safeParse(long).success).toBe(false);

    const many = v2();
    (many.steps as Record<string, unknown>[])[2]!.verify = {
      commands: ["a", "b", "c", "d", "e"],
    };
    expect(workflowDraftSchema.safeParse(many).success).toBe(false);
  });

  it("run steps and events carry optional round, verdict and reason", () => {
    const base = {
      stepId: "s3",
      kind: "collect",
      role: "lead",
      status: "waiting",
      nodeId: null,
      startedAt: null,
      endedAt: null,
      reason: "verifyFailed",
      outputs: [],
      decision: null,
      note: null,
    };
    const run = (step: Record<string, unknown>) =>
      workflowRunSchema.safeParse({
        id: "r",
        templateId: "t",
        templateVersion: 1,
        title: "x",
        workspaceId: "w",
        boardId: "b",
        frameId: null,
        params: {},
        status: "waiting",
        reason: null,
        roles: {},
        startedAt: "2026-11-24T00:00:00.000Z",
        endedAt: null,
        steps: [step],
      }).success;
    expect(run(base)).toBe(true);
    expect(
      run({
        ...base,
        round: 2,
        verdict: { pass: false, issues: [{ role: "reviewerA", text: "漏了" }] },
      }),
    ).toBe(true);
    expect(run({ ...base, round: 1, verdict: null })).toBe(true);
    expect(run({ ...base, round: -1 })).toBe(false);
    expect(
      workspaceEventSchema.safeParse({
        type: "workflow.run",
        runId: "r",
        boardId: "b",
        status: "waiting",
        stepId: "s3",
        stepStatus: "waiting",
        round: 1,
      }).success,
    ).toBe(true);
    expect(
      workspaceEventSchema.safeParse({
        type: "workflow.gate",
        runId: "r",
        boardId: "b",
        stepId: "s3",
        label: "s3",
        state: "waiting",
        reason: "verdictMissing",
      }).success,
    ).toBe(true);
  });
});
