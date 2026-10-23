import { describe, expect, it } from "vitest";

import { createMockApi } from "./create-mock-client";
import { MOCK_ACCOUNT, MOCK_PEOPLE, MOCK_TEAMS } from "./fixtures";
import { MOCK_INVITE_BY_OWNER, MOCK_INVITE_EMAIL } from "./teams";

const [rd, lab] = MOCK_TEAMS;
const RD = rd!.teamId;
const LAB = lab!.teamId;

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("mock 团队：创建与列表", () => {
  it("me.spaces 与 teams.list 列出本人所在的团队；创建者是所有者，免费版", async () => {
    const api = createMockApi({ emailVerified: true });
    const created = await api.client.teams.create({
      slug: "alpha",
      name: "甲队",
    });
    expect(created).toMatchObject({
      role: "owner",
      plan: "free",
      slug: "alpha",
    });
    const { spaces } = await api.client.me.spaces({});
    expect(spaces.map((space) => space.kind)).toEqual([
      "personal",
      "team",
      "team",
      "team",
    ]);
    const { teams } = await api.client.teams.list({});
    expect(teams.map((team) => team.slug)).toEqual(["rd", "lab", "alpha"]);
  });

  it("地址被占用、邮箱未验证、已拥有的团队数到上限", async () => {
    const unverified = createMockApi();
    expect(
      await failure(unverified.client.teams.create({ slug: "x1", name: "x" })),
    ).toMatchObject({ code: "email_unverified" });

    const api = createMockApi({ emailVerified: true });
    expect(
      await failure(api.client.teams.create({ slug: "rd", name: "重名" })),
    ).toMatchObject({ code: "team_slug_taken", status: 409 });
    await api.client.teams.create({ slug: "alpha", name: "甲队" });
    expect(
      await failure(api.client.teams.create({ slug: "beta", name: "乙队" })),
    ).toMatchObject({
      code: "limit_reached",
      status: 429,
      details: { quota: "teams", used: 1, limit: 1 },
    });
  });
});

describe("mock 团队：成员", () => {
  it("members：owner / admin / member / billing 看得到，guest 看不到；guest 行带可达主机数", async () => {
    const admin = createMockApi();
    const { members } = await admin.client.teams.members({ teamId: RD });
    expect(members.map((member) => member.role)).toEqual([
      "owner",
      "admin",
      "member",
      "guest",
      "billing",
    ]);
    expect(members.find((member) => member.role === "guest")).toMatchObject({
      reachableHosts: 2,
    });
    for (const role of ["member", "billing"] as const)
      await expect(
        createMockApi({ roles: { rd: role } }).client.teams.members({
          teamId: RD,
        }),
      ).resolves.toBeTruthy();
    expect(
      await failure(
        createMockApi({ roles: { rd: "guest" } }).client.teams.members({
          teamId: RD,
        }),
      ),
    ).toMatchObject({ code: "team_role_insufficient" });
  });

  it("admin 不能改或移除 owner；owner 不能把自己降级", async () => {
    const admin = createMockApi();
    const owner = MOCK_PEOPLE.owner.accountId;
    expect(
      await failure(
        admin.client.teams.memberRole({
          teamId: RD,
          accountId: owner,
          role: "member",
        }),
      ),
    ).toMatchObject({ code: "team_role_insufficient" });
    expect(
      await failure(
        admin.client.teams.memberRemove({ teamId: RD, accountId: owner }),
      ),
    ).toMatchObject({ code: "team_role_insufficient" });

    const asOwner = createMockApi({ roles: { rd: "owner" } });
    expect(
      await failure(
        asOwner.client.teams.memberRole({
          teamId: RD,
          accountId: MOCK_ACCOUNT.accountId,
          role: "member",
        }),
      ),
    ).toMatchObject({ code: "team_last_owner" });
  });

  it("改角色：guest 与成员互转受设置和额度约束", async () => {
    const api = createMockApi();
    const member = MOCK_PEOPLE.member.accountId;
    await api.client.teams.settingsUpdate({ teamId: RD, allowGuests: false });
    expect(
      await failure(
        api.client.teams.memberRole({
          teamId: RD,
          accountId: member,
          role: "guest",
        }),
      ),
    ).toMatchObject({ code: "guests_disabled" });
    await api.client.teams.settingsUpdate({ teamId: RD, allowGuests: true });
    await expect(
      api.client.teams.memberRole({
        teamId: RD,
        accountId: member,
        role: "billing",
      }),
    ).resolves.toMatchObject({ role: "billing" });
  });

  it("降级或移除成员，撤销其发出的待处理邀请", async () => {
    const api = createMockApi({ roles: { rd: "owner" } });
    const emails = async () =>
      (await api.client.invitations.list({ teamId: RD })).invitations
        .filter((row) => row.state === "pending")
        .map((row) => row.email);
    expect(await emails()).toEqual([MOCK_INVITE_EMAIL, MOCK_INVITE_BY_OWNER]);
    // 李四（此时是管理员）降为成员，他发出的邀请撤销，本人发出的还在。
    await api.client.teams.memberRole({
      teamId: RD,
      accountId: MOCK_PEOPLE.owner.accountId,
      role: "member",
    });
    expect(await emails()).toEqual([MOCK_INVITE_EMAIL]);
    await api.client.teams.memberRemove({
      teamId: RD,
      accountId: MOCK_PEOPLE.owner.accountId,
    });
    expect(
      (await api.client.teams.members({ teamId: RD })).members,
    ).toHaveLength(4);
  });

  it("离开：最后一个所有者不能离开；离开后团队不再出现在空间里", async () => {
    const owner = createMockApi({ roles: { rd: "owner" } });
    expect(
      await failure(owner.client.teams.leave({ teamId: RD })),
    ).toMatchObject({ code: "team_last_owner" });
    const member = createMockApi();
    await member.client.teams.leave({ teamId: LAB });
    const { spaces } = await member.client.me.spaces({});
    expect(spaces.filter((space) => space.kind === "team")).toHaveLength(1);
  });
});

describe("mock 团队：邀请", () => {
  it("创建、重发、撤销；重复邀请与已是成员的邮箱被拒绝", async () => {
    const api = createMockApi();
    const created = await api.client.invitations.create({
      kind: "team",
      teamId: RD,
      email: "new@example.com",
      role: "billing",
    });
    expect(created).toMatchObject({ state: "pending", teamRole: "billing" });
    expect(
      await failure(
        api.client.invitations.create({
          kind: "team",
          teamId: RD,
          email: "NEW@example.com",
          role: "member",
        }),
      ),
    ).toMatchObject({ code: "conflict" });
    expect(
      await failure(
        api.client.invitations.create({
          kind: "team",
          teamId: RD,
          email: MOCK_PEOPLE.member.email,
          role: "member",
        }),
      ),
    ).toMatchObject({ code: "member_exists" });
    const resent = await api.client.invitations.resend({
      invitationId: created.invitationId,
    });
    expect(resent.expiresAtMs).toBeGreaterThanOrEqual(created.expiresAtMs);
    await api.client.invitations.revoke({ invitationId: created.invitationId });
    const { invitations } = await api.client.invitations.list({ teamId: RD });
    expect(invitations.some((row) => row.email === "new@example.com")).toBe(
      false,
    );
    expect(
      await failure(
        api.client.invitations.resend({ invitationId: created.invitationId }),
      ),
    ).toMatchObject({ code: "invitation_revoked" });
  });

  it("免费版团队的成员席位到上限答 limit_reached（quota=members）", async () => {
    const api = createMockApi({ roles: { lab: "admin" } });
    for (const n of [1, 2, 3])
      await api.client.invitations.create({
        kind: "team",
        teamId: LAB,
        email: `p${n}@example.com`,
        role: "member",
      });
    expect(
      await failure(
        api.client.invitations.create({
          kind: "team",
          teamId: LAB,
          email: "p4@example.com",
          role: "member",
        }),
      ),
    ).toMatchObject({ code: "limit_reached", details: { quota: "members" } });
  });

  it("列表只有管理员能看，且不混进收到的邀请", async () => {
    expect(
      await failure(
        createMockApi({ roles: { rd: "member" } }).client.invitations.list({
          teamId: RD,
        }),
      ),
    ).toMatchObject({ code: "team_role_insufficient" });
    const { invitations } = await createMockApi().client.invitations.list({
      box: "received",
    });
    expect(invitations.every((row) => row.email === MOCK_ACCOUNT.email)).toBe(
      true,
    );
  });
});

describe("mock 团队：设置与危险操作", () => {
  it("settings：member 以上能读，admin 以上能改；改动合并后保存", async () => {
    const admin = createMockApi();
    const next = await admin.client.teams.settingsUpdate({
      teamId: RD,
      membersCanRegisterHosts: true,
    });
    expect(next).toMatchObject({
      membersCanRegisterHosts: true,
      allowGuests: true,
    });
    expect(await admin.client.teams.settings({ teamId: RD })).toEqual(next);
    expect(
      await failure(
        createMockApi({ roles: { rd: "member" } }).client.teams.settingsUpdate({
          teamId: RD,
          allowGuests: false,
        }),
      ),
    ).toMatchObject({ code: "team_role_insufficient" });
    expect(
      await failure(
        createMockApi({ roles: { rd: "billing" } }).client.teams.settings({
          teamId: RD,
        }),
      ),
    ).toMatchObject({ code: "team_role_insufficient" });
  });

  it("转移所有权：目标必须是 admin，原所有者降为 admin", async () => {
    const api = createMockApi({ roles: { rd: "owner" } });
    expect(
      await failure(
        api.client.teams.transferOwnership({
          teamId: RD,
          accountId: MOCK_PEOPLE.member.accountId,
        }),
      ),
    ).toMatchObject({ code: "bad_request" });
    await api.client.teams.transferOwnership({
      teamId: RD,
      accountId: MOCK_PEOPLE.owner.accountId,
    });
    const { spaces } = await api.client.me.spaces({});
    expect(spaces.find((space) => space.kind === "team")).toMatchObject({
      slug: "rd",
      role: "admin",
    });
    expect(
      await failure(api.client.teams.delete({ teamId: RD })),
    ).toMatchObject({ code: "team_role_insufficient" });
  });

  it("删除：有在线主机答 conflict；删除后进恢复期，其余调用答 team_deleted，所有者能恢复", async () => {
    const busy = createMockApi({ roles: { rd: "owner" } });
    expect(
      await failure(busy.client.teams.delete({ teamId: RD })),
    ).toMatchObject({ code: "conflict" });
    const owner = createMockApi({ roles: { lab: "owner" }, hosts: [] });
    const { purgeAtMs } = await owner.client.teams.delete({ teamId: LAB });
    expect(purgeAtMs - Date.now()).toBeGreaterThan(29 * 86_400_000);
    // 不再出现在空间里，但所有者的 teams.list 还看得到，带清除时间。
    const { spaces } = await owner.client.me.spaces({});
    expect(
      spaces.some((space) => space.kind === "team" && space.slug === "lab"),
    ).toBe(false);
    const { teams } = await owner.client.teams.list({});
    expect(teams.find((team) => team.slug === "lab")).toMatchObject({
      purgeAtMs,
    });
    expect(
      await failure(owner.client.teams.get({ teamId: LAB })),
    ).toMatchObject({ code: "team_deleted", status: 410 });
    await expect(
      owner.client.teams.restore({ teamId: LAB }),
    ).resolves.toMatchObject({ deletedAtMs: null });
  });

  it("恢复按团队数额度核对：已另有一个自己拥有的团队时答 limit_reached", async () => {
    const api = createMockApi({
      emailVerified: true,
      hosts: [],
      roles: { lab: "owner" },
    });
    await api.client.teams.delete({ teamId: LAB });
    await api.client.teams.create({ slug: "alpha", name: "甲队" });
    expect(
      await failure(api.client.teams.restore({ teamId: LAB })),
    ).toMatchObject({ code: "limit_reached", details: { quota: "teams" } });
  });

  it("用量：member 以上能读，列出主机 / 成员 / 访客 / 流量", async () => {
    const usage = await createMockApi({
      roles: { rd: "billing" },
    }).client.teams.usage({ teamId: RD });
    expect(usage.usage.map((entry) => entry.metric)).toEqual([
      "hosts",
      "members",
      "guests",
      "traffic",
    ]);
    expect(usage.usage[0]).toMatchObject({ value: 3 });
  });
});
