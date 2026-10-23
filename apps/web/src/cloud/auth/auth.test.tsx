import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleRoot } from "../ConsoleRoot";
import { CloudConsoleError } from "../api/errors";
import { createMockApi, type MockOptions } from "../mock/create-mock-client";
import { matchRoute } from "../router";
import { safeNext } from "./redirect";

const visit = (url: string) => window.history.replaceState(null, "", url);
const here = () => window.location.pathname + window.location.search;
const h1 = () => screen.findByRole("heading", { level: 1 });
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(() => {
  cleanup();
  localStorage.clear();
  visit("/");
});

const mount = (options: MockOptions = { signedIn: false }) => {
  const api = createMockApi(options);
  render(<ConsoleRoot api={api} />);
  return api;
};

describe("公开路由与云端托管路径一致", () => {
  it.each([
    ["/login", "login"],
    ["/register", "register"],
    ["/verify", "verify"],
    ["/reset", "reset"],
    ["/invite/inv_1", "invite"],
  ])("%s 是公开路由 %s", (path, id) => {
    expect(matchRoute(path)).toMatchObject({ id, area: "public" });
  });
});

describe("safeNext", () => {
  it("只认站内绝对路径", () => {
    expect(safeNext("/t/rd/hosts?a=1")).toBe("/t/rd/hosts?a=1");
    expect(safeNext("//evil.com")).toBeNull();
    expect(safeNext("/\\evil.com")).toBeNull();
    expect(safeNext("https://evil.com")).toBeNull();
    expect(safeNext("/login")).toBeNull();
    expect(safeNext(null)).toBeNull();
  });
});

describe("登录页", () => {
  it("未登录访问 /login 是登录表单，不是「找不到」，也不取会话", async () => {
    visit("/login");
    const api = createMockApi({ signedIn: false });
    const me = vi.spyOn(api.client.me, "get");
    render(<ConsoleRoot api={api} />);
    expect((await h1()).textContent).toBe("登录");
    expect(screen.queryByText("找不到这个页面")).toBeNull();
    expect(me).not.toHaveBeenCalled();
  });

  it("登录成功后回到 next；next 不是站内路径时回概览", async () => {
    visit(`/login?next=${encodeURIComponent("/t/rd/hosts")}`);
    const api = mount();
    const login = vi.spyOn(api.client.auth, "login");
    await h1();
    type("邮箱", "zed@example.com");
    type("口令", "correct horse");
    fireEvent.submit(screen.getByLabelText("邮箱").closest("form")!);
    await waitFor(() => expect(here()).toBe("/t/rd/hosts"));
    expect(login.mock.calls[0]![0]).toMatchObject({
      account: "zed@example.com",
      device: { platform: "browser" },
    });
    cleanup();
    visit("/login?next=//evil.com");
    mount();
    await h1();
    type("邮箱", "zed@example.com");
    type("口令", "x");
    fireEvent.submit(screen.getByLabelText("邮箱").closest("form")!);
    await waitFor(() => expect(here()).toMatch(/^\/(me|t\/)/));
  });

  it("登录失败显示错误文案并留在页面", async () => {
    visit("/login");
    mount({ signedIn: false, fail: { "auth.login": "credentials_invalid" } });
    await h1();
    type("邮箱", "zed@example.com");
    type("口令", "bad");
    fireEvent.submit(screen.getByLabelText("邮箱").closest("form")!);
    await screen.findByText("账号或口令不正确");
    expect(here()).toBe("/login");
  });

  it("运营登录给运营标题，不给注册入口", async () => {
    visit("/login?scope=operator");
    mount();
    expect((await h1()).textContent).toBe("运营登录");
    expect(screen.queryByText("没有账号？注册")).toBeNull();
  });
});

describe("注册页", () => {
  it("提交 auth.register 后进控制台", async () => {
    visit("/register");
    const api = mount();
    const register = vi.spyOn(api.client.auth, "register");
    await h1();
    type("邮箱", "new@example.com");
    type("名称", "New");
    type("口令", "a long passphrase");
    fireEvent.submit(screen.getByLabelText("邮箱").closest("form")!);
    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register.mock.calls[0]![0]).toMatchObject({
      email: "new@example.com",
      displayName: "New",
    });
  });
});

describe("邮件链接", () => {
  it("/verify#令牌：读片段、立刻从地址栏拿掉、POST auth.emailVerify", async () => {
    visit("/verify#tok123");
    const api = createMockApi({ signedIn: false });
    const verify = vi.spyOn(api.client.auth, "emailVerify");
    render(<ConsoleRoot api={api} />);
    await screen.findByText("邮箱已验证");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0]).toEqual({ token: "tok123" });
    expect(window.location.hash).toBe("");
  });

  it("/verify 没有令牌：提示链接不完整，不发请求", async () => {
    visit("/verify");
    const api = createMockApi({ signedIn: false });
    const verify = vi.spyOn(api.client.auth, "emailVerify");
    render(<ConsoleRoot api={api} />);
    await screen.findByText("链接不完整");
    expect(verify).not.toHaveBeenCalled();
  });

  it("/verify 令牌失效：出文案", async () => {
    visit("/verify#bad");
    mount({
      signedIn: false,
      fail: { "auth.emailVerify": "email_token_invalid" },
    });
    await screen.findByText("链接无效或已用过，重新获取");
  });

  it("/reset 无令牌：发 passwordResetStart，总是提示已发送", async () => {
    visit("/reset");
    const api = mount();
    const start = vi.spyOn(api.client.auth, "passwordResetStart");
    await h1();
    type("邮箱", "zed@example.com");
    fireEvent.submit(screen.getByLabelText("邮箱").closest("form")!);
    await screen.findByText("重置邮件已发送");
    expect(start.mock.calls[0]![0]).toEqual({ email: "zed@example.com" });
  });

  it("/reset#令牌：两次口令一致才提交 passwordResetFinish，成功去登录", async () => {
    visit("/reset#rt");
    const api = mount();
    const finish = vi.spyOn(api.client.auth, "passwordResetFinish");
    await h1();
    type("新口令", "a long passphrase");
    type("再输一次", "different");
    fireEvent.submit(screen.getByLabelText("新口令").closest("form")!);
    await screen.findByText("两次输入不一样");
    expect(finish).not.toHaveBeenCalled();
    type("再输一次", "a long passphrase");
    fireEvent.submit(screen.getByLabelText("新口令").closest("form")!);
    await screen.findByText("口令已设置");
    expect(finish.mock.calls[0]![0]).toEqual({
      token: "rt",
      newPassword: "a long passphrase",
    });
    act(() => screen.getByRole("button", { name: "去登录" }).click());
    expect(here()).toBe("/login");
  });

  it("/invite/:id#令牌：匿名取摘要；没登录点接受会带着 next 与片段去登录", async () => {
    visit("/invite/inv1#itok");
    const api = createMockApi({ signedIn: false });
    const get = vi.spyOn(api.client.invitations, "get");
    vi.spyOn(api.client.invitations, "accept").mockRejectedValue(
      new CloudConsoleError("unauthenticated", 401),
    );
    render(<ConsoleRoot api={api} />);
    await screen.findByRole("button", { name: "接受" });
    expect(get.mock.calls[0]![0]).toEqual({
      invitationId: "inv1",
      token: "itok",
    });
    act(() => screen.getByRole("button", { name: "接受" }).click());
    await waitFor(() => expect(here()).toContain("/login?next="));
    expect(decodeURIComponent(here())).toContain("/invite/inv1");
    expect(window.location.hash).toBe("#itok");
  });
});
