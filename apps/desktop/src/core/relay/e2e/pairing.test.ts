import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signAssertion } from "../../identity/cloud/fake.fixture";
import { allScopes } from "../../identity/scopes";
import { ISSUER, type RelayCore, relayCore, until } from "../core.fixture";
import type { FakeTunnel } from "../fake-relay.fixture";
import { E2eTestClient } from "./client.fixture";
import { e2eDevices, e2ePairing, e2eShareLinks } from "./peer";

/**
 * 配对与访客（契约 §80）：扫码配对的秘密让新设备直接被信任（一次性）；访客第一次经
 * 链接加入时邀请令牌作 proof，绑到访客主体，名额按链接记录；已信任设备经通道代批记
 * 成背书；撤链接连带撤设备。
 */

let world: RelayCore;
let tunnel: FakeTunnel;
let sourceId: string;
let identityPub: Uint8Array;

beforeEach(async () => {
  world = await relayCore();
  world.core.database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "ws-1",
      "ws-1",
      world.core.directory,
      "2026-10-12T00:00:00Z",
      "2026-10-12T00:00:00Z",
    );
  await world.register();
  tunnel = await world.relay.nextTunnel(0);
  sourceId = world.store.hostId();
  const issuer = world.cloud.registrations()[0]!.issuer;
  await until(() => world.tunnels.status(issuer).state === "ready");
  identityPub = await world.cloud.identityPublicKey();
  const owner = world.store.transaction((tx) => tx.owner())!;
  await world.cloud.bind(
    owner.principalId,
    signAssertion({ aud: sourceId, nowMs: Date.now() }),
  );
});

afterEach(async () => {
  await world.close();
});

function connect(seed: number, proofSecret?: Uint8Array) {
  return E2eTestClient.connect(tunnel, {
    sourceId,
    clientOrigin: ISSUER,
    seed: new Uint8Array(32).fill(seed),
    pinned: identityPub,
    ...(proofSecret === undefined ? {} : { proofSecret }),
  });
}

function login(
  client: E2eTestClient,
  assertion: string,
  invitationToken?: string,
) {
  return client.request({
    method: "POST",
    path: "/api/identity/cloud/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assertion,
      ...(invitationToken === undefined ? {} : { invitationToken }),
    }),
  });
}

describe("扫码配对", () => {
  it("带配对秘密的新设备直接被信任；同一枚秘密不能再用", async () => {
    const issued = e2ePairing()!.issue();
    const first = await connect(11, issued.secret);
    const answer = await login(
      first,
      signAssertion({ aud: sourceId, nowMs: Date.now() }),
    );
    expect(answer.status, answer.body.toString()).toBe(200);
    expect(e2eDevices()!.list()[0]).toMatchObject({
      status: "trusted",
      approvedBy: "pairing",
    });
    const second = await connect(12, issued.secret);
    const again = await login(
      second,
      signAssertion({ aud: sourceId, nowMs: Date.now() }),
    );
    expect(again.status).toBe(403);
    expect(again.json()).toMatchObject({ code: "device_pending" });
    first.close();
    second.close();
  });

  it("e2e.pairingSecret 答二维码载荷（身份公钥、秘密、远程服务）", async () => {
    const token = world.session("http://127.0.0.1:1420");
    const answer = await fetch(`${world.base}/api/e2e/pairing-secret`, {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:1420",
        authorization: `Bearer ${token}`,
      },
    });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as {
      identityPub: string;
      secret: string;
      issuers: string[];
      uri: string;
    };
    expect(Buffer.from(body.identityPub, "base64url")).toEqual(
      Buffer.from(identityPub),
    );
    expect(Buffer.from(body.secret, "base64url")).toHaveLength(16);
    expect(body.issuers).toEqual([ISSUER]);
    expect(body.uri.startsWith("armadra://pair-e2e?d=")).toBe(true);
  });
});

describe("访客链接", () => {
  function invitation() {
    const owner = world.store.transaction((tx) => tx.owner())!;
    return world.accounts.issueInvitation(
      { principalId: owner.principalId, kind: "owner", scopes: allScopes() },
      { role: "viewer", targetWorkspaceId: "ws-1", maxUses: 5 },
    );
  }

  function guestAssertion(linkId: string, invitationId: string) {
    return signAssertion({
      aud: sourceId,
      nowMs: Date.now(),
      sub: `guest:${linkId}:${randomBytes(4).toString("hex")}`,
      extra: { name: "Guest", link: { linkId, invitationId } },
    });
  }

  it("第一次加入带邀请令牌的 proof：直接绑到访客主体；名额用完答 device_limit", async () => {
    const issued = invitation();
    e2eShareLinks()!.save({
      linkId: "lnk_1",
      issuer: ISSUER,
      invitationId: issued.invitationId,
      maxDevices: 1,
      identityFpShown: "",
      createdAtMs: Date.now(),
      revokedAtMs: 0,
    });
    const token = new TextEncoder().encode(issued.token);
    const guest = await connect(21, token);
    const answer = await login(
      guest,
      guestAssertion("lnk_1", issued.invitationId),
      issued.token,
    );
    expect(answer.status, answer.body.toString()).toBe(200);
    expect(e2eDevices()!.list()[0]).toMatchObject({
      status: "trusted",
      approvedBy: "link:lnk_1",
    });
    const another = await connect(22, token);
    const refused = await login(
      another,
      guestAssertion("lnk_1", issued.invitationId),
      issued.token,
    );
    expect(refused.status).toBe(403);
    expect(refused.json()).toMatchObject({ code: "device_limit" });
    // 撤链接：经它绑定的设备全部撤销，通道断开。
    e2eDevices()!.revokeApprovedBy("link:lnk_1");
    await guest.closedPromise;
    expect(e2eDevices()!.list()[0]!.status).toBe("revoked");
    another.close();
  });

  it("proof 对不上（拿错了令牌）：照旧待确认", async () => {
    const issued = invitation();
    const guest = await connect(
      23,
      new TextEncoder().encode("wrong-secret-of-enough-length"),
    );
    const answer = await login(
      guest,
      guestAssertion("lnk_2", issued.invitationId),
      issued.token,
    );
    expect(answer.json()).toMatchObject({ code: "device_pending" });
    guest.close();
  });
});

describe("已信任设备背书", () => {
  it("已信任设备经自己的通道代批，记成 endorse:<它的设备 id>", async () => {
    const pairing = e2ePairing()!.issue();
    const trusted = await connect(31, pairing.secret);
    const logged = await login(
      trusted,
      signAssertion({ aud: sourceId, nowMs: Date.now() }),
    );
    const token = logged.json<{
      session: { native: { accessToken: string } };
    }>().session.native.accessToken;
    const trustedId = e2eDevices()!.list()[0]!.deviceId;
    const phone = await connect(32);
    const pending = await login(
      phone,
      signAssertion({ aud: sourceId, nowMs: Date.now() }),
    );
    const pendingId = pending.json<{ details: { pendingId: string } }>().details
      .pendingId;
    const approved = await trusted.request({
      method: "POST",
      path: "/api/devices/approve",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ pendingId, sas: phone.session.sas }),
    });
    expect(approved.status, approved.body.toString()).toBe(200);
    expect(
      approved.json<{ device: { approvedBy: string } }>().device.approvedBy,
    ).toBe(`endorse:${trustedId}`);
    trusted.close();
    phone.close();
  });
});
