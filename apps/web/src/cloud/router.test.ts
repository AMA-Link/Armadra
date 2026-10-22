import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { matchRoute, navigate, spacePath, useRoute } from "./router";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("matchRoute", () => {
  it("按路由表认出页面、参数与侧栏项", () => {
    expect(matchRoute("/")).toMatchObject({ id: "home", area: "home" });
    expect(matchRoute("/me/hosts/h1")).toMatchObject({
      id: "meHost",
      area: "personal",
      nav: "hosts",
      params: { host: "h1" },
    });
    expect(matchRoute("/t/rd/members/")).toMatchObject({
      id: "teamMembers",
      area: "team",
      nav: "members",
      params: { team: "rd" },
    });
    expect(matchRoute("/ops/tenants/t9")).toMatchObject({
      id: "opsTenant",
      area: "ops",
      nav: "tenants",
      params: { id: "t9" },
    });
    expect(matchRoute("/login")).toMatchObject({ area: "public", nav: null });
  });

  it("筛选、页签、游标进查询参数", () => {
    const match = matchRoute("/t/rd/hosts", "?status=online&tab=access");
    expect(match?.query.get("status")).toBe("online");
    expect(match?.query.get("tab")).toBe("access");
  });

  it("认不出的路径、多一段的路径、坏转义都是 null", () => {
    expect(matchRoute("/nope")).toBeNull();
    expect(matchRoute("/me/hosts/h1/extra")).toBeNull();
    expect(matchRoute("/t/%E0%A4%A/hosts")).toBeNull();
  });

  it("团队地址里的转义被还原", () => {
    expect(matchRoute("/t/a%20b")?.params.team).toBe("a b");
    expect(spacePath({ team: "a b" })).toBe("/t/a%20b");
    expect(spacePath("me")).toBe("/me");
  });
});

describe("useRoute", () => {
  it("navigate 改地址并让订阅者重渲染；replace 不留历史", () => {
    window.history.replaceState(null, "", "/me");
    const { result } = renderHook(() => useRoute());
    expect(result.current?.id).toBe("me");
    const length = window.history.length;
    act(() => navigate("/t/rd/audit?cursor=9"));
    expect(result.current).toMatchObject({ id: "teamAudit" });
    expect(result.current?.query.get("cursor")).toBe("9");
    expect(window.history.length).toBe(length + 1);
    act(() => navigate("/ops", { replace: true }));
    expect(result.current?.id).toBe("ops");
    expect(window.history.length).toBe(length + 1);
  });

  it("后退（popstate）也会更新", () => {
    window.history.replaceState(null, "", "/me");
    const { result } = renderHook(() => useRoute());
    act(() => {
      window.history.replaceState(null, "", "/me/links");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current?.id).toBe("meLinks");
  });
});
