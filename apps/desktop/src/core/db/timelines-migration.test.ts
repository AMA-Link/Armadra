import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/** 迁移 0052（契约 §82）：`timelines`、`timeline_items`、`timeline_blobs`。 */

const migrations = loadMigrations(
  join(dirname(fileURLToPath(import.meta.url)), "migrations"),
);
const VERSION = migrations.find((m) =>
  m.file.endsWith("_timelines.sql"),
)!.version;

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations.filter((m) => m.version <= VERSION))
    database.exec(migration.sql);
});

afterEach(() => database.close());

const insertTimeline = (id = "s1") =>
  database
    .prepare(
      "INSERT INTO timelines(id, workspace_id, node_id, created_at_ms, updated_at_ms) VALUES(?, 'w', 'n', 1, 1)",
    )
    .run(id);

describe("迁移 0052 timelines", () => {
  it("编号紧接 0051，取的是 main 的下一个号", () => {
    expect(VERSION).toBe(52);
    expect(migrations.map((m) => m.version)).toEqual(
      migrations.map((_, index) => index + 1),
    );
  });

  it("新建的时间线序号从 0 起，头部值是空对象", () => {
    insertTimeline();
    expect(
      database.prepare("SELECT * FROM timelines WHERE id = 's1'").get(),
    ).toMatchObject({
      head_seq: 0,
      head_rev: 0,
      source: "acp",
      source_cursor: "",
      head_json: "{}",
    });
  });

  it("条目以 (时间线, 条目 id) 为键，rev 必须为正，墓碑只能是 0 或 1", () => {
    insertTimeline();
    const put = database.prepare(
      "INSERT INTO timeline_items(timeline_id, item_id, rev, deleted, data_json) VALUES('s1', ?, ?, ?, '{}')",
    );
    put.run("a", 1, 0);
    expect(() => put.run("a", 2, 0)).toThrow();
    expect(() => put.run("b", 0, 0)).toThrow();
    expect(() => put.run("c", 1, 2)).toThrow();
  });

  it("按 rev 与按回合各有一个索引", () => {
    const indexes = database
      .prepare(
        "SELECT name FROM pragma_index_list('timeline_items') WHERE origin = 'c' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual([
      "timeline_items_by_rev",
      "timeline_items_by_turn",
    ]);
  });

  it("删时间线连条目与 blob 登记一起走；不对 nodes 建外键", () => {
    insertTimeline();
    database
      .prepare(
        "INSERT INTO timeline_items(timeline_id, item_id, rev) VALUES('s1', 'a', 1)",
      )
      .run();
    database
      .prepare(
        "INSERT INTO timeline_blobs(timeline_id, blob_id, bytes) VALUES('s1', 'b', 3)",
      )
      .run();
    database.prepare("DELETE FROM timelines WHERE id = 's1'").run();
    expect(
      database.prepare("SELECT COUNT(*) AS n FROM timeline_items").get(),
    ).toEqual({ n: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS n FROM timeline_blobs").get(),
    ).toEqual({ n: 0 });
    // 节点不在 nodes 里照样能建（ACP 会话先于节点落盘）。
    expect(() => insertTimeline("s2")).not.toThrow();
  });

  it("条目不能挂在不存在的时间线上", () => {
    expect(() =>
      database
        .prepare(
          "INSERT INTO timeline_items(timeline_id, item_id, rev) VALUES('nope', 'a', 1)",
        )
        .run(),
    ).toThrow();
  });
});
