import { afterEach, describe, expect, it } from "vitest";

import { matchRoute } from "../router";
import {
  gate,
  homePath,
  navHref,
  NAV,
  rememberSpace,
  visibleNav,
  type ConsoleTeam,
  type TeamRole,
} from "./model";

const teams: ConsoleTeam[] = [
  { slug: "rd", name: "R", role: "admin" },
  { slug: "bill", name: "B", role: "billing" },
];
const at = (path: string) => matchRoute(path);

afterEach(() => localStorage.clear());

describe("gate", () => {
  it("没有运营会话访问 /ops/* 与不认识的路径一样整页找不到", () => {
    for (const path of ["/ops", "/ops/nodes", "/ops/tenants/t1"]) {
      expect(gate(at(path), { teams, operator: false })).toBe("notFound");
      expect(gate(at(path), { teams, operator: true })).toBe("ok");
    }
    expect(gate(at("/nope"), { teams, operator: true })).toBe("notFound");
  });

  it("团队不存在是找不到，角色看不到的页是没有权限", () => {
    const context = { teams, operator: false };
    expect(gate(at("/t/ghost"), context)).toBe("notFound");
    expect(gate(at("/t/rd/audit"), context)).toBe("ok");
    expect(gate(at("/t/bill/hosts"), context)).toBe("forbidden");
    expect(gate(at("/t/bill/billing"), context)).toBe("ok");
  });

  it("个人空间与其余路由放行", () => {
    expect(gate(at("/me/links"), { teams: [], operator: false })).toBe("ok");
  });
});

describe("导航可见性（§2.4）", () => {
  const ids = (role: TeamRole) =>
    visibleNav("team", role).map((entry) => entry.id);

  it("按角色裁剪", () => {
    expect(ids("owner")).toHaveLength(NAV.team.length);
    expect(ids("member")).not.toContain("audit");
    expect(ids("member")).toContain("members");
    expect(ids("billing")).toEqual([
      "overview",
      "members",
      "billing",
      "settings",
    ]);
    expect(ids("guest")).toEqual(["overview", "hosts", "trust", "settings"]);
  });

  it("个人空间与运营后台不看角色", () => {
    expect(visibleNav("personal")).toHaveLength(5);
    expect(visibleNav("ops").map((entry) => entry.id)).toContain("flags");
  });

  it("地址：概览是空间根，其余加一段", () => {
    const [overview, hosts] = NAV.team;
    expect(navHref("team", overview!, "rd")).toBe("/t/rd");
    expect(navHref("team", hosts!, "rd")).toBe("/t/rd/hosts");
    expect(navHref("personal", NAV.personal[3]!)).toBe("/me/account");
    expect(navHref("ops", NAV.ops[0]!)).toBe("/ops");
    expect(navHref("ops", NAV.ops[1]!)).toBe("/ops/nodes");
  });
});

describe("上次的空间", () => {
  it("`/` 跳到记下的团队；失效或没有回个人空间", () => {
    expect(homePath(teams)).toBe("/me");
    rememberSpace(at("/t/rd/members"));
    expect(homePath(teams)).toBe("/t/rd");
    expect(homePath([])).toBe("/me");
    rememberSpace(at("/me/links"));
    expect(homePath(teams)).toBe("/me");
    rememberSpace(at("/ops"));
    expect(localStorage.getItem("armadra.cloud.space")).toBe("me");
  });
});
