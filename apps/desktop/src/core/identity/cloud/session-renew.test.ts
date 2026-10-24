import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Fixture, fixture } from "../../workspaces/fixture";
import { type ChannelPeer, setE2eDevices } from "../../relay/e2e/peer";
import type { DeviceRegistry } from "../../relay/e2e/devices";
import { AccountsService } from "../accounts";
import { Authorizer } from "../authorize";
import { allScopes } from "../scopes";
import { IdentityService } from "../service";
import { IdentityStore } from "../store";
import {
  ISSUER,
  REGISTRATION_TOKEN,
  fakeRelay,
  fakeRelayWorld,
  memoryBackend,
  signAssertion,
} from "./fake.fixture";
import { type CloudService, installCloud } from "./index";

/**
 * SaaS 来源会话限寿（#484）里 `cloud/login` 这一层：经已受信设备通道、带当前刷新令牌重登 =
 * 在同一会话上续期并整份换授予；设备行不堆积；续期不吃 `(iss, sub)` 的限流；别的通道钥或
 * 伪造的刷新令牌只会新建会话。
 */

const INSTANCE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://127.0.0.1:1420";

let core: Fixture;
let store: IdentityStore;
let service: IdentityService;
let cloud: CloudService;

const peer = (id: string): ChannelPeer =>
  ({
    deviceId: id.repeat(32).slice(0, 32),
    publicKey: new Uint8Array(32),
    label: "浏览器",
    platform: "browser",
    sas: "123456",
  }) as ChannelPeer;

beforeEach(async () => {
  const world = fakeRelayWorld();
  const relay = fakeRelay();
  const backend = memoryBackend();
  core = fixture([
    (context) => {
      store = new IdentityStore(context.db.database);
      service = new IdentityService(store, INSTANCE);
      cloud = installCloud(context, {
        store,
        service,
        accounts: new AccountsService({ store }),
        authorizer: new Authorizer(store),
        capabilities: () => ["identity.native-session.v1"],
        coreVersion: "0.0.0-test",
        transport: world.transport,
        secrets: () => backend,
      });
      cloud.attachRelay(relay);
    },
  ]);
  const ticket = service.issueBootstrap({
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: ORIGIN,
    deviceName: "本机桌面",
    scopes: allScopes(),
  });
  service.consumeBootstrap({
    ticket: ticket.ticket,
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: ORIGIN,
  });
  // 设备登记：这一组只关心 cloud/login，设备一律已信任。
  setE2eDevices({
    trusted: () => true,
    admit: () => ({ status: "trusted" }),
  } as unknown as DeviceRegistry);
});

afterEach(async () => {
  setE2eDevices(undefined);
  await core.server.close();
  core.close();
});

async function registerSaas(): Promise<void> {
  const owner = store.transaction((tx) => tx.owner());
  await cloud.register(
    { issuer: ISSUER, registrationToken: REGISTRATION_TOKEN, label: "laptop" },
    owner?.principalId,
  );
  core.database
    .prepare("UPDATE cloud_registrations SET mode = 'saas' WHERE issuer = ?")
    .run(ISSUER);
}

const TEAM = { teamId: "team_1", role: "member" };

async function login(
  subject: string,
  extra: Record<string, unknown>,
  options: { channel?: ChannelPeer; refreshToken?: string } = {},
) {
  return cloud.login({
    assertion: signAssertion({
      aud: store.hostId(),
      nowMs: Date.now(),
      sub: subject,
      extra: { team: TEAM, ...extra },
    }),
    origin: ORIGIN,
    remoteIp: "127.0.0.1",
    userAgent: "test",
    channel: options.channel,
    refreshToken: options.refreshToken,
  });
}

const grants = (principalId: string) =>
  store
    .transaction((tx) => tx.accounts.grantsFor(principalId, Date.now()))
    .map((g) => [g.targetKind, g.workspaceId, g.role]);

const deviceCount = () =>
  (
    core.database
      .prepare("SELECT COUNT(*) AS n FROM identity_devices")
      .get() as { n: number }
  ).n;

describe("带当前刷新令牌重登（#484）", () => {
  it("同一会话续期：会话 id 不变、寿命延长、授予整份换成缩小后的、设备行不增", async () => {
    await registerSaas();
    const first = await login(
      "acct:a",
      { role: "editor" },
      { channel: peer("a") },
    );
    const sessionId = first.credentials.principal.sessionId;
    const devices = deviceCount();
    const second = await login(
      "acct:a",
      { role: "editor", scp: ["ws:ws-1", "ro"] },
      { channel: peer("a"), refreshToken: first.credentials.refreshToken },
    );
    expect(second.credentials.principal.sessionId).toBe(sessionId);
    expect(second.credentials.refreshToken).not.toBe(
      first.credentials.refreshToken,
    );
    expect(second.credentials.expiresAtMs).toBeGreaterThanOrEqual(
      first.credentials.expiresAtMs,
    );
    expect(grants(second.principal.principalId)).toEqual([
      ["workspace", "ws-1", "viewer"],
    ]);
    expect(deviceCount()).toBe(devices);
  });

  it("不带令牌的重登新建会话但复用设备；别的通道钥或伪造令牌也只是新会话，不续别人的", async () => {
    await registerSaas();
    const first = await login(
      "acct:b",
      { role: "editor" },
      { channel: peer("a") },
    );
    const devices = deviceCount();
    const plain = await login(
      "acct:b",
      { role: "editor" },
      { channel: peer("a") },
    );
    expect(plain.credentials.principal.sessionId).not.toBe(
      first.credentials.principal.sessionId,
    );
    expect(plain.credentials.principal.deviceId).toBe(
      first.credentials.principal.deviceId,
    );
    expect(deviceCount()).toBe(devices);
    const other = await login(
      "acct:b",
      { role: "editor" },
      { channel: peer("b"), refreshToken: first.credentials.refreshToken },
    );
    expect(other.credentials.principal.sessionId).not.toBe(
      first.credentials.principal.sessionId,
    );
    const forged = await login(
      "acct:b",
      { role: "editor" },
      {
        channel: peer("a"),
        refreshToken: `${first.credentials.principal.sessionId}.forged`,
      },
    );
    expect(forged.credentials.principal.sessionId).not.toBe(
      first.credentials.principal.sessionId,
    );
    // 别人的账号拿着这枚令牌也续不了。
    const stranger = await login(
      "acct:c",
      { role: "editor" },
      { channel: peer("a"), refreshToken: first.credentials.refreshToken },
    );
    expect(stranger.credentials.principal.sessionId).not.toBe(
      first.credentials.principal.sessionId,
    );
  });

  /** 把这条会话的到期时间改成「还剩 remainingMs」，模拟客户端在到期前才来续。 */
  const nearExpiry = (sessionId: string, remainingMs: number) =>
    core.database
      .prepare(
        "UPDATE identity_sessions SET expires_at_ms = ?, access_expires_at_ms = MIN(access_expires_at_ms, ?) WHERE session_id = ?",
      )
      .run(Date.now() + remainingMs, Date.now() + remainingMs, sessionId);

  it("临近到期（客户端约 60 秒前）的续期不吃 (iss, sub) 每分钟 5 次的限流；新建会话照常扣", async () => {
    await registerSaas();
    let current = await login(
      "acct:d",
      { role: "editor" },
      { channel: peer("a") },
    );
    for (let round = 0; round < 8; round += 1) {
      nearExpiry(current.credentials.principal.sessionId, 90_000);
      current = await login(
        "acct:d",
        { role: "editor" },
        { channel: peer("a"), refreshToken: current.credentials.refreshToken },
      );
    }
    // 上面第一次登录扣了 1 次，续期都退还：再新建 4 次会话，第 5 次起被限。
    for (let round = 0; round < 4; round += 1)
      await login("acct:d", { role: "editor" }, { channel: peer("a") });
    await expect(
      login("acct:d", { role: "editor" }, { channel: peer("a") }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("提前很久就续的不退还：同一 sub 的续期也有速率上限（#563）", async () => {
    await registerSaas();
    let current = await login(
      "acct:g",
      { role: "editor" },
      { channel: peer("a") },
    );
    const codes: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      // 刚开会话就续，剩余寿命远大于退还窗口。
      codes.push(
        await login(
          "acct:g",
          { role: "editor" },
          {
            channel: peer("a"),
            refreshToken: current.credentials.refreshToken,
          },
        ).then(
          (next) => {
            current = next;
            return "ok";
          },
          (error: { code: string }) => error.code,
        ),
      );
    }
    // 第一次登录扣 1 次，之后每次续期照扣：再成功 4 次，第 5 次起被限。
    expect(codes).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "rate_limited",
      "rate_limited",
    ]);
  });

  it("并发突发绕不过限流：同一 sub 同时 8 次新建会话，恰好 5 次成功", async () => {
    await registerSaas();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        login("acct:e", { role: "editor" }, { channel: peer("a") }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(
      results.filter(
        (r) =>
          r.status === "rejected" &&
          (r.reason as { code?: string }).code === "rate_limited",
      ),
    ).toHaveLength(3);
  });

  it("device_pending 也扣：同一 sub 以新设备钥连登，第 6 次答 rate_limited", async () => {
    await registerSaas();
    await login("acct:f", { role: "editor" }, { channel: peer("a") });
    setE2eDevices({
      trusted: () => false,
      admit: () => ({ status: "pending", requestId: "r".repeat(32) }),
    } as unknown as DeviceRegistry);
    const codes: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      codes.push(
        await login(
          "acct:f",
          { role: "editor" },
          { channel: peer(String(round + 1)) },
        ).then(
          () => "ok",
          (error: { code: string }) => error.code,
        ),
      );
    }
    expect(codes).toEqual([
      "device_pending",
      "device_pending",
      "device_pending",
      "device_pending",
      "rate_limited",
    ]);
  });
});
