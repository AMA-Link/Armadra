import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFreshDatabase } from "../db/fresh.fixture";
import type { OpenedDatabase } from "../db/open";
import { CoreFailure } from "../http/errors";
import { tempDir } from "../testing/temp-dir";
import { migrationsDir } from "../workspaces/fixture";
import {
  ACCOUNT,
  ISSUER,
  PASSWORD,
  RELAY_FP,
  type FakeWorld,
  fakeWorld,
  memoryBackend,
  plainSealed,
} from "./fake.fixture";
import { RemoteClient } from "./remote-client";
import { SourceSecrets } from "./secrets";
import { SourcesService } from "./service";
import { SourceClient } from "./source-client";
import { SourcesStore } from "./store";

/**
 * Armadra 云控制台的触点（契约 §33.12）：授予、邀请与待信任设备，对着假的 Armadra 云
 * （`fake.fixture.ts` 的 `world.cloud.console`）。登录与登记沿用 §33.11 的流程。
 */

const HOST_ID = "f".repeat(32);

function code(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof CoreFailure ? error.code : String(error),
  );
}

describe("Armadra 云控制台触点（契约 §33.12）", () => {
  let opened: OpenedDatabase;
  let world: FakeWorld;
  let clock: number;
  let saas: SourcesService;

  beforeEach(() => {
    opened = openFreshDatabase(
      join(tempDir("armadra-console-"), "canvas.db"),
      migrationsDir(),
    );
    world = fakeWorld();
    world.cloud.mode = "saas";
    // 云端用系统信任，不钉指纹。
    world.fingerprints.delete(ISSUER);
    clock = Date.now();
    const registered = new Set<string>();
    saas = new SourcesService({
      store: new SourcesStore(opened.database),
      secrets: new SourceSecrets(() => memoryBackend()),
      remote: new RemoteClient(world.transport, {
        platform: "desktop",
        name: "test",
      }),
      peer: new SourceClient(world.transport, plainSealed(world.transport)),
      hostId: () => HOST_ID,
      hostLabel: () => "this-mac",
      log: { info: () => undefined, warn: () => undefined },
      now: () => clock,
      cloud: () => ({
        registered: (issuer) => registered.has(issuer),
        revoke: async () => ({}),
        register: async (input) => {
          registered.add(input.issuer);
          return { sourceId: HOST_ID };
        },
        bind: async () => ({ bound: true }),
        sourceId: async () => HOST_ID,
      }),
    });
  });

  afterEach(() => {
    opened.close();
  });

  async function signedIn() {
    const { remote } = await saas.remoteAdd({ kind: "saas", issuer: ISSUER });
    world.cloud.device.status = "approved";
    clock += 6_000;
    await saas.remoteDevicePoll(remote.serviceId);
    return remote.serviceId;
  }

  async function addRemote() {
    return saas.remoteAdd({
      kind: "personal",
      issuer: ISSUER,
      account: ACCOUNT,
      password: PASSWORD,
      fingerprint: RELAY_FP,
    });
  }

  async function registered() {
    const serviceId = await signedIn();
    await saas.remoteRegister({ serviceId, space: { kind: "personal" } });
    return serviceId;
  }

  it("没登记到这个云：conflict；个人中转：not_implemented", async () => {
    const serviceId = await signedIn();
    expect(await code(saas.console.access(serviceId))).toBe("conflict");
    expect(await code(saas.console.grantRevoke("0".repeat(32), "g1"))).toBe(
      "not_found",
    );
  });

  it("access：主机空间、成员只留可授予的角色、授予不含撤销的", async () => {
    const serviceId = await registered();
    const state = world.cloud.console;
    state.allowGuests = false;
    state.members = [
      { accountId: "a1", email: "a@x.test", displayName: "A", role: "owner" },
      {
        accountId: "a2",
        email: "b@x.test",
        displayName: "B",
        role: "member",
      },
      { accountId: "a3", email: null, displayName: "C", role: "guest" },
      {
        accountId: "a4",
        email: "d@x.test",
        displayName: "D",
        role: "billing",
      },
    ];
    state.grants = [
      {
        grantId: "g1",
        subject: { kind: "member", accountId: "a2" },
        role: "editor",
        workspaceIds: ["w1"],
        expiresAtMs: null,
        revokedAtMs: null,
      },
      {
        grantId: "g2",
        subject: { kind: "member", accountId: "a3" },
        role: "viewer",
        workspaceIds: [],
        expiresAtMs: 5,
        revokedAtMs: 7,
      },
    ];
    const answer = await saas.console.access(serviceId);
    expect(answer).toEqual({
      sourceId: HOST_ID,
      space: { kind: "team", teamId: "t1" },
      allowGuests: false,
      canManage: true,
      members: [
        {
          accountId: "a2",
          email: "b@x.test",
          displayName: "B",
          role: "member",
        },
        { accountId: "a3", email: "", displayName: "C", role: "guest" },
      ],
      grants: [
        {
          grantId: "g1",
          subject: { kind: "member", accountId: "a2" },
          role: "editor",
          workspaceIds: ["w1"],
          expiresAtMs: null,
        },
      ],
    });
  });

  it("access：不是主机 owner / 团队 admin 时 canManage = false，不报错", async () => {
    const serviceId = await registered();
    world.cloud.console.refusal = {
      status: 403,
      code: "team_role_insufficient",
      path: "/v1/grants",
    };
    const answer = await saas.console.access(serviceId);
    expect(answer).toMatchObject({
      canManage: false,
      members: [],
      grants: [],
    });
    world.cloud.console.refusal = {
      status: 403,
      code: "guests_disabled",
      path: "/v1/grants",
    };
    expect(await code(saas.console.access(serviceId))).toBe("guests_disabled");
  });

  it("grantCreate：目标主机是本机，参数原样交给云端，答案不含令牌", async () => {
    const serviceId = await registered();
    const made = await saas.console.grantCreate({
      serviceId,
      subject: { kind: "member", accountId: "a2" },
      role: "viewer",
      workspaceIds: ["w1"],
      expiresAtMs: 123,
    });
    expect(made.grant).toMatchObject({
      role: "viewer",
      workspaceIds: ["w1"],
      expiresAtMs: 123,
      subject: { kind: "member", accountId: "a2" },
    });
    const sent = world.requests.find(
      (one) => one.method === "POST" && one.url.endsWith("/v1/grants"),
    );
    expect(sent?.body).toMatchObject({ sourceId: HOST_ID, role: "viewer" });
    expect(JSON.stringify(made)).not.toContain("cloud-access");
  });

  it("授予与邀请的拒绝按码透传", async () => {
    const serviceId = await registered();
    const refuse = (status: number, codeName: string) => {
      world.cloud.console.refusal = { status, code: codeName };
    };
    const grant = () =>
      saas.console.grantCreate({
        serviceId,
        subject: { kind: "guest", accountId: "a9" },
        role: "viewer",
        workspaceIds: [],
      });
    refuse(403, "guests_disabled");
    expect(await code(grant())).toBe("guests_disabled");
    refuse(409, "conflict");
    expect(await code(grant())).toBe("conflict");
    refuse(403, "team_role_insufficient");
    expect(await code(grant())).toBe("team_role_insufficient");
    refuse(403, "email_unverified");
    expect(await code(grant())).toBe("email_unverified");
    refuse(409, "member_exists");
    expect(
      await code(
        saas.console.invite({
          serviceId,
          email: "a@x.test",
          role: "viewer",
          workspaceIds: ["w1"],
        }),
      ),
    ).toBe("member_exists");
    world.cloud.console.refusal = {
      status: 429,
      code: "limit_reached",
      details: { quota: "guests", used: 3, limit: 3 },
    };
    expect(
      await code(
        saas.console.invite({
          serviceId,
          email: "a@x.test",
          role: "viewer",
          workspaceIds: ["w1"],
        }),
      ),
    ).toBe("limit_reached");
  });

  it("invite：邮箱不像样不发；发出的是 host 邀请，带范围与授予到期", async () => {
    const serviceId = await registered();
    expect(
      await code(
        saas.console.invite({
          serviceId,
          email: "nope",
          role: "viewer",
          workspaceIds: [],
        }),
      ),
    ).toBe("bad_request");
    const done = await saas.console.invite({
      serviceId,
      email: " new@x.test ",
      role: "editor",
      workspaceIds: ["w1"],
      expiresAtMs: 99,
    });
    expect(done.invitation.email).toBe("new@x.test");
    expect(world.cloud.console.invitations[0]).toMatchObject({
      kind: "host",
      sourceId: HOST_ID,
      hostRole: "editor",
      workspaceIds: ["w1"],
    });
  });

  it("grantUpdate / grantRevoke", async () => {
    const serviceId = await registered();
    const { grant } = await saas.console.grantCreate({
      serviceId,
      subject: { kind: "member", accountId: "a2" },
      role: "viewer",
      workspaceIds: [],
    });
    const updated = await saas.console.grantUpdate({
      serviceId,
      grantId: grant.grantId,
      role: "operator",
    });
    expect(updated.grant.role).toBe("operator");
    // 范围与到期给了才改，null 是不过期。
    const scoped = await saas.console.grantUpdate({
      serviceId,
      grantId: grant.grantId,
      role: "editor",
      workspaceIds: ["w9"],
      expiresAtMs: null,
    });
    expect(scoped.grant).toMatchObject({
      role: "editor",
      workspaceIds: ["w9"],
      expiresAtMs: null,
    });
    expect(
      world.requests.filter((one) => one.method === "PATCH").at(-1)?.body,
    ).toEqual({ role: "editor", workspaceIds: ["w9"], expiresAtMs: null });
    // 对已经有授予的人再新建：云端答 conflict，不合成。
    expect(
      await code(
        saas.console.grantCreate({
          serviceId,
          subject: { kind: "member", accountId: "a2" },
          role: "viewer",
          workspaceIds: [],
        }),
      ),
    ).toBe("conflict");
    await saas.console.grantRevoke(serviceId, grant.grantId);
    expect(world.cloud.console.grants).toEqual([]);
    expect(await code(saas.console.grantRevoke(serviceId, grant.grantId))).toBe(
      "not_found",
    );
  });

  it("待信任：列出的请求不含校验码；拒绝只告诉云端 requestId", async () => {
    const serviceId = await signedIn();
    world.cloud.console.trust = [
      {
        requestId: "r1",
        sourceId: HOST_ID,
        sourceName: "build-01",
        teamId: "t1",
        member: { accountId: "a2", email: "b@x.test", displayName: "B" },
        device: { name: "iPhone", platform: "ios" },
        requestedAtMs: 1,
        expiresAtMs: 2,
        sas: "123456",
      },
    ];
    const listed = await saas.console.trustList(serviceId);
    expect(listed.requests).toEqual([
      {
        requestId: "r1",
        sourceId: HOST_ID,
        sourceName: "build-01",
        teamId: "t1",
        member: { accountId: "a2", email: "b@x.test", displayName: "B" },
        device: { name: "iPhone", platform: "ios" },
        requestedAtMs: 1,
        expiresAtMs: 2,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("123456");
    await saas.console.trustReject(serviceId, "r1");
    expect(world.cloud.console.rejected).toEqual(["r1"]);
    world.cloud.console.refusal = { status: 409, code: "conflict" };
    expect(await code(saas.console.trustReject(serviceId, "r2"))).toBe(
      "conflict",
    );
  });

  it("待信任：云端带 pendingId 就原样交出，没带就没有这一项", async () => {
    const serviceId = await signedIn();
    const row = (requestId: string, extra: object) => ({
      requestId,
      sourceId: HOST_ID,
      sourceName: "build-01",
      teamId: "t1",
      member: { accountId: "a2", email: "b@x.test", displayName: "B" },
      device: { name: "iPhone", platform: "ios" },
      requestedAtMs: 1,
      expiresAtMs: 2,
      ...extra,
    });
    world.cloud.console.trust = [
      row("r1", { pendingId: "pend-1" }),
      row("r2", {}),
      row("r3", { pendingId: "" }),
    ];
    const listed = await saas.console.trustList(serviceId);
    expect(listed.requests.map((one) => one.pendingId)).toEqual([
      "pend-1",
      undefined,
      undefined,
    ]);
    expect("pendingId" in listed.requests[1]!).toBe(false);
  });

  it("个人中转没有控制台触点", async () => {
    world.cloud.mode = "personal";
    world.fingerprints.set(ISSUER, RELAY_FP);
    const { remote } = await addRemote();
    expect(await code(saas.console.access(remote.serviceId))).toBe(
      "not_implemented",
    );
    expect(await code(saas.console.trustList(remote.serviceId))).toBe(
      "not_implemented",
    );
  });
});
