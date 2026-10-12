import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShareLinkStore } from "../relay/e2e/pairing";
import { loadMigrations } from "./migrations";

/** 迁移 0051（契约 §80）：`share_links`，core 侧的链接记录与访客设备名额。 */

const migrations = loadMigrations(
  join(dirname(fileURLToPath(import.meta.url)), "migrations"),
);
const VERSION = migrations.find((m) =>
  m.file.endsWith("_share_links.sql"),
)!.version;

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  for (const migration of migrations.filter((m) => m.version <= VERSION))
    database.exec(migration.sql);
});

afterEach(() => database.close());

describe("迁移 0051 share_links", () => {
  it("存、读、撤；名额可以不限（NULL），不能是负数", () => {
    const store = new ShareLinkStore(database);
    store.save({
      linkId: "lnk_1",
      issuer: "https://relay.test",
      invitationId: "a".repeat(32),
      maxDevices: null,
      identityFpShown: "abcdefgh234567ab",
      createdAtMs: 1,
      revokedAtMs: 0,
    });
    expect(store.get("lnk_1")).toMatchObject({
      maxDevices: null,
      identityFpShown: "abcdefgh234567ab",
    });
    store.revoke("lnk_1", 5);
    expect(store.get("lnk_1")?.revokedAtMs).toBe(5);
    expect(() =>
      store.save({
        linkId: "lnk_2",
        issuer: "",
        invitationId: "",
        maxDevices: -1,
        identityFpShown: "",
        createdAtMs: 1,
        revokedAtMs: 0,
      }),
    ).toThrow();
  });
});
