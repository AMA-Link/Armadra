import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { identityFingerprint } from "@armadra/platform-protocol/e2e";

import { signAssertion } from "../../identity/cloud/fake.fixture";
import { ISSUER, type RelayCore, relayCore, until } from "../core.fixture";
import type { FakeTunnel } from "../fake-relay.fixture";
import { E2eTestClient } from "./client.fixture";
import { e2eDevices } from "./peer";

/**
 * 端到端通道在 core 这一侧（契约 §77、§78）：握手、记录层、内层复用、设备准入与
 * 会话绑定。客户端是协议包的 `ClientHandshake` + 同一份记录层（Node 版测试客户端）。
 */

let world: RelayCore;
let tunnel: FakeTunnel;
let sourceId: string;
const WORKSPACE = "ws-e2e";

beforeEach(async () => {
  world = await relayCore();
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
  await world.register();
  tunnel = await world.relay.nextTunnel(0);
  sourceId = world.store.hostId();
  const issuer = world.cloud.registrations()[0]!.issuer;
  await until(() => world.tunnels.status(issuer).state === "ready");
});

afterEach(async () => {
  await world.close();
});

function connect(
  options: Partial<Parameters<typeof E2eTestClient.connect>[1]> = {},
) {
  return E2eTestClient.connect(tunnel, {
    sourceId,
    clientOrigin: ISSUER,
    ...options,
  });
}

async function bindOwner(sub = "acct:dev"): Promise<void> {
  const owner = world.store.transaction((tx) => tx.owner())!;
  await world.cloud.bind(
    owner.principalId,
    signAssertion({ aud: sourceId, nowMs: Date.now(), sub }),
  );
}

function login(client: E2eTestClient, sub = "acct:dev") {
  return client.request({
    method: "POST",
    path: "/api/identity/cloud/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assertion: signAssertion({ aud: sourceId, nowMs: Date.now(), sub }),
    }),
  });
}

/** 走完「待确认 → 本机核对 → 再登录」，答访问令牌。 */
async function trustedSession(client: E2eTestClient): Promise<string> {
  const first = await login(client);
  expect(first.status, first.body.toString()).toBe(403);
  const pendingId = first.json<{ details: { pendingId: string } }>().details
    .pendingId;
  e2eDevices()!.approve(pendingId, client.session.sas);
  const second = await login(client);
  expect(second.status, second.body.toString()).toBe(200);
  return second.json<{ session: { native: { accessToken: string } } }>().session
    .native.accessToken;
}

describe("握手", () => {
  it("报 e2e 能力；钉住真身份公钥能连上，accept 说设备未知（pending）", async () => {
    expect(tunnel.hello.capabilities).toContain("e2e");
    const identity = await world.cloud.identityPublicKey();
    const client = await connect({ pinned: identity });
    expect(Buffer.from(client.coreIdentity)).toEqual(Buffer.from(identity));
    expect(client.accept.deviceStatus).toBe("pending");
    expect(client.session.sas).toMatch(/^\d{6}$/);
    client.close();
  });

  it("e2e.identity 经通道答身份公钥与指纹，与握手里的一致", async () => {
    const client = await connect();
    const answer = await client.request({ path: "/api/e2e/identity" });
    expect(answer.status).toBe(200);
    const body = answer.json<{ identityPub: string; fingerprint: string }>();
    expect(Buffer.from(body.identityPub, "base64url")).toEqual(
      Buffer.from(client.coreIdentity),
    );
    expect(body.fingerprint).toBe(
      await identityFingerprint(client.coreIdentity),
    );
    client.close();
  });

  it("钉住的不是这台：core 不发 m2，外层流被重置", async () => {
    await expect(
      connect({ pinned: new Uint8Array(32).fill(9) }),
    ).rejects.toThrow();
  });
});

describe("设备准入", () => {
  it("未信任设备凭断言换不到会话：答 device_pending，事件带 pendingId", async () => {
    await bindOwner();
    const client = await connect();
    const answer = await login(client);
    expect(answer.status).toBe(403);
    const body = answer.json<{
      code: string;
      details: { pendingId: string };
    }>();
    expect(body.code).toBe("device_pending");
    expect(body.details.pendingId).toMatch(/^[0-9a-f]{32}$/);
    const listed = e2eDevices()!.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      status: "pending",
      label: "Test Browser",
      platform: "browser",
    });
    client.close();
  });

  it("校验码不对批不了；对了之后能换会话，等候立刻答 trusted", async () => {
    await bindOwner();
    const client = await connect();
    const first = await login(client);
    const pendingId = first.json<{ details: { pendingId: string } }>().details
      .pendingId;
    const waiting = client.request({
      method: "POST",
      path: "/api/e2e/wait",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pendingId }),
    });
    const wrong = client.session.sas === "000000" ? "111111" : "000000";
    expect(() => e2eDevices()!.approve(pendingId, wrong)).toThrow(
      /校验码不一致/,
    );
    e2eDevices()!.approve(pendingId, client.session.sas);
    const waited = await waiting;
    expect(waited.json()).toEqual({ status: "trusted" });
    const second = await login(client);
    expect(second.status, second.body.toString()).toBe(200);
    const token = second.json<{
      session: { native: { accessToken: string } };
    }>().session.native.accessToken;
    const listed = await client.request({
      path: "/api/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.status).toBe(200);
    client.close();
  });

  it("别的通道等不到这条记录（只认自己的设备钥）", async () => {
    await bindOwner();
    const client = await connect();
    const pendingId = (await login(client)).json<{
      details: { pendingId: string };
    }>().details.pendingId;
    const other = await connect({ seed: new Uint8Array(32).fill(3) });
    const answer = await other.request({
      method: "POST",
      path: "/api/e2e/wait",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pendingId }),
    });
    expect(answer.status).toBe(404);
    client.close();
    other.close();
  });

  it("经通道签的会话：明文路径与别的设备的通道都用不了", async () => {
    await bindOwner();
    const client = await connect();
    const token = await trustedSession(client);
    const plain = await tunnel.request({
      path: "/api/workspaces",
      headers: { origin: ISSUER, authorization: `Bearer ${token}` },
    });
    expect(plain.status, plain.body.toString()).toBe(401);
    const other = await connect({ seed: new Uint8Array(32).fill(5) });
    const foreign = await other.request({
      path: "/api/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(foreign.status).toBe(401);
    client.close();
    other.close();
  });

  it("刷新只在同一把设备钥的通道上：明文路径与别的通道都换不到新令牌", async () => {
    await bindOwner();
    const client = await connect();
    const first = await login(client);
    e2eDevices()!.approve(
      first.json<{ details: { pendingId: string } }>().details.pendingId,
      client.session.sas,
    );
    const logged = await login(client);
    const refreshToken = logged.json<{
      session: { native: { refreshToken: string } };
    }>().session.native.refreshToken;
    const refresh = (channelDeviceId: string) =>
      world.service.refresh({
        refreshToken,
        csrfToken: "",
        requireCsrf: false,
        hostId: sourceId,
        origin: ISSUER,
        channelDeviceId,
      });
    // 明文路径（空串）与别的设备钥都换不到；同一把钥换得到。
    expect(() => refresh("")).toThrow();
    expect(() => refresh("f".repeat(32))).toThrow();
    const deviceId = e2eDevices()!.list()[0]!.deviceId;
    expect(refresh(deviceId).accessToken).not.toBe("");
    client.close();
  });

  it("明文签的会话进不了通道", async () => {
    const token = world.session(ISSUER);
    const client = await connect();
    const answer = await client.request({
      path: "/api/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(answer.status).toBe(401);
    client.close();
  });

  it("拒绝之后同一把钥再来答 device_rejected，通道被断开", async () => {
    await bindOwner();
    const client = await connect();
    const pendingId = (await login(client)).json<{
      details: { pendingId: string };
    }>().details.pendingId;
    e2eDevices()!.reject(pendingId);
    await client.closedPromise;
    const again = await connect();
    expect(again.accept.deviceStatus).toBe("rejected");
    const answer = await login(again);
    expect(answer.json()).toMatchObject({ code: "device_rejected" });
    again.close();
  });

  it("撤销：吊销经它签的会话并断开通道", async () => {
    await bindOwner();
    const client = await connect();
    const token = await trustedSession(client);
    const row = e2eDevices()!.list()[0]!;
    e2eDevices()!.revoke(row.deviceId, row.principalId);
    await client.closedPromise;
    const again = await connect();
    const answer = await again.request({
      path: "/api/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(answer.status).toBe(401);
    again.close();
  });
});

describe("篡改、重放与降级", () => {
  it("改一个密文字节：通道立刻关闭", async () => {
    const client = await connect();
    const unit = await client.sealFrames([{ type: "ping", ts: 1 }]);
    unit[unit.length - 1] = (unit[unit.length - 1] as number) ^ 0x01;
    client.sendUnit(unit);
    await client.closedPromise;
    expect(client.closed).toBe(true);
  });

  it("重放一条已发过的记录：计数器对不上，通道关闭", async () => {
    const client = await connect();
    const unit = await client.sealFrames([{ type: "ping", ts: 1 }]);
    client.sendUnit(unit);
    client.sendUnit(unit);
    await client.closedPromise;
    expect(client.closed).toBe(true);
  });

  it("requireE2e 开着：明文路径一律 403 e2e_required，通道照常", async () => {
    world.requireE2e = true;
    const plain = await tunnel.request({
      path: "/api/e2e/identity",
      headers: { origin: ISSUER },
    });
    expect(plain.status).toBe(403);
    expect(plain.json()).toMatchObject({ code: "e2e_required" });
    const client = await connect();
    const answer = await client.request({ path: "/api/e2e/identity" });
    expect(answer.status).toBe(200);
    client.close();
  });
});

describe("内层复用", () => {
  it("WebSocket 经通道升级（票在通道上签、在通道上兑）", async () => {
    await bindOwner();
    const client = await connect();
    const token = await trustedSession(client);
    const ticket = await client.request({
      method: "POST",
      path: "/api/identity/ws-ticket",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ticket.status).toBe(200);
    const socket = client.websocket(`/api/workspaces/${WORKSPACE}/events`, [
      `armadra-ticket.${ticket.json<{ ticket: string }>().ticket}`,
    ]);
    await once(socket, "open");
    socket.close();
    client.close();
  });

  it("几十条并发请求共用一条通道，线上字节两端一致", async () => {
    const client = await connect();
    const answers = await Promise.all(
      Array.from({ length: 40 }, () =>
        client.request({ path: "/api/e2e/identity" }),
      ),
    );
    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    const outer = tunnel.streams.get(client.outer.streamId);
    expect(outer).toBeDefined();
    // 中继看到的外层流字节（core → 客户端）等于客户端收到的单元字节。
    await until(
      () => (tunnel.received.get(client.outer.streamId) ?? 0) === client.wireIn,
    );
    client.close();
  });
});
