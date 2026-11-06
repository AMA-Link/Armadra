import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { bindThread } from "./threads";
import {
  finishTask,
  rebindTask,
  recordTaskStart,
  reopenTask,
  taskPrompt,
  taskRowJson,
  taskRun,
  taskRunJson,
  taskRunsFor,
  threadsOf,
} from "./task-runs";

/** `workflow_task_runs` 的存取：`task_id` 幂等，结束只结束一次。 */

let fixture: AgentFixture;

beforeEach(() => {
  fixture = agentFixture();
});

afterEach(() => {
  fixture.close();
});

describe("task runs", () => {
  it("is idempotent on taskId and finishes once", () => {
    const first = recordTaskStart(fixture.database, {
      taskId: "t1",
      coordinatorNodeId: "lead",
      runnerId: "codex",
      nodeId: "n1",
      now: 1_000,
    });
    expect(first.inserted).toBe(true);
    const retry = recordTaskStart(fixture.database, {
      taskId: "t1",
      coordinatorNodeId: "lead",
      runnerId: "codex",
      nodeId: "n2",
      now: 2_000,
    });
    expect(retry).toMatchObject({ inserted: false, run: { nodeId: "n1" } });

    rebindTask(fixture.database, "t1", "n2", 3_000);
    expect(taskRun(fixture.database, "t1")).toMatchObject({
      nodeId: "n2",
      status: "running",
      startedAt: 3_000,
    });

    expect(
      finishTask(fixture.database, "t1", "done", { text: "ok" }, 4_000),
    ).toBe(true);
    expect(finishTask(fixture.database, "t1", "failed", null, 5_000)).toBe(
      false,
    );
    const run = taskRun(fixture.database, "t1");
    expect(run).toMatchObject({ status: "done", result: { text: "ok" } });
    expect(taskRunJson(run!)).toMatchObject({
      taskId: "t1",
      status: "done",
      endedAt: new Date(4_000).toISOString(),
    });
    expect(taskRunsFor(fixture.database, "lead")).toHaveLength(1);
    expect(taskRunsFor(fixture.database, "other")).toHaveLength(0);
  });

  it("keeps the task text through finish, rebind and reopen", () => {
    recordTaskStart(fixture.database, {
      taskId: "t2",
      coordinatorNodeId: "lead",
      runnerId: "claude",
      nodeId: "n1",
      now: 1_000,
      task: "审查 src/x",
    });
    expect(reopenTask(fixture.database, "t2", 1_500)).toBe(false);
    finishTask(
      fixture.database,
      "t2",
      "failed",
      { reason: "turnFailed" },
      2_000,
    );
    let run = taskRun(fixture.database, "t2")!;
    expect(run.result).toEqual({ reason: "turnFailed", task: "审查 src/x" });
    expect(taskRowJson(run, "working")).toMatchObject({
      status: "failed",
      reason: "turnFailed",
      retryable: true,
    });
    expect(reopenTask(fixture.database, "t2", 3_000)).toBe(true);
    run = taskRun(fixture.database, "t2")!;
    expect(run).toMatchObject({
      status: "running",
      startedAt: 3_000,
      endedAt: null,
    });
    expect(taskPrompt(run)).toBe("审查 src/x");
    rebindTask(fixture.database, "t2", "n3", 4_000);
    expect(taskPrompt(taskRun(fixture.database, "t2")!)).toBe("审查 src/x");
    finishTask(fixture.database, "t2", "done", null, 5_000);
    expect(taskRun(fixture.database, "t2")!.result).toEqual({
      task: "审查 src/x",
    });
    expect(taskRowJson(taskRun(fixture.database, "t2")!, "idle")).toMatchObject(
      {
        retryable: false,
        reason: null,
      },
    );
  });
});

describe("task row", () => {
  it("lists the bound pulls without the bind time", () => {
    recordTaskStart(fixture.database, {
      taskId: "t9",
      coordinatorNodeId: "lead",
      runnerId: "codex",
      nodeId: "n9",
      now: 1_000,
    });
    expect(
      taskRowJson(taskRun(fixture.database, "t9")!, "working").pulls,
    ).toEqual([]);
    bindThread(
      fixture.database,
      "t9",
      {
        kind: "pull",
        repo: "github.com/acme/app",
        number: 12,
        own: true,
        url: "https://github.com/acme/app/pull/12",
      },
      5_000,
    );
    expect(
      taskRowJson(taskRun(fixture.database, "t9")!, "working").pulls,
    ).toEqual([
      {
        repo: "github.com/acme/app",
        number: 12,
        own: true,
        url: "https://github.com/acme/app/pull/12",
      },
    ]);
    // 绑定的 issue 不进 `pulls`。
    bindThread(
      fixture.database,
      "t9",
      {
        kind: "issue",
        repo: "github.com/acme/app",
        number: 3,
        own: false,
        url: "https://github.com/acme/app/issues/3",
      },
      6_000,
    );
    expect(
      taskRowJson(taskRun(fixture.database, "t9")!, "working").pulls,
    ).toHaveLength(1);
  });
});

describe("threadsOf", () => {
  it("keeps pull and issue threads and drops unknown kinds", () => {
    expect(
      threadsOf(
        JSON.stringify([
          {
            kind: "pull",
            repo: "h/o/r",
            number: 1,
            own: true,
            url: "",
            boundAt: 1,
          },
          {
            kind: "issue",
            repo: "h/o/r",
            number: 2,
            own: true,
            url: "u",
            boundAt: 2,
          },
          { kind: "discussion", repo: "h/o/r", number: 3 },
          { kind: "issue", repo: "", number: 4 },
        ]),
      ),
    ).toEqual([
      {
        kind: "pull",
        repo: "h/o/r",
        number: 1,
        own: true,
        url: "",
        boundAt: 1,
      },
      {
        kind: "issue",
        repo: "h/o/r",
        number: 2,
        own: false,
        url: "u",
        boundAt: 2,
      },
    ]);
  });
});

describe("mandate", () => {
  it("defaults to asked / dispatch and takes a rule mandate when given", () => {
    const asked = recordTaskStart(fixture.database, {
      taskId: "m1",
      coordinatorNodeId: "lead",
      runnerId: "codex",
      nodeId: "n1",
      now: 1_000,
    }).run;
    expect(asked.mandate).toEqual({
      by: "lead",
      basis: "asked",
      scope: "dispatch",
      at: new Date(1_000).toISOString(),
    });
    const rule = recordTaskStart(fixture.database, {
      taskId: "m2",
      coordinatorNodeId: "lead",
      runnerId: "codex",
      nodeId: "n2",
      now: 2_000,
      mandate: { by: "lead", basis: "rule", scope: "intake:s1:abc:alice" },
    }).run;
    expect(rule.mandate).toEqual({
      by: "lead",
      basis: "rule",
      scope: "intake:s1:abc:alice",
      at: new Date(2_000).toISOString(),
    });
  });
});
