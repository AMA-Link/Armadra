import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/** 迁移 0069（契约 §116，#988）：`node_pull_links`。 */

const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrations = loadMigrations(directory);

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration.sql);
});
afterEach(() => database.close());

function link(node: string, number: number, released: number | null): void {
  database
    .prepare(
      "INSERT INTO node_pull_links(node_id, workspace_id, repo, number, head_ref, url, linked_at, released_at) " +
        "VALUES(?, 'w', 'h/o/r', ?, 'feat', 'u', 1, ?)",
    )
    .run(node, number, released);
}

describe("0069 node pull links", () => {
  it("creates the table keyed by node, repo and number", () => {
    expect(migrations.some((migration) => migration.version === 69)).toBe(true);
    const columns = database
      .prepare(
        "SELECT name, pk FROM pragma_table_info('node_pull_links') ORDER BY name",
      )
      .all() as { name: string; pk: number }[];
    expect(columns.map((column) => column.name)).toEqual([
      "head_ref",
      "linked_at",
      "node_id",
      "number",
      "released_at",
      "repo",
      "url",
      "workspace_id",
    ]);
    expect(columns.filter((column) => column.pk > 0)).toHaveLength(3);
    expect(() => link("n1", 1, null)).not.toThrow();
    expect(() => link("n1", 1, null)).toThrow();
  });

  it("lets only one node hold a pull at a time, released rows excepted", () => {
    link("n1", 7, null);
    expect(() => link("n2", 7, null)).toThrow();
    database
      .prepare(
        "UPDATE node_pull_links SET released_at = 5 WHERE node_id = 'n1'",
      )
      .run();
    expect(() => link("n2", 7, null)).not.toThrow();
    expect(() => link("n3", 7, 6)).not.toThrow();
  });
});
