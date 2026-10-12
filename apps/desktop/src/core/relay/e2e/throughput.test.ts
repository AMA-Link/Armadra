import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { signAssertion } from "../../identity/cloud/fake.fixture";
import { install as installFiles } from "../../files/routes";
import { ISSUER, type RelayCore, relayCore, until } from "../core.fixture";
import type { FakeTunnel, HttpAnswer } from "../fake-relay.fixture";
import { E2eTestClient } from "./client.fixture";
import { e2eDevices } from "./peer";

/**
 * 大文件流式与 WebSocket 小帧往返：同一台 core、同一个假中继，明文隧道路径与端到端
 * 通道各跑一遍，比较吞吐与延迟（设计 §3「性能」，§8 E2 验收）。断言只要求两条路
 * 都对（字节一致、往返都回来）；数值写进 `ARMADRA_E2E_BENCH_OUT`（给了的话）。
 */

const WORKSPACE = "ws-bench";
const FILE = "blob.bin";
const SIZE = 10 * 1024 * 1024;
const ROUNDS = 3;
const PINGS = 300;

let world: RelayCore;
let tunnel: FakeTunnel;
let client: E2eTestClient;
let sourceId: string;
let e2eToken: string;
let plainToken: string;
let digest: string;
const results: Record<string, unknown> = {};

beforeAll(async () => {
  world = await relayCore({ domains: [(context) => installFiles(context)] });
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
  const blob = randomBytes(SIZE);
  digest = createHash("sha256").update(blob).digest("hex");
  writeFileSync(join(world.core.directory, FILE), blob);
  await world.register();
  tunnel = await world.relay.nextTunnel(0);
  sourceId = world.store.hostId();
  const issuer = world.cloud.registrations()[0]!.issuer;
  await until(() => world.tunnels.status(issuer).state === "ready");
  const owner = world.store.transaction((tx) => tx.owner())!;
  await world.cloud.bind(
    owner.principalId,
    signAssertion({ aud: sourceId, nowMs: Date.now() }),
  );
  plainToken = world.session(ISSUER);
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
  e2eToken = (await login()).json<{
    session: { native: { accessToken: string } };
  }>().session.native.accessToken;
}, 60_000);

afterAll(async () => {
  client?.close();
  await world?.close();
  const out = process.env.ARMADRA_E2E_BENCH_OUT;
  if (out !== undefined && out !== "")
    writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
});

const download = `/api/workspaces/${WORKSPACE}/file-download?path=${FILE}`;

async function timed(
  run: () => Promise<HttpAnswer>,
): Promise<{ ms: number; answer: HttpAnswer }> {
  const started = performance.now();
  const answer = await run();
  return { ms: performance.now() - started, answer };
}

function mbps(ms: number): number {
  return Math.round((SIZE / 1024 / 1024 / (ms / 1000)) * 10) / 10;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return Math.round((sorted[index] as number) * 1000) / 1000;
}

async function pingRtts(socket: WebSocket): Promise<number[]> {
  const rtts: number[] = [];
  for (let index = 0; index < PINGS; index += 1) {
    const started = performance.now();
    socket.ping();
    await once(socket, "pong");
    rtts.push(performance.now() - started);
  }
  return rtts;
}

async function ticket(
  request: (input: {
    method: string;
    path: string;
    headers: Record<string, string>;
  }) => Promise<HttpAnswer>,
  token: string,
  origin: Record<string, string>,
): Promise<string> {
  const answer = await request({
    method: "POST",
    path: "/api/identity/ws-ticket",
    headers: { ...origin, authorization: `Bearer ${token}` },
  });
  expect(answer.status).toBe(200);
  return answer.json<{ ticket: string }>().ticket;
}

describe("大文件流式：明文隧道与端到端通道", () => {
  it(`${SIZE / 1024 / 1024} MB 下载两条路字节一致，记录吞吐`, async () => {
    const plain: number[] = [];
    const sealed: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const a = await timed(() =>
        tunnel.request({
          path: download,
          headers: { origin: ISSUER, authorization: `Bearer ${plainToken}` },
        }),
      );
      expect(a.answer.status).toBe(200);
      expect(createHash("sha256").update(a.answer.body).digest("hex")).toBe(
        digest,
      );
      plain.push(a.ms);
      const wireBefore = client.wireIn;
      const b = await timed(() =>
        client.request({
          path: download,
          headers: { authorization: `Bearer ${e2eToken}` },
        }),
      );
      expect(b.answer.status).toBe(200);
      expect(createHash("sha256").update(b.answer.body).digest("hex")).toBe(
        digest,
      );
      sealed.push(b.ms);
      // 线上字节只比明文多记录头与标签（每条 64 KiB 记录 20 字节）与 HTTP 头。
      const overhead = client.wireIn - wireBefore - SIZE;
      expect(overhead).toBeGreaterThan(0);
      expect(overhead).toBeLessThan(SIZE * 0.01);
      results.recordOverheadBytes = overhead;
    }
    const best = (values: number[]) => Math.min(...values);
    results.download = {
      bytes: SIZE,
      rounds: ROUNDS,
      plaintextMs: plain.map(Math.round),
      e2eMs: sealed.map(Math.round),
      plaintextMBps: mbps(best(plain)),
      e2eMBps: mbps(best(sealed)),
    };
  }, 120_000);
});

describe("WebSocket 小帧往返：明文隧道与端到端通道", () => {
  it(`${PINGS} 次 ping/pong，两条路都回来，记录延迟分位`, async () => {
    const path = `/api/workspaces/${WORKSPACE}/events`;
    const plainTicket = await ticket(
      (input) => tunnel.request(input),
      plainToken,
      { origin: ISSUER },
    );
    const plain = tunnel.websocket(path, {
      origin: ISSUER,
      protocols: [`armadra-ticket.${plainTicket}`],
    });
    await once(plain, "open");
    const sealedTicket = await ticket(
      (input) => client.request(input),
      e2eToken,
      {},
    );
    const sealed = client.websocket(path, [`armadra-ticket.${sealedTicket}`]);
    await once(sealed, "open");
    const plainRtts = await pingRtts(plain);
    const sealedRtts = await pingRtts(sealed);
    expect(plainRtts).toHaveLength(PINGS);
    expect(sealedRtts).toHaveLength(PINGS);
    results.websocket = {
      pings: PINGS,
      plaintextP50Ms: percentile(plainRtts, 50),
      plaintextP99Ms: percentile(plainRtts, 99),
      e2eP50Ms: percentile(sealedRtts, 50),
      e2eP99Ms: percentile(sealedRtts, 99),
    };
    plain.close();
    sealed.close();
  }, 120_000);
});
