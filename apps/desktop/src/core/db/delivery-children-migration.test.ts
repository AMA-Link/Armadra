import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/** 迁移 0071（#995）：`agent_status.done_at` 可空，旧行为 NULL；任务运行加协调者索引。 */

const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrations = loadMigrations(directory);

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
});

afterEach(() => database.close());

describe("0071 delivery children", () => {
  it("adds a nullable done_at, keeps old rows NULL and creates the index", () => {
    for (const migration of migrations) {
      if (migration.version === 71) break;
      database.exec(migration.sql);
    }
    database.exec("PRAGMA foreign_keys = OFF");
    database
      .prepare(
        "INSERT INTO agent_status(node_id, workspace_id, agent_id, unread, verified, restored, updated_at) " +
          "VALUES('n', 'w', 'claude', 0, 0, 0, 't')",
      )
      .run();
    database.exec(migrations.find((m) => m.version === 71)?.sql ?? "");
    const column = database
      .prepare(
        "SELECT \"notnull\" AS required FROM pragma_table_info('agent_status') WHERE name = 'done_at'",
      )
      .get() as { required: number } | undefined;
    expect(column?.required).toBe(0);
    const row = database
      .prepare("SELECT done_at FROM agent_status WHERE node_id = 'n'")
      .get() as { done_at: string | null };
    expect(row.done_at).toBeNull();
    const index = database
      .prepare(
        "SELECT name FROM pragma_index_list('workflow_task_runs') WHERE name = 'workflow_task_runs_coordinator_status'",
      )
      .get();
    expect(index).toBeDefined();
  });
});
