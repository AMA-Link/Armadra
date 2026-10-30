import { describe, expect, it } from "vitest";

import { myAccessLabel, myAccessOf } from "./data";

const t = (key: string) => key;
/** 协议包 0.10 的类型里没有 `myRole`：按服务端的原样对象传。 */
const row = (owner: boolean, myRole: unknown) => ({ owner, myRole });

describe("myAccessOf：sourceSummary.myRole 的四种取值", () => {
  it("缺省（旧服务端、个人空间、链接访客）：不显示，所有者也一样", () => {
    expect(myAccessOf({ owner: false })).toBeNull();
    expect(myAccessOf({ owner: true })).toBeNull();
    expect(myAccessLabel(t, { owner: false })).toBeNull();
  });

  it("null：看得到但没有有效权限", () => {
    const host = { owner: false, myRole: null };
    expect(myAccessOf(host)).toEqual({ kind: "none" });
    expect(myAccessLabel(t, host)).toBe("cloud.hosts.myAccessNone");
  });

  it("四档角色：复用 workspaceGroups.role.* 的文案", () => {
    for (const role of ["viewer", "editor", "operator", "driver"]) {
      const host = { owner: false, myRole: role };
      expect(myAccessOf(host)).toEqual({ kind: "role", role });
      expect(myAccessLabel(t, host)).toBe(`workspaceGroups.role.${role}`);
    }
  });

  it("owner: true：显示「所有者」，不用 myRole 的 driver", () => {
    const host = { owner: true, myRole: "driver" };
    expect(myAccessOf(host)).toEqual({ kind: "owner" });
    expect(myAccessLabel(t, host)).toBe("cloud.hosts.owner");
    expect(myAccessOf(row(true, null))).toEqual({
      kind: "owner",
    });
  });

  it("认不出的值当没报", () => {
    expect(myAccessOf(row(false, "admin"))).toBeNull();
    expect(myAccessOf(row(false, 3))).toBeNull();
  });
});
