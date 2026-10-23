import { describe, expect, it } from "vitest";

import { ALL_ROLES, INVITE_ROLES, teamCaps } from "./roles";

describe("团队角色能力", () => {
  it("只有 owner / admin 管邀请与设置；转移与删除只有 owner；每个角色都能离开", () => {
    const table = ALL_ROLES.map((role) => {
      const caps = teamCaps(role);
      return [
        role,
        caps.manageInvitations,
        caps.editSettings,
        caps.transfer,
        caps.delete,
        caps.leave,
        caps.viewMembers,
      ];
    });
    expect(table).toEqual([
      ["owner", true, true, true, true, true, true],
      ["admin", true, true, false, false, true, true],
      ["member", false, false, false, false, true, true],
      ["billing", false, false, false, false, true, true],
      ["guest", false, false, false, false, true, false],
    ]);
  });

  it("不能改或移除 owner；改角色的选项不含 owner", () => {
    for (const role of ALL_ROLES) {
      const caps = teamCaps(role);
      expect(caps.canChangeRole("owner")).toBe(false);
      expect(caps.canRemove("owner")).toBe(false);
    }
    expect(INVITE_ROLES).not.toContain("owner");
    expect(teamCaps("admin").canChangeRole("member")).toBe(true);
    expect(teamCaps("member").canChangeRole("guest")).toBe(false);
    expect(teamCaps("billing").canRemove("member")).toBe(false);
  });

  it("概览的卡：guest 只有主机，billing 没有主机", () => {
    expect(teamCaps("guest").overview).toEqual({
      hosts: true,
      members: false,
      traffic: false,
      plan: false,
    });
    expect(teamCaps("billing").overview).toEqual({
      hosts: false,
      members: true,
      traffic: true,
      plan: true,
    });
    expect(Object.values(teamCaps("member").overview).every(Boolean)).toBe(
      true,
    );
  });
});
