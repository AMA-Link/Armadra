import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SourcesStore } from "../sources/store";
import { loadMigrations } from "./migrations";

/**
 * 迁移 0047（契约 §68）：源表加 `origin` / `owner_label` / `share_role` /
 * `share_expires_at_ms`。回填：只经访客远程服务（账号提示为空）中继到达的源是按
 * 分享链接加入的 → `shared`；本机、配对、用账号挂上的留 `mine`。
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

const LOCAL = "0".repeat(32);
const PAIRED = "1".repeat(32);
const MOUNTED = "2".repeat(32);
const JOINED = "3".repeat(32);
const JOINED_THEN_PAIRED = "4".repeat(32);
const GUEST = "https://guest.test";
const ACCOUNT = "https://account.test";

function source(sourceId: string, kind: string) {
  database
    .prepare(
      "INSERT INTO client_sources(source_id, kind, label, added_at_ms) VALUES(?, ?, 'x', 1)",
    )
    .run(sourceId, kind);
}

function route(sourceId: string, via: string, origin: string, issuer = "") {
  database
    .prepare(
      "INSERT INTO client_source_routes(source_id, via, origin, cloud_issuer, added_at_ms) VALUES(?, ?, ?, ?, 1)",
    )
    .run(sourceId, via, origin, issuer);
}

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
});

afterEach(() => database.close());

describe("0047 source_origin", () => {
  it("回填：只经访客服务中继到达的是 shared，其余 mine；新列缺省为空", () => {
    upTo(46);
    database
      .prepare(
        "INSERT INTO remote_services(service_id, kind, issuer, label, account_hint, added_at_ms) VALUES(?, 'personal', ?, 'g', '', 1)",
      )
      .run("a".repeat(32), GUEST);
    database
      .prepare(
        "INSERT INTO remote_services(service_id, kind, issuer, label, account_hint, added_at_ms) VALUES(?, 'personal', ?, 'a', 'me@x', 1)",
      )
      .run("b".repeat(32), ACCOUNT);
    source(LOCAL, "local");
    source(PAIRED, "direct");
    route(PAIRED, "direct", "https://gw.test");
    source(MOUNTED, "relayed");
    route(MOUNTED, "relayed", ACCOUNT, ACCOUNT);
    source(JOINED, "relayed");
    route(JOINED, "relayed", GUEST, GUEST);
    source(JOINED_THEN_PAIRED, "relayed");
    route(JOINED_THEN_PAIRED, "relayed", GUEST, GUEST);
    route(JOINED_THEN_PAIRED, "direct", "https://lan.test");
    after(46);

    const store = new SourcesStore(database);
    const origins = Object.fromEntries(
      store.list().map((row) => [row.sourceId, row.origin]),
    );
    expect(origins).toEqual({
      [LOCAL]: "mine",
      [PAIRED]: "mine",
      [MOUNTED]: "mine",
      [JOINED]: "shared",
      [JOINED_THEN_PAIRED]: "mine",
    });
    expect(store.get(JOINED)).toMatchObject({
      ownerLabel: "",
      shareRole: "",
      shareExpiresAtMs: 0,
    });
  });

  it("约束：origin 与角色只收已知值，名字不超过 128，到期不为负", () => {
    upTo(47);
    source(JOINED, "relayed");
    for (const [column, value] of [
      ["origin", "theirs"],
      ["share_role", "admin"],
      ["owner_label", "x".repeat(129)],
      ["share_expires_at_ms", -1],
    ] as const) {
      expect(() =>
        database.prepare(`UPDATE client_sources SET ${column} = ?`).run(value),
      ).toThrow();
    }
    const store = new SourcesStore(database);
    store.setShare(JOINED, {
      ownerLabel: "Alice",
      shareRole: "viewer",
      shareExpiresAtMs: 7,
    });
    // setShare 只改 shared 的行。
    expect(store.get(JOINED)).toMatchObject({ origin: "mine", shareRole: "" });
    database.prepare("UPDATE client_sources SET origin = 'shared'").run();
    store.setShare(JOINED, {
      ownerLabel: "Alice",
      shareRole: "viewer",
      shareExpiresAtMs: 7,
    });
    expect(store.get(JOINED)).toMatchObject({
      origin: "shared",
      ownerLabel: "Alice",
      shareRole: "viewer",
      shareExpiresAtMs: 7,
    });
  });
});
