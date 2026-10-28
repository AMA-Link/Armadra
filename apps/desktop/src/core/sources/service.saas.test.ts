import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFreshDatabase } from "../db/fresh.fixture";
import type { OpenedDatabase } from "../db/open";
import { tempDir } from "../testing/temp-dir";
import { migrationsDir } from "../workspaces/fixture";
import {
  ISSUER,
  RELAYED_ID,
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

/** 契约 §86：Armadra 云挂载的团队与归属（假的 Armadra 云与假的 core）。 */

const HOST_ID = "f".repeat(32);

let opened: OpenedDatabase;
let world: FakeWorld;
let backend: ReturnType<typeof memoryBackend>;

beforeEach(() => {
  opened = openFreshDatabase(
    join(tempDir("armadra-sources-saas-"), "canvas.db"),
    migrationsDir(),
  );
  world = fakeWorld();
  backend = memoryBackend();
});

afterEach(() => {
  opened.close();
});

describe("契约 §86：Armadra 云挂载的团队与归属", () => {
  let saas: SourcesService;
  let clock: number;

  beforeEach(async () => {
    clock = Date.now();
    world.cloud.mode = "saas";
    world.fingerprints.delete(ISSUER);
    saas = new SourcesService({
      store: new SourcesStore(opened.database),
      secrets: new SourceSecrets(() => backend),
      remote: new RemoteClient(world.transport, {
        platform: "desktop",
        name: "test",
      }),
      peer: new SourceClient(world.transport, plainSealed(world.transport)),
      hostId: () => HOST_ID,
      hostLabel: () => "this-mac",
      log: { info: () => undefined, warn: () => undefined },
      now: () => clock,
    });
    const { remote } = await saas.remoteAdd({ kind: "saas", issuer: ISSUER });
    world.cloud.device.status = "approved";
    clock += 6_000;
    await saas.remoteDevicePoll(remote.serviceId);
    world.cloud.spaces = [
      { kind: "personal", plan: "free" },
      {
        kind: "team",
        teamId: "team-1",
        slug: "rd",
        name: "研发组",
        role: "member",
        plan: "team",
      },
    ];
    serviceId = remote.serviceId;
  });
  let serviceId: string;

  it("别人的团队主机：shared，团队来自自己拿到的断言，名字来自这个云的 me.spaces", async () => {
    world.cloud.owner = false;
    world.cloud.assertionTeam = "team-1";
    const mounted = await saas.mount({ serviceId, sourceId: RELAYED_ID });
    expect(mounted).toMatchObject({
      origin: "shared",
      teamId: "team-1",
      teamName: "研发组",
    });
  });

  it("名字取不到留空；断言不带团队是个人分享；对端 share.team 不采信", async () => {
    world.cloud.owner = false;
    world.cloud.assertionTeam = "team-unknown";
    const core = world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!;
    (core as { share?: unknown }).share = {
      ownerName: "Alice",
      role: "viewer",
      expiresAtMs: 0,
      team: { teamId: "evil", name: "冒充" },
    };
    expect(await saas.mount({ serviceId, sourceId: RELAYED_ID })).toMatchObject(
      {
        origin: "shared",
        ownerLabel: "Alice",
        teamId: "team-unknown",
        teamName: "",
      },
    );
    delete world.cloud.assertionTeam;
    const personal = await saas.mount({ serviceId, sourceId: RELAYED_ID });
    expect(personal).toMatchObject({
      origin: "shared",
      teamId: "",
      teamName: "",
    });
  });

  it("断言的 aud 不是这台源：按无团队处理", async () => {
    world.cloud.owner = false;
    world.cloud.assertionTeam = "team-1";
    world.cloud.assertionAud = "ffffffffffffffffffffffffffffffff";
    expect(await saas.mount({ serviceId, sourceId: RELAYED_ID })).toMatchObject(
      { origin: "shared", teamId: "", teamName: "" },
    );
    delete world.cloud.assertionAud;
  });

  const listed = async () =>
    (await saas.list()).sources.find((one) => one.sourceId === RELAYED_ID);
  it("me.sources 取不到：新挂载按 shared，恢复后再挂以目录为准；已有行保持原归属", async () => {
    world.cloud.sourcesFail = true;
    world.cloud.assertionTeam = "team-1";
    expect(await saas.mount({ serviceId, sourceId: RELAYED_ID })).toMatchObject(
      { origin: "shared", teamId: "team-1", teamName: "研发组" },
    );
    world.cloud.sourcesFail = false;
    world.cloud.owner = false;
    expect(await saas.mount({ serviceId, sourceId: RELAYED_ID })).toMatchObject(
      { origin: "shared", teamId: "team-1", teamName: "研发组" },
    );
    world.cloud.sourcesFail = true;
    world.cloud.assertionTeam = "team-2";
    expect(await saas.mount({ serviceId, sourceId: RELAYED_ID })).toMatchObject(
      { origin: "shared", teamId: "team-1", teamName: "研发组" },
    );
  });

  it("目录明确答了就覆盖已有归属：owner=false 把 mine 改 shared，owner=true 把 shared 改 mine 并清团队；没列出这台按 shared", async () => {
    world.cloud.assertionTeam = "team-1";
    await saas.mount({ serviceId, sourceId: RELAYED_ID });
    expect(await listed()).toMatchObject({ origin: "mine" });
    world.cloud.owner = false;
    expect(await saas.mount({ serviceId, sourceId: RELAYED_ID })).toMatchObject(
      { origin: "shared", teamId: "team-1", teamName: "研发组" },
    );
    world.cloud.owner = true;
    expect(await saas.mount({ serviceId, sourceId: RELAYED_ID })).toMatchObject(
      { origin: "mine", teamId: "", teamName: "" },
    );
    world.cloud.sources.splice(0);
    expect(await saas.mount({ serviceId, sourceId: RELAYED_ID })).toMatchObject(
      { origin: "shared" },
    );
  });

  it("shared 状态下重新登录：团队 team-1 变 team-2 刷新，断言去掉团队后清空", async () => {
    world.cloud.owner = false;
    world.cloud.assertionTeam = "team-1";
    await saas.mount({ serviceId, sourceId: RELAYED_ID });
    const core = world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!;
    world.cloud.assertionTeam = "team-2";
    core.sessions.revokeAll();
    await saas.session(RELAYED_ID, "relayed");
    expect(await listed()).toMatchObject({
      origin: "shared",
      teamId: "team-2",
      teamName: "",
    });
    delete world.cloud.assertionTeam;
    core.sessions.revokeAll();
    await saas.session(RELAYED_ID, "relayed");
    expect(await listed()).toMatchObject({
      origin: "shared",
      teamId: "",
      teamName: "",
    });
  });

  it("中继重新登录按自己的云纠正归属：mine 变 shared 带团队，shared 变 mine", async () => {
    world.cloud.assertionTeam = "team-1";
    await saas.mount({ serviceId, sourceId: RELAYED_ID });
    const core = world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!;
    world.cloud.owner = false;
    core.sessions.revokeAll();
    await saas.session(RELAYED_ID, "relayed");
    expect(await listed()).toMatchObject({
      origin: "shared",
      teamId: "team-1",
      teamName: "研发组",
    });
    world.cloud.owner = true;
    core.sessions.revokeAll();
    await saas.session(RELAYED_ID, "relayed");
    expect(await listed()).toMatchObject({
      origin: "mine",
      teamId: "",
      teamName: "",
    });
  });

  it("已有 mine 行遇目录失败：保持 mine", async () => {
    await saas.mount({ serviceId, sourceId: RELAYED_ID });
    world.cloud.sourcesFail = true;
    world.cloud.owner = false;
    expect(await saas.mount({ serviceId, sourceId: RELAYED_ID })).toMatchObject(
      { origin: "mine", teamId: "", teamName: "" },
    );
  });

  it("目录判 shared 但对端没报分享信息（旧 core）：沿用已有 shared 行的分享信息", async () => {
    world.cloud.owner = false;
    const core = world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!;
    (core as { share?: unknown }).share = {
      ownerName: "Alice",
      role: "viewer",
      expiresAtMs: 9_000_000,
    };
    await saas.mount({ serviceId, sourceId: RELAYED_ID });
    delete (core as { share?: unknown }).share;
    expect(await saas.mount({ serviceId, sourceId: RELAYED_ID })).toMatchObject(
      {
        origin: "shared",
        ownerLabel: "Alice",
        shareRole: "viewer",
        shareExpiresAtMs: 9_000_000,
      },
    );
  });

  it("自己的主机（owner）：mine，不记团队；个人中转挂载不记团队", async () => {
    world.cloud.assertionTeam = "team-1";
    expect(await saas.mount({ serviceId, sourceId: RELAYED_ID })).toMatchObject(
      {
        origin: "mine",
        teamId: "",
        teamName: "",
      },
    );
  });

  it("remoteSources 对 SaaS 远程可用", async () => {
    const listed = await saas.remoteSources(serviceId);
    expect(Array.isArray(listed.sources)).toBe(true);
  });
  /* -------------------- 契约 §88：远程会话与续期（#582 B1） -------------------- */

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => "ok",
      (error: { code?: string }) => error.code ?? "?",
    );
  const stored = async () =>
    (await new SourceSecrets(() => backend).source(RELAYED_ID)).byOrigin[
      ISSUER
    ];
  const relayedCore = () => world.cores.get(`${ISSUER}/s/${RELAYED_ID}`)!;

  it("remoteSession / remoteEndpoint 对 SaaS 开放：访问令牌、能力与签发方", async () => {
    const session = await saas.remoteSession(serviceId);
    expect(session.accessToken).not.toBe("");
    expect(session.issuer).toBe(ISSUER);
    expect(Array.isArray(session.capabilities)).toBe(true);
    const endpoint = await saas.remoteEndpoint(serviceId);
    expect(endpoint).toMatchObject({ issuer: ISSUER });
    expect(endpoint.accessToken).toBe(session.accessToken);
  });

  it("没有保存的登录：remoteSession 答 source_unauthorized", async () => {
    await saas.remoteLogout(serviceId);
    expect(await failure(saas.remoteSession(serviceId))).toBe(
      "source_unauthorized",
    );
  });

  it("跨寿命续期：刷新 401 → 带旧刷新令牌重登，同一会话、存着的令牌被替换而不是先删", async () => {
    world.cloud.owner = false;
    await saas.mount({ serviceId, sourceId: RELAYED_ID });
    const core = relayedCore();
    const before = await stored();
    expect(before).toBeDefined();
    core.refuseRefresh = true;
    const session = await saas.session(RELAYED_ID, "relayed");
    expect(session.via).toBe("relayed");
    // 刷新被拒之后令牌没删：重登带的正是它，主机在原会话上续。
    expect(core.lastLoginRefresh).toBe(before!.refreshToken);
    expect(core.continued).toBe(1);
    const after = await stored();
    expect(after?.deviceId).toBe(before!.deviceId);
    expect(after?.refreshToken).not.toBe(before!.refreshToken);
    // 下一轮再续：仍是同一会话。
    await saas.session(RELAYED_ID, "relayed");
    expect(core.continued).toBe(2);
    expect((await stored())?.deviceId).toBe(before!.deviceId);
  });

  it("relogin：跳过刷新，直接带旧刷新令牌 cloud/login", async () => {
    world.cloud.owner = false;
    await saas.mount({ serviceId, sourceId: RELAYED_ID });
    const core = relayedCore();
    const before = await stored();
    const refreshes = () =>
      world.requests.filter((one) =>
        one.url.endsWith("/api/identity/session/refresh"),
      ).length;
    const counted = refreshes();
    const logins = core.cloudLogins;
    await saas.session(RELAYED_ID, undefined, undefined, true);
    expect(refreshes()).toBe(counted);
    expect(core.cloudLogins).toBe(logins + 1);
    expect(core.lastLoginRefresh).toBe(before!.refreshToken);
    expect((await stored())?.deviceId).toBe(before!.deviceId);
  });

  it("relogin 只经中继：指定直连答 bad_request", async () => {
    await saas.mount({ serviceId, sourceId: RELAYED_ID });
    expect(
      await failure(saas.session(RELAYED_ID, "direct", undefined, true)),
    ).toBe("bad_request");
  });

  it("重登被明确拒绝才删存着的令牌；待确认、限流留着", async () => {
    world.cloud.owner = false;
    await saas.mount({ serviceId, sourceId: RELAYED_ID });
    const core = relayedCore();
    core.refuseRefresh = true;
    core.refuseCloudLogin = "rate_limited";
    expect(await failure(saas.session(RELAYED_ID, "relayed"))).toBe(
      "rate_limited",
    );
    expect(await stored()).toBeDefined();
    core.refuseCloudLogin = "cloud_account_unlinked";
    expect(await failure(saas.session(RELAYED_ID, "relayed"))).toBe(
      "cloud_account_unlinked",
    );
    expect(await stored()).toBeUndefined();
  });
});
