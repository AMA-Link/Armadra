import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TrafficStore } from "../traffic/store";
import { loadMigrations } from "./migrations";

/**
 * 迁移 0049（契约 §76）：`traffic_buckets`。整点桶、已知的路线 / 对端种类 / 类别，
 * 计数不为负；主键含全部维度，同一键 upsert 时相加。
 */

const migrations = loadMigrations(
  join(dirname(fileURLToPath(import.meta.url)), "migrations"),
);

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations.filter((m) => m.version <= 49))
    database.exec(migration.sql);
});

afterEach(() => database.close());

const ROW = {
  bucket: 3_600_000 * 500_000,
  route: "relay",
  peerKind: "legacy",
  category: "terminal",
  bytes: 1,
};

function insert(row: Partial<typeof ROW>) {
  const value = { ...ROW, ...row };
  database
    .prepare(
      "INSERT INTO traffic_buckets(bucket_start_ms, route, peer_kind, category, bytes_in) VALUES(?, ?, ?, ?, ?)",
    )
    .run(
      value.bucket,
      value.route,
      value.peerKind,
      value.category,
      value.bytes,
    );
}

describe("0049 traffic_buckets", () => {
  it("约束：整点、已知取值、不为负", () => {
    insert({});
    for (const bad of [
      { bucket: ROW.bucket + 1 },
      { route: "gateway" },
      { peerKind: "robot" },
      { category: "video" },
      { bytes: -1 },
    ]) {
      expect(() =>
        insert({ ...bad, bucket: bad.bucket ?? ROW.bucket + 3_600_000 }),
      ).toThrow();
    }
  });

  it("同一键 upsert 相加，维度不同分开", () => {
    const store = new TrafficStore(database);
    const row = {
      bucketStartMs: ROW.bucket,
      route: "relay" as const,
      issuer: "https://relay.test",
      peerKind: "guest" as const,
      peerId: "d",
      principalId: "p",
      linkId: "L1",
      category: "canvas" as const,
      streams: 1,
      bytesIn: 10,
      bytesOut: 20,
    };
    store.upsert([row, { ...row, linkId: "L2" }]);
    store.upsert([{ ...row, streams: 0, bytesIn: 5, bytesOut: 0 }]);
    store.upsert([{ ...row, streams: 0, bytesIn: 0, bytesOut: 0 }]);
    const rows = store.buckets({ fromMs: 0, toMs: ROW.bucket + 1 });
    expect(
      rows.map((one) => [one.linkId, one.streams, one.bytesIn, one.bytesOut]),
    ).toEqual([
      ["L1", 1, 15, 20],
      ["L2", 1, 10, 20],
    ]);
  });
});
