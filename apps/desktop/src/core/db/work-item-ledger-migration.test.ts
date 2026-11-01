import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { taskRun } from "../workflow/task-runs";
import { loadMigrations } from "./migrations";

/**
 * 迁移 0058（契约 §90）：`workflow_task_runs` 原地扩列，**只加列**；旧行原样读得
 * 出来，新列为空。
 */

const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrations = loadMigrations(directory);

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
});

afterEach(() => database.close());

describe("0058 work_item_ledger", () => {
  it("only adds columns to workflow_task_runs", () => {
    const sql = readFileSync(
      join(directory, "0058_work_item_ledger.sql"),
      "utf8",
    );
    const statements = sql
      .split("\n")
      .filter((line) => !line.startsWith("--") && line.trim() !== "");
    expect(statements.length).toBeGreaterThan(0);
    for (const line of statements) {
      expect(line).toMatch(
        /^ALTER TABLE workflow_task_runs ADD COLUMN [a-z_]+ TEXT;$/,
      );
    }
  });

  it("keeps old rows readable and leaves the new columns empty", () => {
    for (const migration of migrations.filter((m) => m.version <= 57)) {
      database.exec(migration.sql);
    }
    database
      .prepare(
        "INSERT INTO workflow_task_runs (task_id, coordinator_node_id, runner_id, node_id, status, started_at) " +
          "VALUES ('old', 'lead', 'codex', 'n1', 'running', 1000)",
      )
      .run();
    for (const migration of migrations.filter((m) => m.version > 57)) {
      database.exec(migration.sql);
    }
    expect(taskRun(database, "old")).toMatchObject({
      taskId: "old",
      status: "running",
      title: null,
      origin: null,
      mandate: null,
      report: null,
      reports: [],
      attention: null,
      handback: null,
      stage: null,
    });
    const columns = (
      database.prepare("PRAGMA table_info('workflow_task_runs')").all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "title",
        "origin_json",
        "mandate_json",
        "report_json",
        "attention_json",
        "stage",
      ]),
    );
  });
});
