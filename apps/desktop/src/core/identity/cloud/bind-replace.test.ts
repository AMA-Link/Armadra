import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { type AddressInfo, Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { allowOrigins } from "../../http/cors";
import { installContract } from "../../http/rpc";
import { accessCookieName } from "../../gateway/admission";
import { openGateway } from "../../gateway/listener";
import { markChannelSocket } from "../../relay/e2e/peer";
import { markGatewayRequest } from "../http";
import { type Fixture, fixture } from "../../workspaces/fixture";
import { AccountsService } from "../accounts";
import { Authorizer } from "../authorize";
import { allScopes } from "../scopes";
import { IdentityService } from "../service";
import { IdentityStore } from "../store";
import {
  ISSUER,
  REGISTRATION_TOKEN,
  type FakeRelayWorld,
  fakeRelay,
  fakeRelayWorld,
  memoryBackend,
  signAssertion,
} from "./fake.fixture";
import { localRequest } from "./http";
import { type CloudService, cloudProvider, installCloud } from "./index";
import { teamRoleOf } from "./store";

/**
 * 契约 §88.5（设计 Q12）：`identity.cloud.bind` 由本机 owner 的本地会话发起时，替换云端
 * 准入免邀请自动建的成员；其余情形照旧 `409 conflict`。远程服务是 `fake.fixture.ts` 的假中继，
 * 登记行改成 `mode = saas`。
 */

const INSTANCE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://127.0.0.1:1420";

let core: Fixture;
let world: FakeRelayWorld;
let store: IdentityStore;
let service: IdentityService;
let accounts: AccountsService;
let cloud: CloudService;
let base: string;
let owner: { accessToken: string; principalId: string };
/** 置上之后，回环监听上新来的请求的连接按端到端通道标记（模拟经通道进来）。 */
let asChannel: boolean;

beforeEach(async () => {
  world = fakeRelayWorld();
  const backend = memoryBackend();
  core = fixture([
    (context) => {
      store = new IdentityStore(context.db.database);
      service = new IdentityService(store, INSTANCE);
      accounts = new AccountsService({ store });
      cloud = installCloud(context, {
        store,
        service,
        accounts,
        authorizer: new Authorizer(store),
        capabilities: () => ["identity.native-session.v1"],
        coreVersion: "0.0.0-test",
        transport: world.transport,
        secrets: () => backend,
      });
      cloud.attachRelay(fakeRelay());
    },
  ]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  asChannel = false;
  listener.on("request", (request: IncomingMessage) => {
    if (!asChannel) return;
    Object.assign(request.socket, {
      tunnel: { channel: { deviceId: "dev_channel" } },
    });
    markChannelSocket(request.socket);
  });
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const ticket = service.issueBootstrap({
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: ORIGIN,
    deviceName: "本机桌面",
    scopes: allScopes(),
  });
  const paired = service.consumeBootstrap({
    ticket: ticket.ticket,
    hostId: store.hostId(),
    instanceId: INSTANCE,
    origin: ORIGIN,
  });
  owner = {
    accessToken: paired.accessToken,
    principalId: paired.principal.principalId,
  };
});

afterEach(async () => {
  allowOrigins([]);
  await core.server.close();
  core.close();
});

interface Answer {
  status: number;
  text: string;
  body: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  options: { token?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** 经 Gateway（自签证书，只在回环上）调 `POST /api/identity/cloud/bind`。 */
function gatewayCall(
  origin: string,
  headers: Record<string, string>,
): Promise<Answer> {
  const url = new URL("/api/identity/cloud/bind", origin);
  const payload = JSON.stringify({ assertion: sub("acct:gateway") });
  return new Promise((done, failed) => {
    const client = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          done({
            status: response.statusCode ?? 0,
            text,
            body:
              text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
          });
        });
      },
    );
    client.on("error", failed);
    client.end(payload);
  });
}

async function rpc(procedure: string, input: unknown = {}): Promise<Answer> {
  const response = await fetch(
    `${base}/api/rpc/${procedure.replaceAll(".", "/")}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    },
  );
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

const asOwner = () => ({ token: owner.accessToken });

function sub(value: string) {
  return signAssertion({ aud: store.hostId(), nowMs: Date.now(), sub: value });
}

async function memberSession() {
  const invitation = accounts.issueInvitation(
    { principalId: owner.principalId, kind: "owner", scopes: allScopes() },
    { role: "viewer", targetWorkspaceId: "ws-1" },
  );
  const joined = accounts.registerWithInvitation({
    invitationId: invitation.invitationId,
    token: invitation.token,
    displayName: "Member",
    password: "correct horse battery staple",
  });
  return service.openSession({
    principalId: joined.principalId,
    hostId: store.hostId(),
    origin: ORIGIN,
    deviceName: "member",
    method: "password",
  });
}

describe("bind 替换自动成员（契约 §88.5）", () => {
  const login = (subject: string, extra: Record<string, unknown>) =>
    call("POST", "/api/identity/cloud/login", {
      assertion: signAssertion({
        aud: store.hostId(),
        nowMs: Date.now(),
        sub: subject,
        extra,
      }),
    });
  const principalOf = (answer: Answer) =>
    (answer.body.principal as { principalId: string }).principalId;

  beforeEach(async () => {
    const registered = await call(
      "POST",
      "/api/identity/cloud/register",
      { issuer: ISSUER, registrationToken: REGISTRATION_TOKEN },
      asOwner(),
    );
    expect(registered.status, registered.text).toBe(200);
    core.database
      .prepare("UPDATE cloud_registrations SET mode = 'saas' WHERE issuer = ?")
      .run(ISSUER);
  });

  it("主人先以团队成员被自动建出：owner 本地会话 bind 把映射迁到 owner，成员停用、会话吊销、授予与团队角色清掉", async () => {
    const team = { teamId: "team_1", role: "owner" };
    const first = await login("acct:boss", { team, role: "driver" });
    expect(first.status, first.text).toBe(200);
    expect(first.body.created).toBe(true);
    const auto = principalOf(first);
    const session = (first.body.session as { native: { accessToken: string } })
      .native;
    expect(teamRoleOf(core.database, auto)).toBeDefined();

    const bound = await call(
      "POST",
      "/api/identity/cloud/bind",
      { assertion: sub("acct:boss") },
      asOwner(),
    );
    expect(bound.status, bound.text).toBe(200);
    expect(bound.body).toEqual({ bound: true });

    const after = store.transaction((tx) => ({
      principal: tx.accounts.principal(auto),
      grants: tx.accounts.originGrants(auto, cloudProvider(ISSUER)),
      mapped: tx.accounts.liveOAuth(cloudProvider(ISSUER), "acct:boss"),
      sessions: tx.liveSessions(Date.now(), auto),
    }));
    expect(after.principal?.disabledAtMs).toBeGreaterThan(0);
    expect(after.grants).toEqual([]);
    expect(after.mapped?.principalId).toBe(owner.principalId);
    expect(after.sessions).toEqual([]);
    expect(teamRoleOf(core.database, auto)).toBeUndefined();
    // 自动成员的旧会话不能再用。
    const stale = await call("GET", "/api/identity/cloud", undefined, {
      token: session.accessToken,
    });
    expect(stale.status).toBe(401);
    const audit = core.database
      .prepare(
        "SELECT principal_id, detail_json FROM audit_log WHERE action = 'cloud.bind.replace'",
      )
      .all() as { principal_id: string; detail_json: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]?.principal_id).toBe(owner.principalId);
    expect(JSON.parse(audit[0]!.detail_json)).toEqual({
      iss: ISSUER,
      sub: "acct:boss",
      from: auto,
    });

    // 之后同一个账号进来就是 owner；再 bind 幂等。
    const again = await login("acct:boss", { team, role: "driver" });
    expect(again.status, again.text).toBe(200);
    expect(again.body.principal).toMatchObject({
      principalId: owner.principalId,
      kind: "owner",
    });
    const repeat = await rpc("identity.cloud.bind", {
      assertion: sub("acct:boss"),
    });
    expect(repeat.status, repeat.text).toBe(200);
  });

  it("RPC（本机壳）同样能替换", async () => {
    const first = await login("acct:rpc", {
      team: { teamId: "team_1", role: "member" },
      role: "operator",
    });
    expect(first.status, first.text).toBe(200);
    const bound = await rpc("identity.cloud.bind", {
      assertion: sub("acct:rpc"),
    });
    expect(bound.status, bound.text).toBe(200);
    expect(
      store.transaction((tx) =>
        tx.accounts.liveOAuth(cloudProvider(ISSUER), "acct:rpc"),
      )?.principalId,
    ).toBe(owner.principalId);
  });

  it("不是自动成员（经邀请或本机建的）：仍 409 conflict，映射不动", async () => {
    const member = await memberSession();
    expect(
      (
        await call(
          "POST",
          "/api/identity/cloud/bind",
          { assertion: sub("acct:local-member") },
          { token: member.accessToken },
        )
      ).status,
    ).toBe(200);
    const taken = await call(
      "POST",
      "/api/identity/cloud/bind",
      { assertion: sub("acct:local-member") },
      asOwner(),
    );
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("conflict");
    expect(
      store.transaction((tx) =>
        tx.accounts.liveOAuth(cloudProvider(ISSUER), "acct:local-member"),
      )?.principalId,
    ).toBe(member.principal.principalId);
  });

  it("不是本地会话（经通道）或发起者不是 owner：409 conflict", async () => {
    const first = await login("acct:remote", {
      team: { teamId: "team_1", role: "owner" },
      role: "driver",
    });
    expect(first.status, first.text).toBe(200);
    const auto = principalOf(first);
    await expect(
      cloud.bind(owner.principalId, sub("acct:remote"), { local: false }),
    ).rejects.toMatchObject({ code: "conflict" });
    const member = await memberSession();
    await expect(
      cloud.bind(member.principal.principalId, sub("acct:remote"), {
        local: true,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      store.transaction((tx) =>
        tx.accounts.liveOAuth(cloudProvider(ISSUER), "acct:remote"),
      )?.principalId,
    ).toBe(auto);
  });

  it("本地判定：拿不到连接、经隧道、TLS、Gateway 转交、非回环对端、绑通道设备钥的都不算本地", () => {
    const socketAt = (remoteAddress: string | undefined, proto = Socket) =>
      Object.create(proto.prototype, {
        remoteAddress: { value: remoteAddress },
        remoteFamily: {
          value:
            remoteAddress === undefined
              ? undefined
              : remoteAddress.includes(":")
                ? "IPv6"
                : "IPv4",
        },
      }) as Socket;
    const raw = (socket: unknown) => ({ socket }) as unknown as IncomingMessage;
    expect(localRequest(raw(socketAt("127.0.0.1")), "")).toBe(true);
    expect(localRequest(raw(socketAt("::ffff:127.0.0.1")), "")).toBe(true);
    expect(localRequest(raw(socketAt("::1")), "")).toBe(true);
    // unix socket（私有通道）没有对端地址。
    expect(localRequest(raw(socketAt(undefined)), "")).toBe(true);
    expect(localRequest(undefined, "")).toBe(false);
    expect(localRequest(raw(undefined), "")).toBe(false);
    expect(localRequest(raw({}), "")).toBe(false);
    expect(localRequest(raw(socketAt("192.168.1.20")), "")).toBe(false);
    expect(localRequest(raw(socketAt("127.0.0.1")), "dev_1")).toBe(false);
    expect(
      localRequest(raw(socketAt("127.0.0.1", TLSSocket as never)), ""),
    ).toBe(false);
    const forwarded = raw(socketAt("127.0.0.1"));
    markGatewayRequest(forwarded);
    expect(localRequest(forwarded, "")).toBe(false);
    const channel = Object.assign(socketAt("127.0.0.1"), {
      tunnel: { channel: { deviceId: "dev_2" } },
    });
    markChannelSocket(channel);
    expect(localRequest(raw(channel), "")).toBe(false);
  });

  it("经 Gateway 的 owner 会话（Cookie 与原生 App 的 Bearer 模式）调 bind：409，映射不动", async () => {
    const first = await login("acct:gateway", {
      team: { teamId: "team_1", role: "owner" },
      role: "driver",
    });
    expect(first.status, first.text).toBe(200);
    const auto = principalOf(first);
    const gateway = await openGateway(core, {
      listen: { host: "127.0.0.1", port: 0 },
      publicOrigins: [],
      hosts: () => ["127.0.0.1"],
      tls: { generated: "selfSigned" },
      deviceName: "test",
    });
    try {
      const origin = gateway.origin();
      const session = () => {
        const ticket = service.issueBootstrap({
          hostId: store.hostId(),
          instanceId: INSTANCE,
          origin,
          deviceName: "gateway",
          scopes: allScopes(),
        });
        return service.consumeBootstrap({
          ticket: ticket.ticket,
          hostId: store.hostId(),
          instanceId: INSTANCE,
          origin,
        });
      };
      const cookie = session();
      const viaCookie = await gatewayCall(origin, {
        origin,
        cookie: `${accessCookieName(store.hostId())}=${cookie.accessToken}`,
        "x-armadra-csrf": cookie.csrfToken,
      });
      expect(viaCookie.status, viaCookie.text).toBe(409);
      expect(viaCookie.body.code).toBe("conflict");
      const bearer = session();
      const viaBearer = await gatewayCall(origin, {
        origin: "capacitor://localhost",
        authorization: `Bearer ${bearer.accessToken}`,
      });
      expect(viaBearer.status, viaBearer.text).toBe(409);
      expect(viaBearer.body.code).toBe("conflict");
    } finally {
      await gateway.close();
    }
    expect(
      store.transaction((tx) =>
        tx.accounts.liveOAuth(cloudProvider(ISSUER), "acct:gateway"),
      )?.principalId,
    ).toBe(auto);
  });
  it("经端到端通道进来的连接：HTTP 路由与 RPC 调 bind 都是 409", async () => {
    const first = await login("acct:channel", {
      team: { teamId: "team_1", role: "owner" },
      role: "driver",
    });
    expect(first.status, first.text).toBe(200);
    const auto = principalOf(first);
    asChannel = true;
    const viaHttp = await call(
      "POST",
      "/api/identity/cloud/bind",
      { assertion: sub("acct:channel") },
      asOwner(),
    );
    expect(viaHttp.status, viaHttp.text).toBe(409);
    expect(viaHttp.body.code).toBe("conflict");
    const viaRpc = await rpc("identity.cloud.bind", {
      assertion: sub("acct:channel"),
    });
    expect(viaRpc.status, viaRpc.text).toBe(409);
    expect(
      store.transaction((tx) =>
        tx.accounts.liveOAuth(cloudProvider(ISSUER), "acct:channel"),
      )?.principalId,
    ).toBe(auto);
  });
});
