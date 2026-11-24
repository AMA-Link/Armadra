import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/** 迁移 0068（契约 §115，#988）：`pull_snapshots`。 */

const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrations = loadMigrations(directory);

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration.sql);
});
afterEach(() => database.close());

describe("0068 pull snapshots", () => {
  it("creates the table keyed by repo and number", () => {
    expect(migrations.some((migration) => migration.version === 68)).toBe(true);
    const columns = database
      .prepare(
        "SELECT name, \"notnull\" AS required, pk FROM pragma_table_info('pull_snapshots')",
      )
      .all() as { name: string; required: number; pk: number }[];
    const byName = new Map(columns.map((column) => [column.name, column]));
    expect([...byName.keys()].sort()).toEqual([
      "failed_at",
      "fetched_at",
      "fingerprint",
      "number",
      "repo",
      "snapshot_json",
    ]);
    expect(byName.get("failed_at")?.required).toBe(0);
    expect(byName.get("repo")?.pk).toBe(1);
    expect(byName.get("number")?.pk).toBe(2);
  });

  it("keeps one row per pull", () => {
    const insert = database.prepare(
      "INSERT INTO pull_snapshots(repo, number, snapshot_json, fingerprint, fetched_at) VALUES(?, ?, '{}', 'f', 1)",
    );
    insert.run("h/o/r", 1);
    insert.run("h/o/r", 2);
    expect(() => insert.run("h/o/r", 1)).toThrow();
  });
});
