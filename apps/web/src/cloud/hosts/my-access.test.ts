import { describe, expect, it } from "vitest";

import { myAccessLabel, myAccessOf, showsMyAccess } from "./data";

const t = (key: string) => key;
/** 协议包 0.10 的类型里没有 `myRole`：按服务端的原样对象传。 */
const row = (owner: boolean, myRole?: unknown) =>
  myRole === undefined ? { owner } : { owner, myRole };

describe("myAccessOf：sourceSummary.myRole 的四种取值", () => {
  it("缺省（旧服务端、个人空间、链接访客）：不显示，所有者也一样", () => {
    expect(myAccessOf(row(false))).toBeNull();
    expect(myAccessOf(row(true))).toBeNull();
    expect(myAccessLabel(t, row(false), "member")).toBeNull();
  });

  it("null：看得到但没有有效权限", () => {
    expect(myAccessOf(row(false, null))).toEqual({ kind: "none" });
    expect(myAccessLabel(t, row(false, null), "member")).toBe(
      "cloud.hosts.myAccessNone",
    );
  });

  it("四档角色：复用 workspaceGroups.role.* 的文案", () => {
    for (const role of ["viewer", "editor", "operator", "driver"]) {
      expect(myAccessOf(row(false, role))).toEqual({ kind: "role", role });
      expect(myAccessLabel(t, row(false, role), "guest")).toBe(
        `workspaceGroups.role.${role}`,
      );
    }
  });

  it("owner: true：显示「所有者」，不用 myRole 的 driver", () => {
    expect(myAccessOf(row(true, "driver"))).toEqual({ kind: "owner" });
    expect(myAccessLabel(t, row(true, "driver"), "member")).toBe(
      "cloud.hosts.owner",
    );
    expect(myAccessOf(row(true, null))).toEqual({ kind: "owner" });
  });

  it("认不出的值当没报", () => {
    expect(myAccessOf(row(false, "admin"))).toBeNull();
    expect(myAccessOf(row(false, 3))).toBeNull();
  });
});

describe("我的权限只对 member / guest（§3.3.4）", () => {
  it("member、guest 显示；owner、admin、billing 与个人空间不显示", () => {
    expect(showsMyAccess("member")).toBe(true);
    expect(showsMyAccess("guest")).toBe(true);
    for (const role of ["owner", "admin", "billing", undefined] as const) {
      expect(showsMyAccess(role)).toBe(false);
      expect(myAccessLabel(t, row(false, "editor"), role)).toBeNull();
      expect(myAccessLabel(t, row(false, null), role)).toBeNull();
      expect(myAccessLabel(t, row(true, "driver"), role)).toBeNull();
    }
  });
});
