import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/**
 * 迁移 0064（契约 §104.1–§104.2）：`router_sources` 与 `router_intake` 两张表、
 * 两个索引；来源删了候选跟着删，一个协调者同一个仓库只有一个来源。
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

function columns(table: string): string[] {
  return database
    .prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)
    .all()
    .map((row) => (row as { name: string }).name);
}

describe("0064 router intake", () => {
  it("creates both tables and their indexes", () => {
    expect(migrations.at(-1)?.version).toBeGreaterThanOrEqual(64);
    expect(columns("router_sources")).toEqual([
      "id",
      "coordinator_node_id",
      "workspace_id",
      "repo",
      "kinds",
      "mode",
      "allow_json",
      "rules_hash",
      "enabled",
      "cursor_at",
      "created_at",
      "updated_at",
    ]);
    expect(columns("router_intake")).toContain("verdict");
    expect(columns("router_intake")).toContain("dispatched_at");
    const indexes = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'router_intake' AND name LIKE 'router_%' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toEqual(["router_intake_thread", "router_intake_verdict"]);
  });

  it("rejects an unknown verdict or review", () => {
    database.exec("PRAGMA foreign_keys = OFF");
    const insert = (
      id: string,
      verdict: string | null,
      review: string | null,
    ) =>
      database
        .prepare(
          "INSERT INTO router_intake (id, source_id, coordinator_node_id, workspace_id, kind, repo, number, title, url, " +
            "request_json, source_at, seen_at, verdict, review) VALUES (?, 's', 'n', 'w', 'issue', 'r', 1, 't', '', '{}', 1, 1, ?, ?)",
        )
        .run(id, verdict, review);
    insert("ok", "accept", "agree");
    insert("open", null, null);
    expect(() => insert("bad-verdict", "maybe", null)).toThrow();
    expect(() => insert("bad-review", "skip", "meh")).toThrow();
  });
});
