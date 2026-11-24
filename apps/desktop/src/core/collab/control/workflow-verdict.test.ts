import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentFixture,
  agentFixture,
  callerFor,
} from "../../agent/fixture";
import {
  insertRun,
  insertTemplate,
  stepOfRun,
  transitionStep,
} from "../../workflow/store";
import type { WorkflowDraft } from "../../workflow/types";
import { type ControlOutcome, controlDispatcher } from ".";

/** `workflow-verdict`（#996 §2.6）：调用方、互斥、未知角色、只留最近一次。 */

let fixture: AgentFixture;
let coder: string;
let reviewer: string;
let stranger: string;

const DRAFT = {
  version: 2,
  title: "验证",
  params: [],
  roles: [
    { id: "coder", agentId: "codex" },
    { id: "reviewer", agentId: "claude" },
  ],
  steps: [
    { id: "s1", kind: "prompt", role: "coder", prompt: "写" },
    {
      id: "s2",
      kind: "collect",
      role: "reviewer",
      prompt: "验",
      from: ["s1"],
      after: ["s1"],
      verify: { commands: ["pnpm test"] },
    },
    {
      id: "s3",
      kind: "collect",
      role: "reviewer",
      prompt: "无验证",
      from: ["s1"],
      after: ["s1"],
    },
  ],
} as unknown as WorkflowDraft;

function call(
  nodeId: string,
  args: Record<string, unknown>,
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(
    "workflow-verdict",
    callerFor(fixture, nodeId),
    args,
  );
}

function refused(outcome: ControlOutcome): { status: number; code: string } {
  if (outcome.ok) throw new Error("expected a refusal");
  return { status: outcome.status, code: outcome.code };
}

function startRun(): string {
  const template = insertTemplate(fixture.database, {
    id: "t1",
    name: "验证",
    template: DRAFT,
    createdFromDraft: null,
    createdAt: 1,
  });
  const run = insertRun(fixture.database, {
    id: "r1",
    templateId: template.id,
    templateVersion: 1,
    template: DRAFT,
    workspaceId: fixture.workspaceId,
    boardId: fixture.boardId,
    frameId: null,
    anchorNodeId: null,
    params: {},
    roles: { coder, reviewer },
    startedAt: 1,
  });
  for (const id of ["s2", "s3"]) {
    transitionStep(fixture.database, run.id, id, ["pending"], "running", {
      startedAt: 2,
    });
  }
  return run.id;
}

beforeEach(() => {
  fixture = agentFixture();
  coder = fixture.agentNode("coder", "codex");
  reviewer = fixture.agentNode("reviewer", "claude");
  stranger = fixture.agentNode("stranger", "claude");
});

afterEach(() => fixture.close());

describe("workflow-verdict", () => {
  it("records a pass for the collect step's node and keeps only the latest", async () => {
    const runId = startRun();
    const first = await call(reviewer, { issue: ["coder: 缺测试"] });
    expect(first.ok).toBe(true);
    expect(stepOfRun(fixture.database, runId, "s2")?.verdict).toMatchObject({
      round: 0,
      pass: false,
      issues: [{ role: "coder", text: "缺测试" }],
    });
    const second = await call(reviewer, { pass: true });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.body.result).toEqual({
        runId,
        stepId: "s2",
        round: 0,
      });
    }
    expect(stepOfRun(fixture.database, runId, "s2")?.verdict).toMatchObject({
      pass: true,
      issues: [],
    });
    // 没有 verify 的 collect 步骤不收结论
    expect(stepOfRun(fixture.database, runId, "s3")?.verdict).toBeNull();
  });

  it("answers 409 to a node that is not a verifying step's node", async () => {
    startRun();
    expect(refused(await call(stranger, { pass: true }))).toEqual({
      status: 409,
      code: "no_verifying_step",
    });
    expect(refused(await call(coder, { pass: true })).status).toBe(409);
  });

  it("answers 409 when the step is not running", async () => {
    const runId = startRun();
    transitionStep(fixture.database, runId, "s2", ["running"], "waiting");
    expect(refused(await call(reviewer, { pass: true })).status).toBe(409);
  });

  it("answers 400 to pass with issues, neither, or too many", async () => {
    startRun();
    expect(
      refused(await call(reviewer, { pass: true, issue: ["coder: x"] })).status,
    ).toBe(400);
    expect(refused(await call(reviewer, {})).status).toBe(400);
    expect(
      refused(
        await call(reviewer, {
          issue: Array.from({ length: 17 }, (_, i) => `coder: ${i}`),
        }),
      ).status,
    ).toBe(400);
    expect(
      refused(await call(reviewer, { issue: [`coder: ${"x".repeat(501)}`] }))
        .status,
    ).toBe(400);
  });

  it("treats a prefix that is not a template role as plain text", async () => {
    const runId = startRun();
    const outcome = await call(reviewer, {
      issue: ["TypeError: x is undefined", "ghost: x"],
    });
    expect(outcome.ok).toBe(true);
    expect(stepOfRun(fixture.database, runId, "s2")?.verdict?.issues).toEqual([
      { role: null, text: "TypeError: x is undefined" },
      { role: null, text: "ghost: x" },
    ]);
  });

  it("treats an issue without a role as for every source role", async () => {
    const runId = startRun();
    const outcome = await call(reviewer, { issue: ["整体不对"] });
    expect(outcome.ok).toBe(true);
    expect(stepOfRun(fixture.database, runId, "s2")?.verdict?.issues).toEqual([
      { role: null, text: "整体不对" },
    ]);
  });
});
