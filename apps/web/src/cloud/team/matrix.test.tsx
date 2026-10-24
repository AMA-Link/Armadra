import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TeamRole } from "../shell/model";
import { installConsoleHarness, mount } from "../testkit";
import { ALL_ROLES } from "./roles";

installConsoleHarness();

const OPTIONS = { emailVerified: true } as const;

/** 角色 → 每个动作是否渲染（云端控制台 §2.4、§3.3.2、§3.3.12 的角色矩阵）。 */
const MEMBERS_PAGE: Record<
  TeamRole,
  {
    invite: boolean;
    invitationsTab: boolean;
    roleSelect: boolean;
    removeOthers: boolean;
    leaveSelf: boolean;
  }
> = {
  owner: {
    invite: true,
    invitationsTab: true,
    roleSelect: true,
    removeOthers: true,
    leaveSelf: false,
  },
  admin: {
    invite: true,
    invitationsTab: true,
    roleSelect: true,
    removeOthers: true,
    leaveSelf: true,
  },
  member: {
    invite: false,
    invitationsTab: false,
    roleSelect: false,
    removeOthers: false,
    leaveSelf: true,
  },
  billing: {
    invite: false,
    invitationsTab: false,
    roleSelect: false,
    removeOthers: false,
    leaveSelf: true,
  },
  guest: {
    invite: false,
    invitationsTab: false,
    roleSelect: false,
    removeOthers: false,
    leaveSelf: false,
  },
};

const SETTINGS_PAGE: Record<
  TeamRole,
  {
    general: boolean;
    access: boolean;
    transfer: boolean;
    leave: boolean;
    delete: boolean;
  }
> = {
  owner: {
    general: true,
    access: true,
    transfer: true,
    leave: false,
    delete: true,
  },
  admin: {
    general: true,
    access: true,
    transfer: false,
    leave: true,
    delete: false,
  },
  member: {
    general: false,
    access: false,
    transfer: false,
    leave: true,
    delete: false,
  },
  billing: {
    general: false,
    access: false,
    transfer: false,
    leave: true,
    delete: false,
  },
  guest: {
    general: false,
    access: false,
    transfer: false,
    leave: true,
    delete: false,
  },
};

const present = (query: () => unknown) => query() !== null;

describe("角色矩阵 · 成员与邀请（5 角色 × 每个动作是否渲染）", () => {
  for (const role of ALL_ROLES) {
    it(role, async () => {
      mount("/t/rd/members", { ...OPTIONS, roles: { rd: role } });
      const expected = MEMBERS_PAGE[role];
      if (role === "guest") {
        // guest 没有成员页：整页「没有权限」，侧栏里也没有「成员」。
        expect(await screen.findByText(/没有权限|不能做/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "邀请成员" })).toBeNull();
        return;
      }
      const table = await screen.findByRole("table", { name: "成员" });
      expect(
        present(() => screen.queryByRole("button", { name: "邀请成员" })),
      ).toBe(expected.invite);
      expect(present(() => screen.queryByRole("tab", { name: "邀请" }))).toBe(
        expected.invitationsTab,
      );
      expect(
        present(() =>
          within(table).queryByRole("combobox", { name: "王五 的角色" }),
        ),
      ).toBe(expected.roleSelect);
      expect(
        present(() =>
          within(table).queryByRole("button", { name: "王五 的操作" }),
        ),
      ).toBe(expected.removeOthers);
      // 本人一行的「离开团队」。
      expect(
        present(() =>
          within(table).queryByRole("button", { name: "张三 的操作" }),
        ),
      ).toBe(expected.leaveSelf);
      // 任何角色都不能动所有者：他那一行没有角色 Select 和菜单（本人是所有者时不存在这一行）。
      if (role !== "owner") {
        expect(
          within(table).queryByRole("combobox", { name: "李四 的角色" }),
        ).toBeNull();
        expect(
          within(table).queryByRole("button", { name: "李四 的操作" }),
        ).toBeNull();
      }
    });
  }

  it("管理员的行菜单里是「移除」，本人一行是「离开团队」，没有别的", async () => {
    mount("/t/rd/members", OPTIONS);
    await screen.findByRole("table", { name: "成员" });
    const others = await screen.findByRole("button", { name: "王五 的操作" });
    fireEvent.keyDown(others, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["移除"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.keyDown(screen.getByRole("button", { name: "张三 的操作" }), {
      key: "Enter",
    });
    expect(
      within(await screen.findByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["离开团队"]);
  });
});

describe("角色矩阵 · 设置与危险操作", () => {
  for (const role of ALL_ROLES) {
    it(role, async () => {
      mount("/t/rd/settings", { ...OPTIONS, roles: { rd: role } });
      const expected = SETTINGS_PAGE[role];
      await screen.findByRole("heading", { level: 1, name: "设置" });
      expect(present(() => screen.queryByLabelText("名称"))).toBe(
        expected.general,
      );
      await waitFor(() =>
        expect(
          present(() => screen.queryByRole("switch", { name: "允许访客" })),
        ).toBe(expected.access),
      );
      expect(
        present(() => screen.queryByRole("combobox", { name: "新所有者" })),
      ).toBe(expected.transfer);
      expect(
        present(() => screen.queryByRole("button", { name: "离开团队" })),
      ).toBe(expected.leave);
      expect(
        present(() => screen.queryByRole("button", { name: "删除团队" })),
      ).toBe(expected.delete);
    });
  }
});

describe("角色矩阵 · 侧栏", () => {
  const NAV_ITEMS = ["成员", "设置", "审计", "用量与计划"];
  const VISIBLE: Record<TeamRole, string[]> = {
    owner: ["成员", "设置", "审计", "用量与计划"],
    admin: ["成员", "设置", "审计"],
    member: ["成员", "设置"],
    billing: ["成员", "设置", "用量与计划"],
    guest: ["设置"],
  };
  for (const role of ALL_ROLES) {
    it(role, async () => {
      mount("/t/rd", { ...OPTIONS, roles: { rd: role } });
      const nav = await screen.findByRole("navigation", { name: "导航" });
      expect(
        NAV_ITEMS.filter((name) => within(nav).queryByText(name) !== null),
      ).toEqual(VISIBLE[role]);
    });
  }
});
