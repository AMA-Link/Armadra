import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "../db/migrations";
import {
  escalateCollect,
  insertTemplate,
  recordVerdict,
  reopenStep,
  requeueCollect,
  stepOfRun,
  templateById,
  transitionStep,
  updateTemplate,
  verifyingStepsOf,
} from "./store";
import type { WorkflowDraft } from "./types";

/** 工作流 v2 存取（#996）：轮次、结论、模板修订号。 */

const directory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "migrations",
);

let database: DatabaseSync;

const DRAFT = {
  version: 2,
  title: "t",
  params: [],
  roles: [],
  steps: [],
} as unknown as WorkflowDraft;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = OFF");
  for (const migration of loadMigrations(directory)) {
    database.exec(migration.sql);
  }
  database
    .prepare(
      "INSERT INTO workflow_runs(id, template_id, template_version, template_json, workspace_id, board_id, " +
        "params_json, roles_json, status, started_at) VALUES('r', 't', 1, '{}', 'w', 'b', '{}', '{}', 'running', 1)",
    )
    .run();
});

afterEach(() => database.close());

function addStep(
  stepId: string,
  status: string,
  nodeId: string | null = "n",
  kind = "collect",
): void {
  database
    .prepare(
      "INSERT INTO workflow_run_steps(run_id, step_id, kind, status, node_id) VALUES('r', ?, ?, ?, ?)",
    )
    .run(stepId, kind, status, nodeId);
}

function dirty(stepId: string): void {
  database
    .prepare(
      "UPDATE workflow_run_steps SET started_at = 10, ended_at = 20, reason = 'x', " +
        "outcome_json = '{}', queue_id = 'q', attempts = 3, delivered = 1, baseline_state = 'done', " +
        "baseline_event_at = 'e', observed_busy = 1 WHERE run_id = 'r' AND step_id = ?",
    )
    .run(stepId);
}

const VERDICT = {
  round: 0,
  pass: false,
  issues: [{ role: "a", text: "bad" }],
  at: 5,
};

describe("templates", () => {
  it("inserts at revision 1 whatever the draft format version", () => {
    const row = insertTemplate(database, {
      id: "t1",
      name: "n",
      template: { ...DRAFT, version: 7 },
      createdFromDraft: null,
      createdAt: 1,
    });
    expect(row.version).toBe(1);
  });

  it("updates only when baseVersion matches and bumps the revision by one", () => {
    insertTemplate(database, {
      id: "t1",
      name: "n",
      template: DRAFT,
      createdFromDraft: null,
      createdAt: 1,
    });
    expect(updateTemplate(database, "t1", "m", DRAFT, 2, 5)).toBe(false);
    expect(templateById(database, "t1")?.version).toBe(1);
    expect(updateTemplate(database, "t1", "m", DRAFT, 2, 1)).toBe(true);
    expect(templateById(database, "t1")?.version).toBe(2);
    expect(updateTemplate(database, "t1", "m", DRAFT, 3, 1)).toBe(false);
  });
});

describe("reopenStep", () => {
  it("only changes a done step and resets every column", () => {
    addStep("s", "done");
    dirty("s");
    expect(reopenStep(database, "r", "s", 99)).toBe(true);
    const step = stepOfRun(database, "r", "s");
    expect(step).toMatchObject({
      status: "running",
      round: 1,
      startedAt: 99,
      endedAt: null,
      reason: null,
      outcome: null,
      queueId: null,
      attempts: 0,
      delivered: false,
      baselineState: null,
      baselineEventAt: null,
      observedBusy: false,
    });
    expect(reopenStep(database, "r", "s", 100)).toBe(false);
  });

  it.each(["pending", "running", "waiting", "failed", "cancelled"])(
    "leaves a %s step alone",
    (status) => {
      addStep("s", status);
      expect(reopenStep(database, "r", "s", 99)).toBe(false);
      expect(stepOfRun(database, "r", "s")?.round).toBe(0);
    },
  );
});

describe("requeueCollect", () => {
  it("sends a running step back to pending, keeping the verdict", () => {
    addStep("s", "running");
    dirty("s");
    recordVerdict(database, "r", "s", VERDICT);
    expect(requeueCollect(database, "r", "s")).toBe(true);
    expect(stepOfRun(database, "r", "s")).toMatchObject({
      status: "pending",
      round: 1,
      reason: "verifyFailed",
      startedAt: null,
      endedAt: null,
      queueId: null,
      attempts: 0,
      delivered: false,
      baselineState: null,
      baselineEventAt: null,
      observedBusy: false,
      verdict: VERDICT,
    });
  });

  it.each(["pending", "done", "waiting"])("ignores a %s step", (status) => {
    addStep("s", status);
    expect(requeueCollect(database, "r", "s")).toBe(false);
    expect(stepOfRun(database, "r", "s")?.status).toBe(status);
  });
});

describe("escalateCollect", () => {
  it("moves a running step to waiting with the reason", () => {
    addStep("s", "running");
    expect(escalateCollect(database, "r", "s", "verifyExhausted")).toBe(true);
    expect(stepOfRun(database, "r", "s")).toMatchObject({
      status: "waiting",
      reason: "verifyExhausted",
      round: 0,
    });
  });

  it("ignores a step that is not running", () => {
    addStep("s", "done");
    expect(escalateCollect(database, "r", "s", "x")).toBe(false);
  });
});

describe("recordVerdict and verifyingStepsOf", () => {
  it("keeps only the latest verdict and only on a running step", () => {
    addStep("s", "running");
    addStep("d", "done");
    expect(recordVerdict(database, "r", "s", VERDICT)).toBe(true);
    const latest = { ...VERDICT, round: 1, pass: true, issues: [], at: 9 };
    expect(recordVerdict(database, "r", "s", latest)).toBe(true);
    expect(stepOfRun(database, "r", "s")?.verdict).toEqual(latest);
    expect(recordVerdict(database, "r", "d", VERDICT)).toBe(false);
  });

  it("lists running collect steps of a node in live runs", () => {
    addStep("c1", "running");
    addStep("p1", "running", "n", "prompt");
    addStep("c2", "done");
    addStep("c3", "running", "other");
    expect(verifyingStepsOf(database, "n")).toEqual([
      { runId: "r", stepId: "c1", round: 0 },
    ]);
    transitionStep(database, "r", "c1", ["running"], "done", { endedAt: 1 });
    expect(verifyingStepsOf(database, "n")).toEqual([]);
    addStep("c4", "running");
    database.prepare("UPDATE workflow_runs SET status = 'done'").run();
    expect(verifyingStepsOf(database, "n")).toEqual([]);
  });
});
