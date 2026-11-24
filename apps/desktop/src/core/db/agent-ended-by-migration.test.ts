import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/** 迁移 0070（#988）：`agent_status.ended_by`，可空，旧行为 NULL。 */

const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrations = loadMigrations(directory);

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
});

afterEach(() => database.close());

describe("0070 agent status ended_by", () => {
  it("adds a nullable column and keeps existing rows NULL", () => {
    for (const migration of migrations) {
      if (migration.version === 70) break;
      database.exec(migration.sql);
    }
    database.exec("PRAGMA foreign_keys = OFF");
    database
      .prepare(
        "INSERT INTO agent_status(node_id, workspace_id, agent_id, unread, verified, restored, updated_at) " +
          "VALUES('n', 'w', 'claude', 0, 0, 0, 't')",
      )
      .run();
    database.exec(migrations.find((m) => m.version === 70)?.sql ?? "");
    const column = database
      .prepare(
        "SELECT \"notnull\" AS required FROM pragma_table_info('agent_status') WHERE name = 'ended_by'",
      )
      .get() as { required: number } | undefined;
    expect(column?.required).toBe(0);
    const row = database
      .prepare("SELECT ended_by FROM agent_status WHERE node_id = 'n'")
      .get() as { ended_by: string | null };
    expect(row.ended_by).toBeNull();
  });
});
