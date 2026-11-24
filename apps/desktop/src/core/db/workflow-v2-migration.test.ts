import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/** 迁移 0072（#996）：步骤轮次与结论、模板文件引用、运行的发起节点。 */

const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrations = loadMigrations(directory);
const VERSION = 72;

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
});

afterEach(() => database.close());

function migrateBefore(): void {
  for (const migration of migrations) {
    if (migration.version === VERSION) break;
    database.exec(migration.sql);
  }
}

function apply(): void {
  database.exec(migrations.find((m) => m.version === VERSION)?.sql ?? "");
}

function column(table: string, name: string) {
  return database
    .prepare(
      `SELECT "notnull" AS required, dflt_value AS fallback FROM pragma_table_info('${table}') WHERE name = ?`,
    )
    .get(name) as { required: number; fallback: string | null } | undefined;
}

describe("0072 workflow v2", () => {
  it("adds the columns and keeps old steps at round 0 with no verdict", () => {
    migrateBefore();
    database.exec("PRAGMA foreign_keys = OFF");
    database
      .prepare(
        "INSERT INTO workflow_run_steps(run_id, step_id, kind, status) VALUES('r', 's', 'send', 'done')",
      )
      .run();
    apply();
    expect(column("workflow_run_steps", "round")?.required).toBe(1);
    expect(column("workflow_run_steps", "verdict_json")?.required).toBe(0);
    expect(column("workflow_templates", "file_ref")?.required).toBe(0);
    expect(column("workflow_runs", "started_by_node_id")?.required).toBe(0);
    const row = database
      .prepare("SELECT round, verdict_json FROM workflow_run_steps")
      .get() as { round: number; verdict_json: string | null };
    expect(row.round).toBe(0);
    expect(row.verdict_json).toBeNull();
  });

  it("makes file_ref unique among non-null values only", () => {
    migrateBefore();
    apply();
    const insert = database.prepare(
      "INSERT INTO workflow_templates(id, name, version, template_json, created_at, updated_at, file_ref) " +
        "VALUES(?, 'n', 1, '{}', 1, 1, ?)",
    );
    insert.run("a", null);
    insert.run("b", null);
    insert.run("c", "w/x");
    expect(() => insert.run("d", "w/x")).toThrow();
  });
});
