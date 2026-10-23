import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleRoot } from "./ConsoleRoot";
import { createMockApi, type MockOptions } from "./mock/create-mock-client";

const visit = (path: string) => window.history.replaceState(null, "", path);
const open = (name: string | RegExp) =>
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });

beforeEach(() => {
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("min-width: 1024px"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  visit("/");
});

const mount = (options: MockOptions = {}) => {
  const api = createMockApi(options);
  render(<ConsoleRoot api={api} />);
  return api;
};
const h1 = () => screen.findByRole("heading", { level: 1 });

describe("控制台经客户端取会话", () => {
  it("me.get / me.spaces 的数据进空间切换和账号菜单", async () => {
    visit("/me");
    mount();
    expect((await h1()).textContent).toBe("概览");
    expect(screen.getAllByText("张三").length).toBeGreaterThan(0);
    open("个人空间");
    expect(await screen.findByText("研发组")).toBeTruthy();
    expect(screen.getByText("Lab")).toBeTruthy();
  });

  it("me.get 说邮箱没验证就显示提示；重发走 auth.emailVerifyResend，已验证没有提示", async () => {
    visit("/me");
    const api = mount({ emailVerified: false });
    const resend = vi.spyOn(api.client.auth, "emailVerifyResend");
    await h1();
    expect(screen.getByText("验证邮箱后才能登记主机和分享")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "重新发送验证邮件" }).click());
    await screen.findByRole("button", { name: "已发送" });
    expect(resend).toHaveBeenCalledTimes(1);
    cleanup();
    mount({ emailVerified: true });
    await h1();
    expect(screen.queryByText("验证邮箱后才能登记主机和分享")).toBeNull();
  });

  it("角色来自 me.spaces：member 进审计是「没有权限」，团队里没有的是找不到", async () => {
    visit("/t/rd/audit");
    mount({ roles: { rd: "member" } });
    expect((await h1()).textContent).toBe("没有权限执行这个操作");
    cleanup();
    visit("/t/ghost");
    mount();
    expect((await h1()).textContent).toBe("找不到这个页面");
  });

  it("没登录：me.get 答 session_expired，跳 /login 并带上 next，登录页渲染表单而不是「找不到」", async () => {
    visit("/t/rd/hosts?status=online");
    mount({ signedIn: false });
    expect((await h1()).textContent).toBe("登录");
    expect(window.location.pathname + window.location.search).toBe(
      `/login?next=${encodeURIComponent("/t/rd/hosts?status=online")}`,
    );
    expect(screen.getByLabelText("邮箱")).toBeTruthy();
  });

  it("使用中会话失效且续不上：清掉缓存，回 /login", async () => {
    visit("/me");
    const api = createMockApi();
    const lost = vi.spyOn(api, "onSessionLost");
    render(<ConsoleRoot api={api} />);
    await h1();
    const listener = lost.mock.calls[0]![0];
    act(() => listener());
    expect((await h1()).textContent).toBe("登录");
    expect(window.location.pathname).toBe("/login");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("取会话失败（非会话码）：按码出文案，重试再取一次", async () => {
    visit("/me");
    const api = createMockApi({ fail: { "me.get": "team_suspended" } });
    const get = vi.spyOn(api.client.me, "get");
    render(<ConsoleRoot api={api} />);
    expect((await h1()).textContent).toBe("团队已停用，联系支持");
    act(() => screen.getByRole("button", { name: "重试" }).click());
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("退出登录：撤销会话、清缓存、回 /login", async () => {
    visit("/me");
    const api = mount();
    const signOut = vi.spyOn(api, "signOut");
    await h1();
    open(/张三/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(signOut).toHaveBeenCalled();
  });
});

describe("运营后台门控", () => {
  it("没有运营会话访问 /ops/* 整页找不到，即便账号有运营范围", async () => {
    visit("/ops/nodes");
    mount({ operatorAccount: true });
    expect((await h1()).textContent).toBe("找不到这个页面");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("有运营范围的账号在账号菜单里去运营登录；普通账号菜单里没有这一项", async () => {
    visit("/me");
    mount({ operatorAccount: true });
    await h1();
    open(/张三/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "运营后台" }));
    expect(window.location.pathname + window.location.search).toBe(
      "/login?scope=operator&next=%2Fops",
    );
    cleanup();
    visit("/me");
    mount();
    await h1();
    open(/张三/);
    await screen.findByRole("menuitem", { name: "退出登录" });
    expect(screen.queryByRole("menuitem", { name: "运营后台" })).toBeNull();
  });

  it("运营会话在：进得去 /ops，菜单直达 /ops；会话到期（CSRF 清掉）立刻又是找不到", async () => {
    visit("/ops/nodes");
    const api = mount({ operatorAccount: true, operatorSession: true });
    expect((await h1()).textContent).toBe("节点");
    await act(() => api.signOut());
    expect((await h1()).textContent).toBe("找不到这个页面");
  });
});
