import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signAssertion } from "../../identity/cloud/fake.fixture";
import { install as installFiles } from "../../files/routes";
import type { TrafficBucketRow } from "../../traffic/meter";
import { ISSUER, type RelayCore, relayCore, until } from "../core.fixture";
import type { FakeTunnel } from "../fake-relay.fixture";
import { E2eTestClient } from "./client.fixture";
import { e2eDevices } from "./peer";

/**
 * 流量对账（设计 §6、S5）：一组请求经端到端通道跑完——HTTP、WebSocket 1000 帧、
 * 10 MB 下载——core 记到对端设备那一行 `transport` 的字节，与中继看到的这条外层流
 * 的密文字节逐字节相等（±0）；内层流按类别记明文，对端是同一把设备钥；端到端外层
 * 流的密文不再计进隧道那一行。
 */

const WORKSPACE = "ws-reconcile";
const FILE = "blob.bin";
const SIZE = 10 * 1024 * 1024;
const FRAMES = 1000;

let world: RelayCore;
let tunnel: FakeTunnel;
let client: E2eTestClient;
let token: string;
let deviceId: string;

beforeAll(async () => {
  world = await relayCore({
    traffic: true,
    domains: [(context) => installFiles(context)],
  });
  world.core.database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      WORKSPACE,
      WORKSPACE,
      world.core.directory,
      "2026-10-12T00:00:00Z",
      "2026-10-12T00:00:00Z",
    );
  writeFileSync(join(world.core.directory, FILE), randomBytes(SIZE));
  await world.register();
  tunnel = await world.relay.nextTunnel(0);
  const sourceId = world.store.hostId();
  const issuer = world.cloud.registrations()[0]!.issuer;
  await until(() => world.tunnels.status(issuer).state === "ready");
  const owner = world.store.transaction((tx) => tx.owner())!;
  await world.cloud.bind(
    owner.principalId,
    signAssertion({ aud: sourceId, nowMs: Date.now() }),
  );
  client = await E2eTestClient.connect(tunnel, {
    sourceId,
    clientOrigin: ISSUER,
  });
  const login = () =>
    client.request({
      method: "POST",
      path: "/api/identity/cloud/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assertion: signAssertion({ aud: sourceId, nowMs: Date.now() }),
      }),
    });
  const first = await login();
  e2eDevices()!.approve(
    first.json<{ details: { pendingId: string } }>().details.pendingId,
    client.session.sas,
  );
  token = (await login()).json<{
    session: { native: { accessToken: string } };
  }>().session.native.accessToken;
  deviceId = e2eDevices()!.list()[0]!.deviceId;
}, 60_000);

afterAll(async () => {
  client?.close();
  await world?.close();
});

function rows(): TrafficBucketRow[] {
  return world.traffic!.meter.snapshot();
}

function sum(filter: (row: TrafficBucketRow) => boolean): {
  bytesIn: number;
  bytesOut: number;
  streams: number;
} {
  return rows()
    .filter(filter)
    .reduce(
      (total, row) => ({
        bytesIn: total.bytesIn + row.bytesIn,
        bytesOut: total.bytesOut + row.bytesOut,
        streams: total.streams + row.streams,
      }),
      { bytesIn: 0, bytesOut: 0, streams: 0 },
    );
}

/** 中继看到的这条外层流：到源的是客户端写的单元，到客户端的是源写的 DATA。 */
async function settled(): Promise<{ toSource: number; toClient: number }> {
  const outerId = client.outer.streamId;
  let last = -1;
  // 等在途的单元落地：两边计数连续两次不变。
  await until(() => {
    const now = (tunnel.received.get(outerId) ?? 0) + client.wireOut;
    const still = now === last;
    last = now;
    return still;
  }, 10_000);
  return {
    toSource: client.wireOut,
    toClient: tunnel.received.get(outerId) ?? 0,
  };
}

const results: Record<string, unknown> = {};

afterAll(() => {
  const out = process.env.ARMADRA_E2E_RECONCILE_OUT;
  if (out !== undefined && out !== "")
    writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
});

/** core 记到这把设备钥那一行 `transport` 的字节（本机视角）。 */
function coreWire(): { bytesIn: number; bytesOut: number } {
  return sum(
    (row) =>
      row.category === "transport" &&
      row.peerKind === "device" &&
      row.peerId === deviceId,
  );
}

/** 跑一组请求，对一次：这一组让两端各涨了多少，差值是多少。 */
async function phase(name: string, run: () => Promise<void>): Promise<void> {
  const relayBefore = await settled();
  const coreBefore = coreWire();
  await run();
  const relayAfter = await settled();
  const coreAfter = coreWire();
  const relay = {
    toSource: relayAfter.toSource - relayBefore.toSource,
    toClient: relayAfter.toClient - relayBefore.toClient,
  };
  const core = {
    bytesIn: coreAfter.bytesIn - coreBefore.bytesIn,
    bytesOut: coreAfter.bytesOut - coreBefore.bytesOut,
  };
  results[name] = {
    relayToSource: relay.toSource,
    coreBytesIn: core.bytesIn,
    relayToClient: relay.toClient,
    coreBytesOut: core.bytesOut,
    diffIn: core.bytesIn - relay.toSource,
    diffOut: core.bytesOut - relay.toClient,
  };
  // 本机视角：bytesIn = 对端 → 本机（中继送到源的），bytesOut = 本机 → 对端。
  expect(core.bytesIn).toBe(relay.toSource);
  expect(core.bytesOut).toBe(relay.toClient);
}

describe("流量对账：core 的 transport 与中继的 e2e 字节", () => {
  it("HTTP、WS 1000 帧、10 MB 下载：每一组两端逐字节相等", async () => {
    const auth = { authorization: `Bearer ${token}` };
    await phase("http", async () => {
      for (let index = 0; index < 20; index += 1) {
        const answer = await client.request({
          path: "/api/workspaces",
          headers: auth,
        });
        expect(answer.status).toBe(200);
      }
    });

    await phase("ws", async () => {
      const ticket = (
        await client.request({
          method: "POST",
          path: "/api/identity/ws-ticket",
          headers: auth,
        })
      ).json<{ ticket: string }>().ticket;
      const socket = client.websocket(`/api/workspaces/${WORKSPACE}/events`, [
        `armadra-ticket.${ticket}`,
      ]);
      await once(socket, "open");
      for (let index = 0; index < FRAMES; index += 1) {
        socket.ping(Buffer.alloc(16, index & 0xff));
        await once(socket, "pong");
      }
      socket.close();
      await once(socket, "close");
    });

    await phase("download", async () => {
      const download = await client.request({
        path: `/api/workspaces/${WORKSPACE}/file-download?path=${FILE}`,
        headers: auth,
      });
      expect(download.status).toBe(200);
      expect(download.body.length).toBe(SIZE);
    });

    const core = coreWire();
    // 内层流按类别记明文，对端是同一把设备钥；下载那一条至少 10 MB。
    const files = sum(
      (row) =>
        row.category === "files" &&
        row.peerKind === "device" &&
        row.peerId === deviceId,
    );
    expect(files.bytesOut).toBeGreaterThanOrEqual(SIZE);
    expect(files.streams).toBeGreaterThanOrEqual(1);
    const plaintext = sum(
      (row) =>
        row.category !== "transport" &&
        row.peerKind === "device" &&
        row.peerId === deviceId,
    );
    // 密文只比明文多记录头、标签与握手（每条 64 KiB 记录 20 字节）。
    const overhead = core.bytesOut - plaintext.bytesOut;
    expect(overhead).toBeGreaterThan(0);
    expect(overhead).toBeLessThan(SIZE * 0.01);
    results.plaintextBytesOut = plaintext.bytesOut;
    results.recordOverheadOut = overhead;

    // 隧道那一行只剩帧头与控制帧：端到端外层流的密文不再计两遍。
    const tunnelRow = sum(
      (row) => row.category === "transport" && row.peerKind === "tunnel",
    );
    results.tunnelRow = tunnelRow;
    expect(tunnelRow.bytesOut).toBeLessThan(core.bytesOut);
  }, 120_000);
});
