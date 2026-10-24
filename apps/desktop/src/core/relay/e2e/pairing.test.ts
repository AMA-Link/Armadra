import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signAssertion } from "../../identity/cloud/fake.fixture";
import { cloudProvider } from "../../identity/cloud/store";
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

describe("团队成员背书（契约 §60.4）", () => {
  const team = (role: string, extra: Record<string, unknown> = {}) => ({
    team: { teamId: "team_1", role },
    role: "editor",
    ...extra,
  });
  const asTeam = (
    sub: string,
    role: string,
    extra: Record<string, unknown> = {},
  ) =>
    signAssertion({
      aud: sourceId,
      nowMs: Date.now(),
      sub,
      extra: team(role, extra),
    });

  beforeEach(() => {
    world.core.database
      .prepare("UPDATE cloud_registrations SET mode = 'saas'")
      .run();
  });

  /** 一台配对过的设备登录后拿到的访问令牌。 */
  async function trustedSession(
    seed: number,
    sub: string,
    role: string,
    extra: Record<string, unknown> = {},
  ) {
    const client = await connect(seed, e2ePairing()!.issue().secret);
    const logged = await login(client, asTeam(sub, role, extra));
    expect(logged.status, logged.body.toString()).toBe(200);
    const token = logged.json<{
      session: { native: { accessToken: string } };
    }>().session.native.accessToken;
    return { client, token };
  }

  /** 新设备登录停在待确认；答 pendingId 与屏幕上的校验码。 */
  async function pendingDevice(seed: number, sub: string, role: string) {
    const client = await connect(seed);
    const pending = await login(client, asTeam(sub, role));
    expect(pending.json()).toMatchObject({ code: "device_pending" });
    return {
      client,
      pendingId: pending.json<{ details: { pendingId: string } }>().details
        .pendingId,
      sas: client.session.sas,
    };
  }

  function approve(
    by: { client: E2eTestClient; token: string },
    target: { pendingId: string; sas: string },
  ) {
    return by.client.request({
      method: "POST",
      path: "/api/devices/approve",
      headers: {
        authorization: `Bearer ${by.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ pendingId: target.pendingId, sas: target.sas }),
    });
  }

  it("团队 admin 在自己已信任的设备上背书别的成员的新设备", async () => {
    const admin = await trustedSession(51, "acct:admin", "admin");
    const adminDevice = e2eDevices()!.list()[0]!.deviceId;
    const target = await pendingDevice(52, "acct:member", "member");
    const answer = await approve(admin, target);
    expect(answer.status, answer.body.toString()).toBe(200);
    expect(
      answer.json<{ device: { approvedBy: string } }>().device.approvedBy,
    ).toBe(`endorse:${adminDevice}`);
    admin.client.close();
    target.client.close();
  });

  it("成员只能背书自己的新设备，别人的 403", async () => {
    const member = await trustedSession(53, "acct:m1", "member");
    const other = await pendingDevice(54, "acct:m2", "member");
    const refused = await approve(member, other);
    expect(refused.status).toBe(403);
    const mine = await pendingDevice(55, "acct:m1", "member");
    const ok = await approve(member, mine);
    expect(ok.status, ok.body.toString()).toBe(200);
    member.client.close();
    other.client.close();
    mine.client.close();
  });

  it("guest 不能背书", async () => {
    const guest = await trustedSession(56, "acct:g", "guest");
    const target = await pendingDevice(57, "acct:g2", "member");
    expect((await approve(guest, target)).status).toBe(403);
    guest.client.close();
    target.client.close();
  });

  it("目标不在同一个团队：admin 也是 403", async () => {
    const admin = await trustedSession(58, "acct:admin2", "admin");
    const client = await connect(59);
    const pending = await login(
      client,
      signAssertion({
        aud: sourceId,
        nowMs: Date.now(),
        sub: "acct:other",
        extra: {
          team: { teamId: "team_2", role: "member" },
          role: "viewer",
        },
      }),
    );
    const target = {
      pendingId: pending.json<{ details: { pendingId: string } }>().details
        .pendingId,
      sas: client.session.sas,
    };
    expect((await approve(admin, target)).status).toBe(403);
    admin.client.close();
    client.close();
  });

  it("团队 admin 不能背书主机 owner 的设备（owner 也有团队角色时一样）", async () => {
    const admin = await trustedSession(61, "acct:admin3", "admin");
    // owner 把云账号绑到自己名下（beforeEach 的 bind），再以团队 owner 登录一台新设备。
    const client = await connect(62);
    const pending = await login(
      client,
      signAssertion({
        aud: sourceId,
        nowMs: Date.now(),
        extra: team("owner"),
      }),
    );
    const target = {
      pendingId: pending.json<{ details: { pendingId: string } }>().details
        .pendingId,
      sas: client.session.sas,
    };
    expect((await approve(admin, target)).status).toBe(403);
    admin.client.close();
    client.close();
  });

  it("目标成员已有的授予超过背书人的：403", async () => {
    const admin = await trustedSession(63, "acct:admin4", "admin");
    // admin 只有 viewer（trustedSession 默认 editor，所以这里单独降一次）。
    const adminId = e2eDevices()!.list()[0]!.principalId;
    world.core.database
      .prepare("DELETE FROM identity_grants WHERE subject_id = ?")
      .run(adminId);
    const target = await pendingDevice(64, "acct:rich", "member");
    const rich = world.core.database
      .prepare("SELECT principal_id FROM trusted_devices WHERE request_id = ?")
      .get(target.pendingId) as { principal_id: string };
    world.core.database
      .prepare(
        "INSERT INTO identity_grants (grant_id, subject_kind, subject_id, workspace_id, role, granted_by, created_at_ms) " +
          "VALUES (?, 'principal', ?, 'ws-1', 'driver', ?, 1)",
      )
      .run(
        "g".repeat(32),
        rich.principal_id,
        world.store.transaction((tx) => tx.owner())!.principalId,
      );
    expect((await approve(admin, target)).status).toBe(403);
    admin.client.close();
    target.client.close();
  });

  it("过期的团队角色、换了签发方的角色、撤销了的登记都不能背书", async () => {
    const admin = await trustedSession(65, "acct:admin5", "admin");
    const target = await pendingDevice(66, "acct:m5", "member");
    const roles = world.core.database;
    // 过期。
    roles.prepare("UPDATE cloud_team_roles SET expires_at_ms = 1").run();
    expect((await approve(admin, target)).status).toBe(403);
    roles
      .prepare("UPDATE cloud_team_roles SET expires_at_ms = ?")
      .run(Date.now() + 86_400_000);
    // 换了签发方：角色行的 provider 与待批设备的签发方不是同一个。
    roles.prepare("UPDATE cloud_team_roles SET provider = 'cloud:other'").run();
    expect((await approve(admin, target)).status).toBe(403);
    roles
      .prepare("UPDATE cloud_team_roles SET provider = ?")
      .run(cloudProvider(ISSUER));
    // 撤销了登记。
    roles.prepare("UPDATE cloud_registrations SET revoked_at_ms = 1").run();
    expect((await approve(admin, target)).status).toBe(403);
    roles.prepare("UPDATE cloud_registrations SET revoked_at_ms = 0").run();
    expect((await approve(admin, target)).status).toBe(200);
    admin.client.close();
    target.client.close();
  });

  it("新成员还没有授予时按这次断言将要同步的算：只有 ws-1 viewer 的 admin 批不了整台 editor 的新成员", async () => {
    const admin = await trustedSession(71, "acct:admin6", "admin", {
      role: "viewer",
      scp: ["ws:ws-1"],
    });
    // 新成员的断言不带 scp = 整台 editor；此时库里它还没有任何授予。
    const target = await pendingDevice(72, "acct:fresh", "member");
    expect((await approve(admin, target)).status).toBe(403);
    // 一个同样只有 ws-1 viewer 的新成员，admin 批得了。
    const client = await connect(73);
    const pending = await login(
      client,
      asTeam("acct:fresh2", "member", { role: "viewer", scp: ["ws:ws-1"] }),
    );
    const small = {
      pendingId: pending.json<{ details: { pendingId: string } }>().details
        .pendingId,
      sas: client.session.sas,
    };
    expect((await approve(admin, small)).status).toBe(200);
    admin.client.close();
    target.client.close();
    client.close();
  });
});

describe("cloud/login 的只判定模式 probe", () => {
  const sessions = () =>
    (
      world.core.database
        .prepare("SELECT COUNT(*) AS n FROM identity_sessions")
        .get() as { n: number }
    ).n;

  function probe(client: E2eTestClient) {
    return client.request({
      method: "POST",
      path: "/api/identity/cloud/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assertion: signAssertion({ aud: sourceId, nowMs: Date.now() }),
        probe: true,
      }),
    });
  }

  it("受信设备：答 trusted，不开会话", async () => {
    const trusted = await connect(41, e2ePairing()!.issue().secret);
    expect(
      (
        await login(
          trusted,
          signAssertion({ aud: sourceId, nowMs: Date.now() }),
        )
      ).status,
    ).toBe(200);
    const before = sessions();
    const answer = await probe(trusted);
    expect(answer.status, answer.body.toString()).toBe(200);
    expect(answer.json()).toEqual({ trusted: true });
    expect(sessions()).toBe(before);
    trusted.close();
  });

  it("不受信的设备：device_untrusted，不建待确认、不发事件、不开会话", async () => {
    const trusted = await connect(42, e2ePairing()!.issue().secret);
    await login(trusted, signAssertion({ aud: sourceId, nowMs: Date.now() }));
    const devices = e2eDevices()!;
    const admit = vi.spyOn(devices, "admit");
    const rows = devices.list().length;
    const before = sessions();
    const stranger = await connect(43);
    const answer = await probe(stranger);
    expect(answer.status).toBe(403);
    expect(answer.json()).toMatchObject({ code: "device_untrusted" });
    expect(admit).not.toHaveBeenCalled();
    expect(devices.list()).toHaveLength(rows);
    expect(devices.list().some((row) => row.status === "pending")).toBe(false);
    expect(sessions()).toBe(before);
    // 同一张断言没被消耗成「待确认」：之后真登录照常建待确认。
    const real = await login(
      stranger,
      signAssertion({ aud: sourceId, nowMs: Date.now() }),
    );
    expect(real.json()).toMatchObject({ code: "device_pending" });
    trusted.close();
    stranger.close();
  });

  it("不经端到端通道的 probe：bad_request", async () => {
    const answer = await fetch(`${world.base}/api/identity/cloud/login`, {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:1420",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        assertion: signAssertion({ aud: sourceId, nowMs: Date.now() }),
        probe: true,
      }),
    });
    expect(answer.status).toBe(400);
  });
});
