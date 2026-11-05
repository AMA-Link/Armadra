import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/**
 * 迁移 0062（契约 §101.5）：`workflow_task_runs` 只加一列 `recovery_pending`，
 * 旧行缺省为 0。
 */

const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrations = loadMigrations(directory);

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration.sql);
});

afterEach(() => database.close());

describe("0062 recovery_pending", () => {
  it("adds one non-null column defaulting to 0", () => {
    expect(migrations.at(-1)?.version).toBeGreaterThanOrEqual(62);
    const column = database
      .prepare(
        "SELECT type, \"notnull\" AS required, dflt_value AS fallback FROM pragma_table_info('workflow_task_runs') WHERE name = 'recovery_pending'",
      )
      .get() as { type: string; required: number; fallback: string };
    expect(column).toEqual({ type: "INTEGER", required: 1, fallback: "0" });
  });
});
