import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/**
 * 迁移 0063（契约 §103.1）：`workflow_task_runs.threads` 一列，加 `thread_events`
 * 账表（事件 id 在一个工作项里唯一，工作项删了跟着删）。
 */

const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrations = loadMigrations(directory);

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) database.exec(migration.sql);
});

afterEach(() => database.close());

describe("0063 pr threads", () => {
  it("adds a nullable threads column", () => {
    expect(migrations.at(-1)?.version).toBeGreaterThanOrEqual(63);
    const column = database
      .prepare(
        "SELECT type, \"notnull\" AS required FROM pragma_table_info('workflow_task_runs') WHERE name = 'threads'",
      )
      .get() as { type: string; required: number };
    expect(column).toEqual({ type: "TEXT", required: 0 });
  });

  it("keeps one row per (item, event id)", () => {
    const columns = database
      .prepare(
        "SELECT name FROM pragma_table_info('thread_events') ORDER BY cid",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual([
      "item_id",
      "event_id",
      "repo",
      "number",
      "kind",
      "actor",
      "delivered",
      "source_at",
      "seen_at",
    ]);
  });
});
