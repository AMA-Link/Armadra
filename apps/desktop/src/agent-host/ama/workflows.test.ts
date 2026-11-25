import { describe, expect, it, vi } from "vitest";
import type { HostApi, HostWorkflowRunRequest } from "@armadra/agent/host";
import type { JsonValue } from "../../hook-client/json";
import type { ControlAnswer } from "./client";
import { WORKFLOW_RUN_TIMEOUT_MS } from "../../cli/armadra-hook/control";
import {
  WorkflowRefusal,
  provideWorkflows,
  workflowHandler,
} from "./workflows";

/** The hosted workflow handler against a scripted core (design §2.9). */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Call = {
  verb: string;
  args: Record<string, JsonValue>;
  totalMs?: number | undefined;
};

function core(answer: (call: Call) => ControlAnswer) {
  const calls: Call[] = [];
  const control = vi.fn(
    async (verb: string, args: Record<string, JsonValue>, totalMs?: number) => {
      const call = { verb, args, totalMs };
      calls.push(call);
      return answer(call);
    },
  );
  return { calls, control };
}

const ok = (result: unknown): ControlAnswer => ({
  kind: "ok",
  body: { ok: true, message: "", result },
});

function request(
  overrides: Partial<HostWorkflowRunRequest> = {},
): HostWorkflowRunRequest {
  return {
    workflowId: "review",
    workflow: {
      version: 2,
      title: "Review",
      roles: [{ id: "a", agentId: "codex" }],
      steps: [{ id: "s", kind: "prompt", role: "a", prompt: "x" }],
    } as unknown as HostWorkflowRunRequest["workflow"],
    params: {},
    source: {
      scope: "project",
      filePath: "/w/.ama/workflows/review.md",
      hash: "h1",
    },
    sessionId: "sess",
    cwd: "/w",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("workflowHandler", () => {
  it("declares format version 2", () => {
    expect(
      workflowHandler({ control: vi.fn(), log: vi.fn() }).versions,
    ).toEqual([2]);
  });

  it("starts a project workflow by file id and hash, never sending the document", async () => {
    const { calls, control } = core(() =>
      ok({ runId: "r1", url: "armadra://w/x/n/f", status: "running" }),
    );
    const handler = workflowHandler({ control, log: vi.fn() });
    const started = await handler.run(request({ params: { scope: "src" } }));
    expect(started).toEqual({ runId: "r1", url: "armadra://w/x/n/f" });
    expect(calls).toEqual([
      {
        verb: "workflow-run",
        args: {
          file: "review",
          hash: "h1",
          "run-id": expect.stringMatching(UUID),
          params: { scope: "src" },
        },
        totalMs: WORKFLOW_RUN_TIMEOUT_MS,
      },
    ]);
  });

  it("sends a fresh run id per call, so a deliberate rerun starts a new run", async () => {
    const { calls, control } = core(() => ok({ runId: "r1" }));
    const handler = workflowHandler({ control, log: vi.fn() });
    await handler.run(request({ params: { x: "1" } }));
    await handler.run(request({ params: { x: "1" } }));
    const [a, b] = calls.map((c) => c.args["run-id"]);
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });

  it("retries a timed-out workflow-run once with the same run id", async () => {
    let n = 0;
    const { calls, control } = core(() =>
      n++ === 0
        ? { kind: "unreachable", error: "timeout" }
        : ok({ runId: "r1" }),
    );
    const started = await workflowHandler({ control, log: vi.fn() }).run(
      request(),
    );
    expect(started).toEqual({ runId: "r1" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args["run-id"]).toBe(calls[0]?.args["run-id"]);
  });

  it("does not retry once the run was aborted", async () => {
    const controller = new AbortController();
    const { calls, control } = core(() => {
      controller.abort();
      return { kind: "unreachable", error: "timeout" };
    });
    await expect(
      workflowHandler({ control, log: vi.fn() }).run(
        request({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: "workflow_host_unreachable" });
    expect(calls).toHaveLength(1);
  });

  it("gives workflow-run a longer budget than the plain verb budget", () => {
    expect(WORKFLOW_RUN_TIMEOUT_MS).toBeGreaterThan(15_000);
  });

  it("refuses at once when the run was already aborted, and does not call the core", async () => {
    const { calls, control } = core(() => ok({ runId: "r1" }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      workflowHandler({ control, log: vi.fn() }).run(
        request({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: "workflow_aborted" });
    expect(calls).toHaveLength(0);
  });

  it("says the workspace root's file is authoritative on a 404 or 409", async () => {
    const { control } = core(() => ({
      kind: "refused",
      status: 404,
      code: "not_found",
      message: "no such file",
    }));
    await expect(
      workflowHandler({ control, log: vi.fn() }).run(request()),
    ).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("workspace root"),
    });
  });

  it("leaves params out when there are none and url out when the core gives none", async () => {
    const { calls, control } = core(() => ok({ runId: "r1" }));
    const started = await workflowHandler({ control, log: vi.fn() }).run(
      request(),
    );
    expect(started).toEqual({ runId: "r1" });
    expect(calls[0]?.args).toEqual({
      file: "review",
      hash: "h1",
      "run-id": expect.stringMatching(UUID),
    });
  });

  it("keeps the core's refusal code, workflow_file_changed included", async () => {
    const { control } = core(() => ({
      kind: "refused",
      status: 409,
      code: "workflow_file_changed",
      message: "changed",
    }));
    await expect(
      workflowHandler({ control, log: vi.fn() }).run(request()),
    ).rejects.toMatchObject({
      code: "workflow_file_changed",
      message: expect.stringContaining("changed"),
    });
  });

  it("reports an unreachable core and a malformed answer as refusals", async () => {
    const down = core(() => ({ kind: "unreachable", error: "no endpoint" }));
    await expect(
      workflowHandler({ control: down.control, log: vi.fn() }).run(request()),
    ).rejects.toBeInstanceOf(WorkflowRefusal);
    const bad = core(() => ok({}));
    await expect(
      workflowHandler({ control: bad.control, log: vi.fn() }).run(request()),
    ).rejects.toMatchObject({ code: "workflow_host_error" });
  });

  it.each(["user", "config"] as const)(
    "turns a %s workflow into a draft card and refuses with workflow_unsupported",
    async (scope) => {
      const { calls, control } = core(() => ok({ draftId: "d1" }));
      const req = request({
        source: {
          scope,
          filePath: "/home/.ama/workflows/review.md",
          hash: "h2",
        },
      });
      await expect(
        workflowHandler({ control, log: vi.fn() }).run(req),
      ).rejects.toMatchObject({ code: "workflow_unsupported" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.verb).toBe("workflow-propose");
      expect(calls[0]?.args).toEqual({ draft: req.workflow });
    },
  );

  it("still refuses with workflow_unsupported when the draft card cannot be made", async () => {
    const log = vi.fn();
    const { control } = core(() => ({
      kind: "refused",
      status: 400,
      code: "invalid_draft",
      message: "bad",
    }));
    await expect(
      workflowHandler({ control, log }).run(
        request({ source: { scope: "user", filePath: "/u/r.md", hash: "h" } }),
      ),
    ).rejects.toMatchObject({ code: "workflow_unsupported" });
    expect(log).toHaveBeenCalled();
  });

  it("only ever calls workflow-run and workflow-propose: no gate is answered", async () => {
    const { calls, control } = core(() => ok({ runId: "r1" }));
    await workflowHandler({ control, log: vi.fn() }).run(request());
    expect(calls.map((c) => c.verb)).toEqual(["workflow-run"]);
  });
});

describe("provideWorkflows", () => {
  it("registers only with workflows.provide and hands back its unregister", () => {
    const off = vi.fn();
    const provide = vi.fn(() => off);
    const api = { workflows: { provide }, log: vi.fn() } as unknown as HostApi;
    provideWorkflows(api)();
    expect(provide).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
    expect(() =>
      provideWorkflows({ log: vi.fn() } as unknown as HostApi)(),
    ).not.toThrow();
  });

  it("logs and carries on when another host already provides one", () => {
    const log = vi.fn();
    const api = {
      workflows: {
        provide: () => {
          throw new Error("workflow_handler_exists");
        },
      },
      log,
    } as unknown as HostApi;
    expect(() => provideWorkflows(api)()).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      "warn",
      expect.any(String),
      expect.any(Error),
    );
  });
});
