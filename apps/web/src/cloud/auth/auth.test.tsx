import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { readJsonFixture } from "@armadra/platform-protocol/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleRoot } from "../ConsoleRoot";
import { createCloudApi } from "../api/client";
import { CSRF_HEADER } from "../api/session";
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

  it("/invite/:id#令牌：令牌读进内存并立刻离开地址栏；没登录点接受去登录，地址里没有令牌，登录后回邀请页再用同一令牌接受", async () => {
    visit("/invite/inv1#itok");
    const api = createMockApi({ signedIn: false });
    const preview = vi.spyOn(api, "invitationPreview");
    const accept = vi.spyOn(api.client.invitations, "accept");
    render(<ConsoleRoot api={api} />);
    await screen.findByRole("button", { name: "接受" });
    expect(preview.mock.calls[0]).toEqual(["inv1", "itok"]);
    expect(window.location.hash).toBe("");
    const before = window.history.length;
    act(() => screen.getByRole("button", { name: "接受" }).click());
    await waitFor(() => expect(here()).toContain("/login?next="));
    expect(decodeURIComponent(here())).toContain("/invite/inv1");
    expect(window.location.hash).toBe("");
    // replace：不多一条 /invite 历史
    expect(window.history.length).toBe(before);
    expect(accept).not.toHaveBeenCalled();
    await h1();
    type("邮箱", "zed@example.com");
    type("口令", "correct horse");
    fireEvent.submit(screen.getByLabelText("邮箱").closest("form")!);
    await waitFor(() => expect(here()).toBe("/invite/inv1"));
    expect(window.location.hash).toBe("");
    act(() => screen.getByRole("button", { name: "接受" }).click());
    await waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
    expect(accept.mock.calls[0]![0]).toEqual({
      invitationId: "inv1",
      token: "itok",
    });
  });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const fx = (name: string) =>
  readJsonFixture<{ output?: unknown; outputs?: unknown[] }>(
    `cloud-api/${name}.json`,
  );

/** 假来源：记下每次请求（方法、路径、查询、CSRF 头、请求体）。 */
function origin(routes: Record<string, () => Response>) {
  const seen: {
    method: string;
    path: string;
    search: string;
    csrf: string | null;
    body: string;
  }[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    seen.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      csrf: request.headers.get(CSRF_HEADER),
      body: await request.clone().text(),
    });
    const route = routes[`${request.method} ${url.pathname}`];
    return route ? route() : json({ code: "not_found", message: "x" }, 404);
  }) as unknown as typeof fetch;
  return { seen, fetcher };
}
const SESSION = fx("auth.refresh").output as object;
const PREVIEW = fx("invitations.get").output;

describe("运营登录走运营客户端（真实 cloud fetch）", () => {
  it("login 写进运营 CSRF、运营会话生效，控制台 CSRF 不变", async () => {
    visit("/login?scope=operator");
    const { seen, fetcher } = origin({
      "GET /v1/me": () =>
        json({ ...(fx("me.get").output as object), csrfToken: "console-csrf" }),
      "POST /v1/auth/login": () => json({ ...SESSION, csrfToken: "ops-csrf" }),
      "POST /v1/me/email": () => json({}),
    });
    const api = createCloudApi({ origin: "http://app.test", fetch: fetcher });
    await api.client.me.get({});
    expect(api.operator.active()).toBe(false);
    render(<ConsoleRoot api={api} />);
    await h1();
    type("邮箱", "ops@example.com");
    type("口令", "correct horse");
    fireEvent.submit(screen.getByLabelText("邮箱").closest("form")!);
    await waitFor(() => expect(api.operator.active()).toBe(true));
    expect(seen.find((r) => r.path === "/v1/auth/login")!.body).toContain(
      '"scope":"operator"',
    );
    // 控制台写操作仍带控制台的 CSRF，没被运营值盖掉。
    await api.client.me.emailChange({ newEmail: "x@y.test", password: "p" });
    expect(seen.filter((r) => r.path === "/v1/me/email")[0]!.csrf).toBe(
      "console-csrf",
    );
  });
});

describe("邀请页写操作与预览（真实 cloud fetch）", () => {
  const mountInvite = (routes: Record<string, () => Response>) => {
    visit("/invite/inv1#itok");
    const o = origin({
      "POST /v1/invitations/inv1/preview": () => json(PREVIEW),
      ...routes,
    });
    render(
      <ConsoleRoot
        api={createCloudApi({ origin: "http://app.test", fetch: o.fetcher })}
      />,
    );
    return o;
  };

  it("预览是 POST /preview，令牌在请求体里，不在查询里", async () => {
    const { seen } = mountInvite({});
    await screen.findByRole("button", { name: "接受" });
    const call = seen.find((r) => r.path.endsWith("/preview"))!;
    expect(call.method).toBe("POST");
    expect(call.search).toBe("");
    expect(JSON.parse(call.body)).toEqual({ token: "itok" });
    expect(
      seen.some((r) => r.method === "GET" && r.path.includes("inv1")),
    ).toBe(false);
  });

  it("CSRF 为空：接受前先 auth.refresh，随后的 accept 带上它给的 csrfToken", async () => {
    const { seen } = mountInvite({
      "POST /v1/auth/refresh": () => json({ ...SESSION, csrfToken: "fresh" }),
      "POST /v1/invitations/inv1/accept": () => json({}),
    });
    await screen.findByRole("button", { name: "接受" });
    act(() => screen.getByRole("button", { name: "接受" }).click());
    await screen.findByText("已接受");
    const order = seen.map((r) => r.path);
    expect(order.indexOf("/v1/auth/refresh")).toBeLessThan(
      order.indexOf("/v1/invitations/inv1/accept"),
    );
    expect(seen.find((r) => r.path.endsWith("/accept"))!.csrf).toBe("fresh");
  });

  it("refresh 失败：带 next 去登录，不发 accept，也不显示「没有权限」", async () => {
    const { seen } = mountInvite({
      "POST /v1/auth/refresh": () =>
        json({ code: "session_expired", message: "x" }, 401),
    });
    await screen.findByRole("button", { name: "接受" });
    act(() => screen.getByRole("button", { name: "接受" }).click());
    await waitFor(() => expect(here()).toContain("/login?next="));
    expect(seen.some((r) => r.path.endsWith("/accept"))).toBe(false);
    expect(screen.queryByText("没有权限执行这个操作")).toBeNull();
  });

  it("未登录先拿到 403：同样走登录分支", async () => {
    mountInvite({
      "POST /v1/auth/refresh": () => json({ ...SESSION, csrfToken: "c" }),
      "POST /v1/invitations/inv1/accept": () =>
        json({ code: "forbidden", message: "x" }, 403),
    });
    await screen.findByRole("button", { name: "接受" });
    act(() => screen.getByRole("button", { name: "接受" }).click());
    await waitFor(() => expect(here()).toContain("/login?next="));
    expect(screen.queryByText("没有权限执行这个操作")).toBeNull();
  });
});

describe("挑战令牌", () => {
  it("有 siteKey 时每次登录失败都换一个新令牌（组件重建），不复用旧的", async () => {
    const turnstile = await import("../../challenge/turnstile");
    let issued = 0;
    vi.spyOn(turnstile, "loadTurnstile").mockResolvedValue({
      render: (_el: unknown, options: { callback: (t: string) => void }) => {
        options.callback(`tok${++issued}`);
        return `w${issued}`;
      },
      remove: () => undefined,
    } as never);
    visit("/login");
    const api = createMockApi({
      signedIn: false,
      fail: { "auth.login": "credentials_invalid" },
    });
    vi.spyOn(api.client.platform, "info").mockResolvedValue({
      ...(fx("platform.info").output as object),
      challenge: { provider: "turnstile", siteKey: "k", scope: ["auth.login"] },
    } as never);
    const login = vi.spyOn(api.client.auth, "login");
    render(<ConsoleRoot api={api} />);
    await h1();
    type("邮箱", "zed@example.com");
    type("口令", "x");
    const submit = () =>
      fireEvent.submit(screen.getByLabelText("邮箱").closest("form")!);
    await waitFor(() => expect(issued).toBe(1));
    submit();
    await screen.findByText("账号或口令不正确");
    await waitFor(() => expect(issued).toBe(2));
    type("口令", "y");
    submit();
    await waitFor(() => expect(login).toHaveBeenCalledTimes(2));
    expect(login.mock.calls.map((c) => c[0].challenge?.token)).toEqual([
      "tok1",
      "tok2",
    ]);
  });
});
