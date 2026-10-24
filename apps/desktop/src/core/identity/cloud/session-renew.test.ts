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

  it("SaaS 经已受信设备的续期不吃 (iss, sub) 每分钟 5 次的限流", async () => {
    await registerSaas();
    for (let round = 0; round < 8; round += 1) {
      await login("acct:d", { role: "editor" }, { channel: peer("a") });
    }
  });
});
