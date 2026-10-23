import { describe, expect, it } from "vitest";

import { createMockApi } from "./create-mock-client";
import { MOCK_ACCOUNT, MOCK_HOSTS, MOCK_PEOPLE, MOCK_TEAMS } from "./fixtures";
import { WORKSPACES } from "./grants";

const [rd, lab] = MOCK_TEAMS;
const RD = { kind: "team", teamId: rd!.teamId } as const;
const LAB = { kind: "team", teamId: lab!.teamId } as const;
const BUILD = MOCK_HOSTS[0]!.sourceId;
const STUDIO = MOCK_HOSTS[1]!.sourceId;
const DEVBOX = MOCK_HOSTS[2]!.sourceId;
const LISI = MOCK_PEOPLE.owner.accountId;
const WANGWU = MOCK_PEOPLE.member.accountId;
const ZHAOLIU = MOCK_PEOPLE.guest.accountId;
const SELF = MOCK_ACCOUNT.accountId;

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

const OPTIONS = { emailVerified: true } as const;

describe("mock 团队主机目录的可见性", () => {
  it("owner / admin 看全部团队主机，状态与搜索与游标照常", async () => {
    const api = createMockApi(OPTIONS);
    const all = await api.client.sources.list({ space: RD });
    expect(all.sources.map((row) => row.name)).toEqual([
      "build-01",
      "mac-studio",
      "dev-box",
    ]);
    const online = await api.client.sources.list({
      space: RD,
      status: "online",
      q: "BUILD",
    });
    expect(online.sources.map((row) => row.name)).toEqual(["build-01"]);
    const first = await api.client.sources.list({ space: RD, limit: 2 });
    expect(first.nextCursor).toBe("2");
    const second = await api.client.sources.list({
      space: RD,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.sources.map((row) => row.name)).toEqual(["dev-box"]);
    expect(second.nextCursor).toBeNull();
  });

  it("member 只看自己登记的与被授予到的；guest 只看被授予的；billing 不可达", async () => {
    const member = createMockApi({ ...OPTIONS, roles: { rd: "member" } });
    const seen = await member.client.sources.list({ space: RD });
    // build-01 是自己的，dev-box 有团队全员的授予，mac-studio 与他无关。
    expect(seen.sources.map((row) => row.name)).toEqual([
      "build-01",
      "dev-box",
    ]);
    await expect(
      member.client.sources.get({ sourceId: STUDIO }),
    ).rejects.toMatchObject({ code: "not_found" });

    const guest = createMockApi({ ...OPTIONS, roles: { rd: "guest" } });
    expect(
      (await guest.client.sources.list({ space: RD })).sources,
    ).toHaveLength(3);

    const billing = createMockApi({ ...OPTIONS, roles: { rd: "billing" } });
    await expect(
      billing.client.sources.list({ space: RD }),
    ).rejects.toMatchObject({ code: "team_role_insufficient" });
  });
});

describe("mock 注册令牌", () => {
  it("owner / admin 取得到；member 看团队开关；guest / billing 不能登记", async () => {
    const admin = createMockApi(OPTIONS);
    const token = await admin.client.sources.registrationToken({ space: RD });
    expect(token.registrationToken).toMatch(/^armadra-reg-/);
    expect(token.expiresAtMs).toBeGreaterThan(Date.now());

    const member = createMockApi({ ...OPTIONS, roles: { rd: "member" } });
    await expect(
      member.client.sources.registrationToken({ space: RD }),
    ).rejects.toMatchObject({ code: "host_registration_disabled" });
    const allowed = createMockApi({
      ...OPTIONS,
      roles: { rd: "member" },
      settings: { membersCanRegisterHosts: true },
    });
    await expect(
      allowed.client.sources.registrationToken({ space: RD }),
    ).resolves.toHaveProperty("registrationToken");

    for (const role of ["guest", "billing"] as const) {
      const api = createMockApi({ ...OPTIONS, roles: { rd: role } });
      await expect(
        api.client.sources.registrationToken({ space: RD }),
      ).rejects.toMatchObject({ code: "team_role_insufficient" });
    }
  });

  it("邮箱未验证与主机额度已满", async () => {
    await expect(
      createMockApi().client.sources.registrationToken({ space: RD }),
    ).rejects.toMatchObject({ code: "email_unverified" });
    // lab 是免费版，额度 3：再多登记一台前先用满。
    const api = createMockApi({
      ...OPTIONS,
      roles: { lab: "admin" },
      extraHosts: [
        {
          ...MOCK_HOSTS[3]!,
          sourceId: "f".repeat(32),
          name: "third",
        },
      ],
    });
    expect(
      await failure(api.client.sources.registrationToken({ space: LAB })),
    ).toMatchObject({
      code: "limit_reached",
      details: { quota: "hosts", limit: 3 },
    });
  });
});

describe("mock 主机设置", () => {
  it("缺省角色取团队的缺省主机角色，主机自己改过以主机为准", async () => {
    const api = createMockApi({
      ...OPTIONS,
      settings: { defaultHostRole: "editor" },
    });
    expect(
      (await api.client.sources.get({ sourceId: BUILD })).settings,
    ).toMatchObject({
      defaultRole: "editor",
    });
    await api.client.sources.update({
      sourceId: BUILD,
      settings: { defaultRole: "driver" },
    });
    expect(
      (await api.client.sources.get({ sourceId: BUILD })).settings,
    ).toMatchObject({
      defaultRole: "driver",
    });
  });
});

describe("mock 授予", () => {
  it("同主机同主体已有授予：create 答 409 conflict；换范围走 update（整体替换）", async () => {
    const api = createMockApi(OPTIONS);
    expect(
      await failure(
        api.client.grants.create({
          sourceId: BUILD,
          subject: { kind: "member", accountId: LISI },
          role: "viewer",
        }),
      ),
    ).toMatchObject({ code: "conflict", status: 409 });
    const { grants } = await api.client.grants.list({
      sourceId: BUILD,
      accountId: WANGWU,
    });
    expect(grants).toHaveLength(1);
    const updated = await api.client.grants.update({
      grantId: grants[0]!.grantId,
      workspaceIds: [WORKSPACES.docs],
    });
    // 整体替换：原来的 api 不再保留。
    expect(updated.workspaceIds).toEqual([WORKSPACES.docs]);
    expect(updated.role).toBe("driver");
  });

  it("团队主机的访客只能被授予到工作空间；非访客角色不能当访客授予；关了访客就拒绝", async () => {
    const api = createMockApi(OPTIONS);
    await api.client.grants.revoke({
      grantId: (
        await api.client.grants.list({ sourceId: BUILD, accountId: ZHAOLIU })
      ).grants[0]!.grantId,
    });
    expect(
      await failure(
        api.client.grants.create({
          sourceId: BUILD,
          subject: { kind: "guest", accountId: ZHAOLIU },
          role: "viewer",
        }),
      ),
    ).toMatchObject({ code: "bad_request" });
    expect(
      await failure(
        api.client.grants.create({
          sourceId: BUILD,
          subject: { kind: "guest", accountId: LISI },
          role: "viewer",
          workspaceIds: [WORKSPACES.docs],
        }),
      ),
    ).toMatchObject({ code: "bad_request" });
    await api.client.sources.update({
      sourceId: BUILD,
      settings: { allowGuests: false },
    });
    expect(
      await failure(
        api.client.grants.create({
          sourceId: BUILD,
          subject: { kind: "guest", accountId: ZHAOLIU },
          role: "viewer",
          workspaceIds: [WORKSPACES.docs],
        }),
      ),
    ).toMatchObject({ code: "guests_disabled" });
  });

  it("到期必须在未来；邮箱未验证不能授予；分组是 M2", async () => {
    const api = createMockApi(OPTIONS);
    expect(
      await failure(
        api.client.grants.create({
          sourceId: STUDIO,
          subject: { kind: "member", accountId: WANGWU },
          role: "viewer",
          expiresAtMs: Date.now() - 1000,
        }),
      ),
    ).toMatchObject({ code: "bad_request" });
    expect(
      await failure(
        api.client.grants.create({
          sourceId: STUDIO,
          subject: { kind: "group", groupId: "grp_1" },
          role: "viewer",
        }),
      ),
    ).toMatchObject({ code: "plan_feature_unavailable" });
    expect(
      await failure(
        createMockApi().client.grants.create({
          sourceId: STUDIO,
          subject: { kind: "member", accountId: WANGWU },
          role: "viewer",
        }),
      ),
    ).toMatchObject({ code: "email_unverified" });
  });

  it("member 管不了别人的主机，能管自己的", async () => {
    const api = createMockApi({ ...OPTIONS, roles: { rd: "member" } });
    await expect(
      api.client.grants.list({ sourceId: DEVBOX }),
    ).rejects.toMatchObject({ code: "team_role_insufficient" });
    await expect(
      api.client.grants.list({ sourceId: BUILD }),
    ).resolves.toHaveProperty("grants");
  });
});

describe("mock 有效权限与访问清单", () => {
  it("合成降级：王五 driver@api 加团队全员 viewer 整台 = viewer 整台，来源两条", async () => {
    const api = createMockApi(OPTIONS);
    const effective = await api.client.grants.effective({
      sourceId: BUILD,
      accountId: WANGWU,
    });
    expect(effective).toMatchObject({
      role: "viewer",
      workspaceIds: [],
      expiresAtMs: null,
    });
    expect(effective.from.map((one) => [one.via, one.role])).toEqual([
      ["team", "viewer"],
      ["member", "driver"],
    ]);
  });

  it("访客只在授予的工作空间里有权限，到期取最早的来路", async () => {
    const api = createMockApi(OPTIONS);
    const effective = await api.client.grants.effective({
      sourceId: BUILD,
      accountId: ZHAOLIU,
    });
    expect(effective.role).toBe("editor");
    expect(effective.workspaceIds).toEqual(
      [WORKSPACES.api, WORKSPACES.docs].sort(),
    );
    expect(effective.expiresAtMs).not.toBeNull();
  });

  it("accessList：每人一行取合成后的角色，团队全员展开到成员，所有者行不挂授予", async () => {
    const api = createMockApi(OPTIONS);
    const { access } = await api.client.sources.accessList({
      sourceId: BUILD,
    });
    const row = (id: string) => access.find((one) => one.accountId === id)!;
    expect(row(SELF)).toMatchObject({ via: "owner", role: "driver" });
    expect(row(SELF).grantId).toBeUndefined();
    expect(row(WANGWU)).toMatchObject({ role: "viewer", via: "team" });
    expect(row(LISI)).toMatchObject({ role: "operator" });
    expect(row(ZHAOLIU)).toMatchObject({ role: "editor" });
    // 账号 billing 没有任何来路，不在清单里。
    expect(access.map((one) => one.accountId)).not.toContain(
      MOCK_PEOPLE.billing.accountId,
    );
  });

  it("撤销：accessRevoke 撤掉他本人的授予；只有团队授予的人撤不掉（404）", async () => {
    const api = createMockApi(OPTIONS);
    await api.client.sources.accessRevoke({
      sourceId: BUILD,
      accountId: WANGWU,
    });
    const after = await api.client.grants.effective({
      sourceId: BUILD,
      accountId: WANGWU,
    });
    expect(after.from.map((one) => one.via)).toEqual(["team"]);
    expect(
      await failure(
        api.client.sources.accessRevoke({
          sourceId: BUILD,
          accountId: WANGWU,
        }),
      ),
    ).toMatchObject({ code: "not_found" });
  });

  it("收窄记下来（云端撤令牌）：更宽更低的授予、降角色、撤销；放宽与新授予不记", async () => {
    const api = createMockApi(OPTIONS);
    // 李四在 dev-box 上只有团队全员 editor；再给他单独 viewer 整台：合成仍是 editor，不收窄。
    await api.client.grants.create({
      sourceId: DEVBOX,
      subject: { kind: "member", accountId: LISI },
      role: "viewer",
    });
    expect(api.narrowedAccess()).toEqual([]);
    // mac-studio 原来没人有权限：加团队全员 viewer 是放宽，升成 editor 也是。
    const team = await api.client.grants.create({
      sourceId: STUDIO,
      subject: { kind: "team", teamId: rd!.teamId },
      role: "viewer",
    });
    await api.client.grants.update({ grantId: team.grantId, role: "editor" });
    expect(api.narrowedAccess()).toEqual([]);
    // 降回 viewer：团队里的成员被收窄。
    await api.client.grants.update({ grantId: team.grantId, role: "viewer" });
    expect(api.narrowedAccess().map((one) => one.sourceId)).toContain(STUDIO);
    // 撤掉团队全员后，给王五 driver@api，再补一条团队全员 viewer 整台：王五被合成降为 viewer 整台。
    await api.client.grants.revoke({ grantId: team.grantId });
    await api.client.grants.create({
      sourceId: STUDIO,
      subject: { kind: "member", accountId: WANGWU },
      role: "driver",
      workspaceIds: [WORKSPACES.api],
    });
    const before = api.narrowedAccess().length;
    await api.client.grants.create({
      sourceId: STUDIO,
      subject: { kind: "team", teamId: rd!.teamId },
      role: "viewer",
    });
    expect(api.narrowedAccess().slice(before)).toEqual([
      { sourceId: STUDIO, accountId: WANGWU },
    ]);
    const [again] = (
      await api.client.grants.list({ sourceId: STUDIO })
    ).grants.filter((one) => one.subject.kind === "team");
    expect(
      await failure(api.client.grants.revoke({ grantId: again!.grantId })),
    ).toBeNull();
    expect(
      await failure(api.client.grants.revoke({ grantId: again!.grantId })),
    ).toMatchObject({ code: "not_found" });
  });
});
