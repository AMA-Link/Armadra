import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ForgePullSnapshot } from "../forge/types";
import { loadMigrations } from "../db/migrations";
import {
  SNAPSHOT_STALE_MS,
  loadSnapshots,
  markSnapshotFailed,
  saveSnapshot,
  snapshotFetchedAt,
} from "./pull-snapshots";

const directory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "migrations",
);
let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  for (const migration of loadMigrations(directory))
    database.exec(migration.sql);
});
afterEach(() => database.close());

const REPO = "h/o/r";

function snap(extra: Partial<ForgePullSnapshot> = {}): ForgePullSnapshot {
  return {
    number: 7,
    url: "u",
    title: "t",
    state: "open",
    draft: false,
    baseRef: "main",
    headRef: "x",
    headSha: "a".repeat(40),
    fromFork: false,
    review: "notRequired",
    checks: {
      read: true,
      headSha: "a".repeat(40),
      rollup: "success",
      failing: [],
    },
    mergeable: "mergeable",
    parent: { kind: "none" },
    ...extra,
  };
}

describe("pull snapshots", () => {
  it("reports a changed fingerprint on first save and on a real change only", () => {
    expect(saveSnapshot(database, REPO, snap(), 1000)).toBe(true);
    expect(saveSnapshot(database, REPO, snap(), 2000)).toBe(false);
    expect(snapshotFetchedAt(database, REPO, 7)).toBe(2000);
    expect(
      saveSnapshot(database, REPO, snap({ review: "approved" }), 3000),
    ).toBe(true);
    expect(
      loadSnapshots(database, [{ repo: REPO, number: 7 }], 3000)[0]?.review,
    ).toBe("approved");
  });

  it("ignores key order when fingerprinting", () => {
    saveSnapshot(database, REPO, snap(), 1);
    const reordered = Object.fromEntries(
      Object.entries(snap()).reverse(),
    ) as unknown as ForgePullSnapshot;
    expect(saveSnapshot(database, REPO, reordered, 2)).toBe(false);
  });

  it("is stale after the window and not before", () => {
    saveSnapshot(database, REPO, snap(), 1000);
    const read = (at: number) =>
      loadSnapshots(database, [{ repo: REPO, number: 7 }], at)[0];
    expect(read(1000 + SNAPSHOT_STALE_MS)?.stale).toBe(false);
    expect(read(1001 + SNAPSHOT_STALE_MS)?.stale).toBe(true);
  });

  it("is stale after a failed refresh until the next success", () => {
    saveSnapshot(database, REPO, snap(), 1000);
    markSnapshotFailed(database, REPO, 7, 2000);
    const read = () =>
      loadSnapshots(database, [{ repo: REPO, number: 7 }], 2500)[0];
    expect(read()?.stale).toBe(true);
    saveSnapshot(database, REPO, snap(), 3000);
    expect(
      loadSnapshots(database, [{ repo: REPO, number: 7 }], 3000)[0]?.stale,
    ).toBe(false);
  });

  it("skips unknown keys, fills repo and fetchedAtMs, and failing a missing row is a no-op", () => {
    markSnapshotFailed(database, REPO, 9, 1);
    saveSnapshot(database, REPO, snap(), 1234);
    const got = loadSnapshots(
      database,
      [
        { repo: REPO, number: 9 },
        { repo: REPO, number: 7 },
      ],
      1234,
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ repo: REPO, fetchedAtMs: 1234, number: 7 });
  });
});
