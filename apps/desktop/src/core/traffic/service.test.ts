import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cloudProvider } from "../identity/cloud/login";
import { type Fixture, fixture } from "../workspaces/fixture";
import { HOUR_MS, bucketStart } from "./meter";
import { TrafficService, retentionDaysOf } from "./service";

/**
 * 服务（契约 §76）：flush 的 upsert 语义、保留清理、查询合并内存行、访客解析与
 * 名字、退出前 flush。
 */

const T0 = bucketStart(1_791_700_000_000);
const DAY_MS = 86_400_000;
const ISSUER = "https://relay.test";
const ALICE = "a".repeat(32);
const GUEST = "b".repeat(32);
const ALICE_DEVICE = "c".repeat(32);
const GUEST_DEVICE = "d".repeat(32);

let core: Fixture;
let database: DatabaseSync;
let clock: { now: number };
let retention: number;
let service: TrafficService;

function seedIdentity() {
  const principal = database.prepare(
    "INSERT INTO identity_principals(principal_id, kind, display_name, created_at_ms) VALUES(?, ?, ?, 1)",
  );
  principal.run(ALICE, "owner", "Alice");
  principal.run(GUEST, "member", "Guest 7");
  const device = database.prepare(
    "INSERT INTO identity_devices(device_id, principal_id, name, role, epoch, created_at_ms) VALUES(?, ?, ?, ?, 1, 1)",
  );
  device.run(ALICE_DEVICE, ALICE, "Pixel", "owner");
  device.run(GUEST_DEVICE, GUEST, "Guest 7", "member");
  database
    .prepare(
      "INSERT INTO identity_credentials(credential_id, principal_id, kind, provider, subject, created_at_ms) VALUES(?, ?, 'oauth', ?, ?, 1)",
    )
    .run("e".repeat(32), GUEST, cloudProvider(ISSUER), "guest:L1:rnd");
}

function open(path: string, who?: { principalId: string; deviceId: string }) {
  const counter = service.meter.stream({
    route: "relay",
    issuer: ISSUER,
    kind: path.endsWith("/ws") ? "ws" : "http",
    path,
  });
  counter.identify(who);
  return counter;
}

function rowsInDb() {
  return database
    .prepare(
      "SELECT peer_kind, peer_id, link_id, category, streams, bytes_in, bytes_out FROM traffic_buckets ORDER BY category, peer_kind",
    )
    .all();
}

beforeEach(() => {
  core = fixture([]);
  database = core.db.database;
  clock = { now: T0 + 60_000 };
  retention = 180;
  seedIdentity();
  service = new TrafficService({
    database,
    now: () => clock.now,
    retentionDays: () => retention,
    timers: false,
  });
});

afterEach(() => {
  service.close();
  core.close();
});

describe("TrafficService", () => {
  it("flush 是加法：两次写同一桶等于一次写完；没有新行不碰库", () => {
    const alice = open("/api/terminals/t/ws", {
      principalId: ALICE,
      deviceId: ALICE_DEVICE,
    });
    alice.add(10, 20);
    service.flush();
    alice.add(1, 2);
    service.flush();
    service.flush();
    expect(rowsInDb()).toEqual([
      {
        peer_kind: "legacy",
        peer_id: ALICE_DEVICE,
        link_id: "",
        category: "terminal",
        streams: 1,
        bytes_in: 11,
        bytes_out: 22,
      },
    ]);
  });

  it("访客按 guest:<linkId>: 认出链接", () => {
    open("/api/workspaces/w/boards/b/sync/ws", {
      principalId: GUEST,
      deviceId: GUEST_DEVICE,
    }).add(5, 5);
    service.flush();
    expect(rowsInDb()).toEqual([
      expect.objectContaining({
        peer_kind: "guest",
        peer_id: GUEST_DEVICE,
        link_id: "L1",
        category: "canvas",
      }),
    ]);
  });

  it("summary：按对端带名字，按类别，按天（本地时区）；内存里没落库的也算", () => {
    open("/api/terminals/t/ws", {
      principalId: ALICE,
      deviceId: ALICE_DEVICE,
    }).add(100, 1000);
    service.flush();
    open("/api/media/x", { principalId: GUEST, deviceId: GUEST_DEVICE }).add(
      1,
      5000,
    );
    open("/api/identity/hello").add(7, 7);
    service.meter.wire({ route: "relay", issuer: ISSUER }, 200, 7000);
    const range = { fromMs: T0 - DAY_MS, toMs: T0 + DAY_MS };

    const byPeer = service.summary({ ...range, groupBy: "peer" });
    expect(byPeer.retentionDays).toBe(180);
    expect(
      byPeer.rows.map((row) => [row.key, row.label, row.peerKind, row.linkId]),
    ).toEqual([
      ["tunnel", "", "tunnel", ""],
      [GUEST_DEVICE, "Guest 7", "guest", "L1"],
      [ALICE_DEVICE, "Pixel · Alice", "legacy", ""],
      ["anonymous", "", "anonymous", ""],
    ]);
    expect(byPeer.rows[0]).toMatchObject({
      streams: 0,
      bytesIn: 0,
      wireBytesIn: 200,
      wireBytesOut: 7000,
    });

    const byCategory = service.summary({ ...range, groupBy: "category" });
    expect(
      Object.fromEntries(
        byCategory.rows.map((row) => [
          row.key,
          row.bytesOut + row.wireBytesOut,
        ]),
      ),
    ).toEqual({ transport: 7000, files: 5000, terminal: 1000, api: 7 });

    const byDay = service.summary({
      ...range,
      groupBy: "day",
      utcOffsetMinutes: 480,
    });
    expect(byDay.rows).toHaveLength(1);
    const day = Number(byDay.rows[0]?.key);
    expect((day + 480 * 60_000) % DAY_MS).toBe(0);
    expect(byDay.rows[0]).toMatchObject({ streams: 3, bytesOut: 6007 });

    const onePeer = service.summary({
      ...range,
      groupBy: "category",
      peerId: GUEST_DEVICE,
    });
    expect(onePeer.rows.map((row) => row.key)).toEqual(["files"]);
  });

  it("经端到端通道的对端按设备钥一行：通道线上字节与内层流合在一起，带主体", () => {
    const KEY = "f".repeat(32);
    service.meter.channelWire(
      { route: "relay", issuer: ISSUER },
      KEY,
      300,
      9_000,
    );
    const counter = service.meter.stream({
      route: "relay",
      issuer: ISSUER,
      kind: "http",
      path: "/api/workspaces",
    });
    counter.identify({
      principalId: ALICE,
      deviceId: ALICE_DEVICE,
      channelDeviceId: KEY,
    });
    counter.add(100, 8_000);
    counter.close();
    const range = { fromMs: T0, toMs: T0 + HOUR_MS };
    const rows = service
      .summary({ ...range, groupBy: "peer" })
      .rows.filter((row) => row.key === KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      peerKind: "device",
      principalId: ALICE,
      streams: 1,
      bytesIn: 100,
      bytesOut: 8_000,
      wireBytesIn: 300,
      wireBytesOut: 9_000,
    });
  });

  it("series：按小时的点，跨小时分开；按类别过滤", () => {
    const counter = open("/api/terminals/t/ws", {
      principalId: ALICE,
      deviceId: ALICE_DEVICE,
    });
    counter.add(1, 1);
    clock.now += HOUR_MS;
    counter.add(2, 2);
    service.flush();
    const series = service.series({
      fromMs: T0,
      toMs: T0 + 3 * HOUR_MS,
      bucket: "hour",
      category: "terminal",
    });
    expect(series.points).toEqual([
      expect.objectContaining({ bucketStartMs: T0, streams: 1, bytesIn: 1 }),
      expect.objectContaining({
        bucketStartMs: T0 + HOUR_MS,
        streams: 0,
        bytesIn: 2,
      }),
    ]);
    expect(
      service.series({
        fromMs: T0,
        toMs: T0 + 3 * HOUR_MS,
        bucket: "day",
        category: "files",
      }).points,
    ).toEqual([]);
  });

  it("保留：删掉保留期之前的桶，期内的留着", () => {
    const counter = open("/api/x", {
      principalId: ALICE,
      deviceId: ALICE_DEVICE,
    });
    counter.add(1, 0);
    service.flush();
    clock.now += 31 * DAY_MS;
    counter.add(2, 0);
    service.flush();
    retention = 30;
    service.prune();
    expect(rowsInDb()).toEqual([expect.objectContaining({ bytes_in: 2 })]);
  });

  it("clear 清库与内存；close 退出前把剩下的写进库", () => {
    open("/api/x", { principalId: ALICE, deviceId: ALICE_DEVICE }).add(1, 1);
    service.flush();
    service.clear();
    expect(rowsInDb()).toEqual([]);
    open("/api/x", { principalId: ALICE, deviceId: ALICE_DEVICE }).add(3, 3);
    service.close();
    expect(rowsInDb()).toEqual([expect.objectContaining({ bytes_in: 3 })]);
  });

  it("落库失败时行留在内存，下一轮再写", () => {
    open("/api/x", { principalId: ALICE, deviceId: ALICE_DEVICE }).add(4, 4);
    database.exec("ALTER TABLE traffic_buckets RENAME TO traffic_buckets_away");
    service.flush();
    expect(service.meter.pendingRows).toBe(1);
    database.exec("ALTER TABLE traffic_buckets_away RENAME TO traffic_buckets");
    service.flush();
    expect(service.meter.pendingRows).toBe(0);
    expect(rowsInDb()).toEqual([expect.objectContaining({ bytes_in: 4 })]);
  });

  it("live：开着流的对端带名字", () => {
    const counter = open("/api/ws", {
      principalId: ALICE,
      deviceId: ALICE_DEVICE,
    });
    counter.add(10, 10);
    expect(service.live().channels).toEqual([
      expect.objectContaining({
        peerId: ALICE_DEVICE,
        peerKind: "legacy",
        label: "Pixel · Alice",
        streams: 1,
        bytesIn: 10,
      }),
    ]);
    counter.close();
    expect(service.live().channels).toEqual([]);
  });
});

describe("retentionDaysOf", () => {
  it("只认取值表里的，其余回到 180", () => {
    expect(retentionDaysOf(30)).toBe(30);
    expect(retentionDaysOf(730)).toBe(730);
    for (const value of [0, 31, -1, "90", undefined, 180.5]) {
      expect(retentionDaysOf(value)).toBe(180);
    }
  });
});
