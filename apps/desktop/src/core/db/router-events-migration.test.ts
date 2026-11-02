import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/**
 * 迁移 0059（契约 §93）：新表 `router_events`，不动已有的表；节点删了事件跟着
 * 删（`collab/router.test.ts` 用真节点验）。
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

describe("0059 router_events", () => {
  it("is numbered after 0058 and only creates its own table and index", () => {
    expect(migrations.at(-1)?.version).toBeGreaterThanOrEqual(59);
    const created = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'router_events%' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(created.map((row) => row.name)).toEqual([
      "router_events",
      "router_events_open",
    ]);
  });

  it("has the columns the queue reads", () => {
    const columns = database
      .prepare("SELECT name FROM pragma_table_info('router_events')")
      .all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "coordinator_node_id",
      "workspace_id",
      "kind",
      "item_id",
      "source_node_id",
      "summary",
      "created_at",
      "carded_at",
      "acked_at",
    ]);
  });
});
