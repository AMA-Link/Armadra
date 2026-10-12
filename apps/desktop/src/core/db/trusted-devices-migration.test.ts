import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "./migrations";

/**
 * 迁移 0050（契约 §77）：`trusted_devices` 表，`identity_sessions.channel_device_id`
 * 列（旧会话落在空串上 = 不经通道签的）。
 */

const migrations = loadMigrations(
  join(dirname(fileURLToPath(import.meta.url)), "migrations"),
);
const VERSION = migrations.find((m) =>
  m.file.endsWith("_trusted_devices.sql"),
)!.version;

let database: DatabaseSync;

function upTo(version: number) {
  for (const migration of migrations.filter((m) => m.version <= version))
    database.exec(migration.sql);
}

function only(version: number) {
  for (const migration of migrations.filter((m) => m.version === version))
    database.exec(migration.sql);
}

const PRINCIPAL = "a".repeat(32);
const DEVICE = "b".repeat(32);
const SESSION = "c".repeat(32);
const KEY = "d".repeat(32);

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  upTo(VERSION - 1);
  database
    .prepare(
      "INSERT INTO identity_principals(principal_id, kind, display_name, created_at_ms) VALUES(?, 'owner', 'O', 1)",
    )
    .run(PRINCIPAL);
  database
    .prepare(
      "INSERT INTO identity_devices(device_id, principal_id, name, role, epoch, created_at_ms) VALUES(?, ?, 'd', 'owner', 1, 1)",
    )
    .run(DEVICE, PRINCIPAL);
  database
    .prepare(
      "INSERT INTO identity_sessions(session_id, device_id, device_epoch, origin, scopes, access_hash, refresh_hash, " +
        "csrf_hash, rotation, created_at_ms, access_expires_at_ms, expires_at_ms) VALUES(?, ?, 1, 'o', x'', ?, ?, ?, 1, 1, 2, 3)",
    )
    .run(
      SESSION,
      DEVICE,
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(32),
    );
  only(VERSION);
});

afterEach(() => database.close());

function insert(fields: Record<string, unknown> = {}) {
  const row = {
    device_id: KEY,
    principal_id: PRINCIPAL,
    public_key: new Uint8Array(32),
    status: "pending",
    request_id: "e".repeat(32),
    created_at_ms: 1,
    ...fields,
  };
  database
    .prepare(
      "INSERT INTO trusted_devices(device_id, principal_id, public_key, status, request_id, created_at_ms) VALUES(?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.device_id as string,
      row.principal_id as string,
      row.public_key as Uint8Array,
      row.status as string,
      row.request_id as string,
      row.created_at_ms as number,
    );
}

describe("迁移 0050 trusted_devices", () => {
  it("旧会话的 channel_device_id 是空串", () => {
    const row = database
      .prepare("SELECT channel_device_id FROM identity_sessions")
      .get() as { channel_device_id: string };
    expect(row.channel_device_id).toBe("");
  });

  it("设备行按 (device_id, principal_id) 唯一，request_id 全局唯一", () => {
    insert();
    expect(() => insert({ request_id: "f".repeat(32) })).toThrow();
    expect(() => insert({ device_id: "1".repeat(32) })).toThrow();
  });

  it("状态只认四种，公钥必须 32 字节，主体必须存在", () => {
    expect(() => insert({ status: "maybe" })).toThrow();
    expect(() => insert({ public_key: new Uint8Array(31) })).toThrow();
    expect(() => insert({ principal_id: "9".repeat(32) })).toThrow();
  });

  it("会话的通道设备 id 要么空要么 32 位", () => {
    expect(() =>
      database
        .prepare("UPDATE identity_sessions SET channel_device_id = 'x'")
        .run(),
    ).toThrow();
    database
      .prepare("UPDATE identity_sessions SET channel_device_id = ?")
      .run(KEY);
  });
});
