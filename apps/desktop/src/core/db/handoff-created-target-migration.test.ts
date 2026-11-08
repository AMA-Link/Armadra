import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/**
 * 迁移 0065（契约 §39.8，#872）：`agent_handoffs.created_target_node_id`。
 * 冻结触发器不拦它：新开目标的节点在 accept 时才有，只写一次的记号在冻结之后落库。
 */

const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrations = loadMigrations(directory);

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration.sql);
});

afterEach(() => database.close());

function insert(): void {
  database
    .prepare(
      "INSERT INTO agent_handoffs(id, workspace_id, source_node_id, source_session_id, source_generation, " +
        "target_node_id, target_session_id, target_generation, bundle_json, bundle_digest, created_at, updated_at) " +
        "VALUES('h', 'w', 's', 'ss', 1, '', '', 0, '{}', 'd', 't', 't')",
    )
    .run();
}

describe("0065 handoff created target", () => {
  it("adds a nullable column and its index", () => {
    expect(migrations.at(-1)?.version).toBeGreaterThanOrEqual(65);
    const column = database
      .prepare(
        "SELECT \"notnull\" AS required FROM pragma_table_info('agent_handoffs') WHERE name = 'created_target_node_id'",
      )
      .get() as { required: number } | undefined;
    expect(column?.required).toBe(0);
    const index = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_handoffs_created_target'",
      )
      .get();
    expect(index).toBeDefined();
  });

  it("can be written after the bundle is frozen, while the frozen columns stay frozen", () => {
    insert();
    database
      .prepare(
        "UPDATE agent_handoffs SET created_target_node_id = 'n' WHERE id = 'h'",
      )
      .run();
    expect(() =>
      database
        .prepare(
          "UPDATE agent_handoffs SET target_node_id = 'n' WHERE id = 'h'",
        )
        .run(),
    ).toThrow(/immutable/);
  });
});
