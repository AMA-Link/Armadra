import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentFixture,
  agentFixture,
  callerFor,
} from "../../agent/fixture";
import { DomainError } from "../../workspaces/support";
import {
  type WorkflowDomain,
  setWorkflowDomain,
} from "../../workflow/registry";
import { WorkflowService } from "../../workflow/service";
import { insertRun, templateByFileRef } from "../../workflow/store";
import { checkRendered, resolveParams } from "../../workflow/draft";
import type { WorkflowDraft } from "../../workflow/types";
import { textHash } from "../../workflow/files";
import type { StartRunRequest } from "../../workflow/engine";
import { type ControlOutcome, controlDispatcher } from ".";

/** `workflow-run`（#996 §2.9）：core 自读文件、hash 门、模板 upsert、发起节点、dry-run、url。 */

const FILE = (title: string, prompt = "x") => `---
version: 2
title: ${title}
params:
  - name: scope
roles:
  - id: a
    agentId: codex
steps:
  - id: s
    kind: prompt
    role: a
    prompt: ${prompt} {{scope}}
---
`;

let fixture: AgentFixture;
let caller: string;
let started: StartRunRequest[];
let refusal: DomainError | undefined;

function write(name: string, text: string): void {
  const dir = join(fixture.directory, ".ama", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

beforeEach(() => {
  fixture = agentFixture();
  caller = fixture.agentNode("ama", "ama");
  started = [];
  refusal = undefined;
  const engine = {
    precheck: (request: { template: WorkflowDraft; params?: unknown }) => {
      if (refusal !== undefined) throw refusal;
      const params = resolveParams(request.template, request.params);
      checkRendered(request.template, params);
      return {
        params,
        boardId: fixture.boardId,
        workspaceId: fixture.workspaceId,
      };
    },
    startRun: async (request: StartRunRequest) => {
      if (refusal !== undefined) throw refusal;
      started.push(request);
      return insertRun(fixture.database, {
        id: request.runId ?? "run-1",
        templateId: request.template.id,
        templateVersion: request.template.version,
        template: request.template.template,
        workspaceId: fixture.workspaceId,
        boardId: request.boardId as string,
        frameId: "frame-1",
        anchorNodeId: null,
        params: {},
        roles: {},
        startedAt: 1,
        startedByNodeId: request.startedByNodeId ?? null,
      });
    },
  };
  const service = new WorkflowService({
    database: fixture.database,
    engine: engine as never,
    collab: () => undefined,
    clock: () => 1,
  });
  setWorkflowDomain({
    service,
    engine: engine as never,
    stop: async () => {},
  } as WorkflowDomain);
});

afterEach(() => {
  setWorkflowDomain(undefined);
  fixture.close();
  rmSync(fixture.directory, { recursive: true, force: true });
});

function call(args: Record<string, unknown>): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch("workflow-run", callerFor(fixture, caller), args);
}

function refused(outcome: ControlOutcome): { status: number; code: string } {
  if (outcome.ok) throw new Error("expected a refusal");
  return { status: outcome.status, code: outcome.code };
}

describe("workflow-run", () => {
  it("needs --file", async () => {
    expect(refused(await call({}))).toEqual({
      status: 400,
      code: "bad_request",
    });
  });

  it("reads the file itself, upserts the template, starts on the caller's board and answers the frame link", async () => {
    write("flow.md", FILE("流程"));
    const outcome = await call({ file: "flow", params: { scope: "src" } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const template = templateByFileRef(
      fixture.database,
      `${fixture.workspaceId}/flow`,
    );
    expect(template?.name).toBe("流程");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      boardId: fixture.boardId,
      startedByNodeId: caller,
      params: { scope: "src" },
    });
    expect(outcome.body.result).toEqual({
      runId: "run-1",
      templateId: template?.id,
      templateVersion: 1,
      status: "running",
      url: `armadra://w/${fixture.workspaceId}/n/frame-1`,
    });
  });

  it("ignores a draft handed in by the caller", async () => {
    write("flow.md", FILE("文件里的"));
    await call({
      file: "flow",
      params: { scope: "x" },
      draft: { version: 2, title: "调用方的" },
    });
    expect(started[0]?.template.template.title).toBe("文件里的");
  });

  it("refuses a changed file with 409 workflow_file_changed and starts nothing", async () => {
    write("flow.md", FILE("流程"));
    const stale = textHash(FILE("流程", "旧"));
    expect(refused(await call({ file: "flow", hash: stale }))).toEqual({
      status: 409,
      code: "workflow_file_changed",
    });
    expect(started).toHaveLength(0);
    expect(
      await call({
        file: "flow",
        hash: textHash(FILE("流程")),
        params: { scope: "a" },
      }),
    ).toMatchObject({ ok: true });
  });

  it("answers 404 for a missing file and 400 for a bad id", async () => {
    expect(refused(await call({ file: "nope" }))).toMatchObject({
      status: 404,
    });
    expect(refused(await call({ file: "../x" }))).toMatchObject({
      status: 400,
    });
  });

  it("passes the engine's rejection codes through", async () => {
    write("flow.md", FILE("流程"));
    refusal = new DomainError(400, "invalid_draft", "角色不认识");
    expect(
      refused(await call({ file: "flow", params: { scope: "a" } })),
    ).toEqual({ status: 400, code: "invalid_draft" });
  });

  it("dry-run reads and validates but starts nothing and saves no template", async () => {
    write("flow.md", FILE("流程"));
    const outcome = await call({
      file: "flow",
      params: { scope: "a" },
      "dry-run": true,
    });
    expect(outcome.ok).toBe(true);
    expect(started).toHaveLength(0);
    expect(
      templateByFileRef(fixture.database, `${fixture.workspaceId}/flow`),
    ).toBeUndefined();
  });

  it("dry-run still refuses a missing required parameter", async () => {
    write("flow.md", FILE("流程"));
    expect(
      refused(await call({ file: "flow", "dry-run": true })),
    ).toMatchObject({ status: 400 });
  });

  it("a rejected run leaves the template library untouched", async () => {
    write("flow.md", FILE("流程"));
    refusal = new DomainError(
      400,
      "permission_mode_unsupported",
      "没有这个档位",
    );
    expect(
      refused(await call({ file: "flow", params: { scope: "a" } })),
    ).toEqual({ status: 400, code: "permission_mode_unsupported" });
    expect(
      templateByFileRef(fixture.database, `${fixture.workspaceId}/flow`),
    ).toBeUndefined();
    refusal = undefined;
    await call({ file: "flow", params: { scope: "a" } });
    const before = templateByFileRef(
      fixture.database,
      `${fixture.workspaceId}/flow`,
    );
    expect(before?.version).toBe(1);
    write("flow.md", FILE("流程", "改过"));
    refusal = new DomainError(404, "not_found", "没有这块画布。");
    await call({ file: "flow", params: { scope: "a" } });
    expect(
      templateByFileRef(fixture.database, `${fixture.workspaceId}/flow`)
        ?.version,
    ).toBe(1);
  });

  it("dry-run reports the same engine rejection as a real run", async () => {
    write("flow.md", FILE("流程"));
    refusal = new DomainError(
      400,
      "permission_mode_unsupported",
      "没有这个档位",
    );
    expect(
      refused(
        await call({ file: "flow", params: { scope: "a" }, "dry-run": true }),
      ),
    ).toEqual({ status: 400, code: "permission_mode_unsupported" });
  });

  it("a repeated run-id answers the run already started instead of starting another", async () => {
    write("flow.md", FILE("流程"));
    const runId = "0190a0a0-0000-7000-8000-000000000001";
    const first = await call({
      file: "flow",
      params: { scope: "a" },
      "run-id": runId,
    });
    expect(first.ok).toBe(true);
    expect(started[0]?.runId).toBe(runId);
    const again = await call({
      file: "flow",
      params: { scope: "a" },
      "run-id": runId,
    });
    expect(again.ok).toBe(true);
    expect(started).toHaveLength(1);
    if (again.ok) expect(again.body.result).toMatchObject({ runId });
  });

  it("refuses a run-id that is not a UUID", async () => {
    write("flow.md", FILE("流程"));
    expect(
      refused(
        await call({ file: "flow", params: { scope: "a" }, "run-id": "x" }),
      ),
    ).toEqual({ status: 400, code: "bad_request" });
  });
});
