import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SourcesStore } from "../sources/store";
import { loadMigrations } from "./migrations";

/**
 * 迁移 0054（契约 §86）：源表加 `team_id` / `team_name`。旧行回填空串（个人分享、
 * 本机、配对），长度受表约束；源表的读写带出这两列，`setShare` 一并改写。
 */

const migrations = loadMigrations(
  join(dirname(fileURLToPath(import.meta.url)), "migrations"),
);

let database: DatabaseSync;

function upTo(version: number) {
  for (const migration of migrations.filter((m) => m.version <= version))
    database.exec(migration.sql);
}

function after(version: number) {
  for (const migration of migrations.filter((m) => m.version > version))
    database.exec(migration.sql);
}

const JOINED = "3".repeat(32);

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
});

afterEach(() => database.close());

describe("0054 source_teams", () => {
  it("旧行回填空串，源表带出两列", () => {
    upTo(53);
    database
      .prepare(
        "INSERT INTO client_sources(source_id, kind, label, added_at_ms, origin) VALUES(?, 'relayed', 'x', 1, 'shared')",
      )
      .run(JOINED);
    after(53);
    const store = new SourcesStore(database);
    expect(store.get(JOINED)).toMatchObject({ teamId: "", teamName: "" });
  });

  it("约束：标识与名字不超过 128", () => {
    upTo(54);
    database
      .prepare(
        "INSERT INTO client_sources(source_id, kind, label, added_at_ms) VALUES(?, 'relayed', 'x', 1)",
      )
      .run(JOINED);
    for (const column of ["team_id", "team_name"]) {
      expect(() =>
        database
          .prepare(`UPDATE client_sources SET ${column} = ?`)
          .run("x".repeat(129)),
      ).toThrow();
      database
        .prepare(`UPDATE client_sources SET ${column} = ?`)
        .run("x".repeat(128));
    }
  });

  it("setShare 写团队，下一次不报团队时清回个人；只改 shared 的行", () => {
    upTo(54);
    database
      .prepare(
        "INSERT INTO client_sources(source_id, kind, label, added_at_ms) VALUES(?, 'relayed', 'x', 1)",
      )
      .run(JOINED);
    const store = new SourcesStore(database);
    const share = {
      ownerLabel: "Alice",
      shareRole: "viewer" as const,
      shareExpiresAtMs: 0,
      teamId: "team-1",
      teamName: "研发组",
    };
    store.setShare(JOINED, share);
    expect(store.get(JOINED)).toMatchObject({ teamId: "", teamName: "" });
    database.prepare("UPDATE client_sources SET origin = 'shared'").run();
    store.setShare(JOINED, share);
    expect(store.get(JOINED)).toMatchObject({
      teamId: "team-1",
      teamName: "研发组",
    });
    store.setShare(JOINED, { ...share, teamId: "", teamName: "" });
    expect(store.get(JOINED)).toMatchObject({ teamId: "", teamName: "" });
  });
});
