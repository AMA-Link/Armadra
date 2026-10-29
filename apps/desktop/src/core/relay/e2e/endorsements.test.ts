import type { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFreshDatabase } from "../../db/fresh.fixture";
import { tempDir } from "../../testing/temp-dir";
import {
  EndorsementStore,
  READ_RETENTION_MS,
  UNREAD_LIMIT,
} from "./endorsements";

/**
 * 背书通知的记录（契约 §81.1，迁移 0056）：名字在背书那一刻抄下；未读新的在前；标已读之后
 * 不再列；已读的过了保留期在下一次记录时清掉，未读的不清。
 */

const here = dirname(fileURLToPath(import.meta.url));
let database: DatabaseSync;
let close: () => void;
let now = 1_000;

const OWNER = "o".repeat(32);
const MEMBER = "m".repeat(32);
const DEVICE = "d".repeat(32);
const ENDORSER = "e".repeat(32);

beforeEach(() => {
  const opened = openFreshDatabase(
    join(tempDir("armadra-endorse-"), "canvas.db"),
    resolve(here, "../../db/migrations"),
  );
  database = opened.database;
  close = () => opened.close();
  now = 1_000;
  for (const [id, kind, name] of [
    [OWNER, "owner", "Owner"],
    [MEMBER, "member", "Bo"],
  ] as const)
    database
      .prepare(
        "INSERT INTO identity_principals(principal_id, kind, display_name, created_at_ms) VALUES(?, ?, ?, 1)",
      )
      .run(id, kind, name);
  const device = database.prepare(
    "INSERT INTO trusted_devices(device_id, principal_id, public_key, label, platform, status, request_id, created_at_ms) " +
      "VALUES(?, ?, ?, ?, ?, 'trusted', ?, 1)",
  );
  device.run(
    DEVICE,
    MEMBER,
    new Uint8Array(32),
    "Bo's iPhone",
    "ios",
    "1".repeat(32),
  );
  device.run(
    ENDORSER,
    OWNER,
    new Uint8Array(32),
    "Chrome",
    "browser",
    "2".repeat(32),
  );
});

afterEach(() => close());

const store = () => new EndorsementStore(database, () => now);
const endorse = (target = store()) =>
  target.record({
    deviceId: DEVICE,
    principalId: MEMBER,
    endorserDeviceId: ENDORSER,
    endorserPrincipalId: OWNER,
  });

describe("背书通知的记录", () => {
  it("名字在背书那一刻抄下：之后改名、删设备，这一行不变", () => {
    const record = endorse();
    expect(record).toMatchObject({
      deviceId: DEVICE,
      principalId: MEMBER,
      principalName: "Bo",
      deviceLabel: "Bo's iPhone",
      devicePlatform: "ios",
      endorserDeviceId: ENDORSER,
      endorserPrincipalId: OWNER,
      endorserLabel: "Chrome",
      createdAtMs: 1_000,
    });
    expect(record.id).toMatch(/^[0-9a-f]{32}$/);
    database
      .prepare(
        "UPDATE trusted_devices SET label = 'renamed' WHERE device_id = ?",
      )
      .run(DEVICE);
    database
      .prepare("DELETE FROM trusted_devices WHERE device_id = ?")
      .run(DEVICE);
    expect(store().unread()).toEqual([record]);
  });

  it("背书设备查不到：名字是空串，标识照记", () => {
    const record = store().record({
      deviceId: DEVICE,
      principalId: MEMBER,
      endorserDeviceId: "x".repeat(32),
      endorserPrincipalId: "",
    });
    expect(record.endorserLabel).toBe("");
    expect(record.endorserDeviceId).toBe("x".repeat(32));
  });

  it("未读新的在前；标已读之后不再列，重复标、不认识的 id 不算", () => {
    const first = endorse();
    now = 2_000;
    const second = endorse();
    expect(
      store()
        .unread()
        .map((row) => row.id),
    ).toEqual([second.id, first.id]);
    expect(store().markRead([first.id, first.id, "nope"])).toBe(1);
    expect(store().markRead([first.id])).toBe(0);
    expect(
      store()
        .unread()
        .map((row) => row.id),
    ).toEqual([second.id]);
  });

  it("一次最多列 UNREAD_LIMIT 条", () => {
    const target = store();
    for (let index = 0; index < UNREAD_LIMIT + 3; index += 1) endorse(target);
    expect(target.unread()).toHaveLength(UNREAD_LIMIT);
  });

  it("已读的过了保留期在下一次记录时清掉，未读的不清", () => {
    const old = endorse();
    const unread = endorse();
    store().markRead([old.id]);
    now += READ_RETENTION_MS + 1;
    endorse();
    const ids = (
      database.prepare("SELECT id FROM device_endorsements").all() as {
        id: string;
      }[]
    ).map((row) => row.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toContain(unread.id);
  });
});
