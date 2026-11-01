import * as React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleRoot } from "../ConsoleRoot";
import {
  createMockApi,
  MOCK_CAPABILITIES,
  type MockOptions,
} from "../mock/create-mock-client";
import { matchRoute } from "../router";
import { external, recalledOAuthNext } from "./redirect";

const visit = (url: string) => window.history.replaceState(null, "", url);
const h1 = () => screen.findByRole("heading", { level: 1 });

const BOTH = [
  ...MOCK_CAPABILITIES,
  "auth.oauth.github",
  "auth.oauth.google",
] as const;
const ONLY_OAUTH = [
  "auth.oauth.github",
  "auth.oauth.google",
  "auth.device-code",
  "me.stream",
] as const;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  visit("/");
});

const mount = (path: string, options: MockOptions = {}) => {
  visit(path);
  const api = createMockApi({ signedIn: false, ...options });
  render(<ConsoleRoot api={api} />);
  return api;
};

const button = (name: string) => screen.queryByRole("button", { name });

describe("登录页的第三方登录按钮", () => {
  it("没有 oauth 能力位：只有口令表单，没有 GitHub / Google", async () => {
    mount("/login");
    await screen.findByLabelText("邮箱");
    expect(button("使用 GitHub 继续")).toBeNull();
    expect(button("使用 Google 继续")).toBeNull();
    expect(screen.queryByText("或")).toBeNull();
  });

  it("按能力位出现：只开 GitHub 就只有 GitHub", async () => {
    mount("/login", {
      capabilities: [...MOCK_CAPABILITIES, "auth.oauth.github"],
    });
    await screen.findByRole("button", { name: "使用 GitHub 继续" });
    expect(button("使用 Google 继续")).toBeNull();
    expect(screen.getByLabelText("邮箱")).toBeTruthy();
  });

  it("口令与第三方并存：表单、分隔、两个全宽按钮，口令入口都在", async () => {
    mount("/login", { capabilities: BOTH });
    const github = await screen.findByRole("button", {
      name: "使用 GitHub 继续",
    });
    expect(
      screen.getByRole("button", { name: "使用 Google 继续" }),
    ).toBeTruthy();
    expect(github.className).toContain("w-full");
    expect(screen.getByLabelText("邮箱")).toBeTruthy();
    expect(screen.getByText("或")).toBeTruthy();
    expect(screen.getByRole("link", { name: "忘记口令" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "没有账号？注册" })).toBeTruthy();
  });

  it("服务端没有 auth.password：口令表单、找回口令、口令注册入口都隐藏", async () => {
    mount("/login", { capabilities: ONLY_OAUTH });
    await screen.findByRole("button", { name: "使用 GitHub 继续" });
    expect(screen.queryByLabelText("邮箱")).toBeNull();
    expect(screen.queryByLabelText("口令")).toBeNull();
    expect(screen.queryByRole("button", { name: "登录" })).toBeNull();
    expect(screen.queryByRole("link", { name: "忘记口令" })).toBeNull();
    expect(screen.queryByRole("link", { name: "没有账号？注册" })).toBeNull();
    expect(screen.queryByText("或")).toBeNull();
  });

  it("能力位还没取回来时不闪口令表单；取不到平台信息按旧服务端回退到口令", async () => {
    const api = createMockApi({ signedIn: false, capabilities: ONLY_OAUTH });
    vi.spyOn(api.client.platform, "info").mockRejectedValue(
      new TypeError("offline"),
    );
    visit("/login");
    render(<ConsoleRoot api={api} />);
    await h1();
    expect(screen.queryByLabelText("邮箱")).toBeNull();
    expect(await screen.findByLabelText("邮箱")).toBeTruthy();
    expect(button("使用 GitHub 继续")).toBeNull();
  });

  it("运营登录保留口令 + 两步验证，不受能力位影响，也没有第三方按钮", async () => {
    mount("/login?scope=operator", {
      operatorAccount: true,
      capabilities: ONLY_OAUTH,
    });
    expect((await h1()).textContent).toBe("运营登录");
    expect(await screen.findByLabelText("邮箱")).toBeTruthy();
    expect(screen.getByLabelText("口令")).toBeTruthy();
    expect(button("使用 GitHub 继续")).toBeNull();
    expect(button("使用 Google 继续")).toBeNull();
  });

  it("点击：存 next、取授权地址（回跳地址是 /login/oauth/<提供方>）、整页跳过去", async () => {
    const go = vi.spyOn(external, "go").mockImplementation(() => undefined);
    const next = "/t/rd/hosts?status=online";
    const api = mount(`/login?next=${encodeURIComponent(next)}`, {
      capabilities: BOTH,
    });
    const start = vi.spyOn(api.client.auth, "oauthStart");
    fireEvent.click(
      await screen.findByRole("button", { name: "使用 GitHub 继续" }),
    );
    await vi.waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith({
      provider: "github",
      redirectUri: `${window.location.origin}/login/oauth/github`,
    });
    expect(go.mock.calls[0]![0]).toContain("https://github.test/");
    expect(recalledOAuthNext()).toBe(next);
  });

  it("设备码批准页的落点原样保留", async () => {
    const go = vi.spyOn(external, "go").mockImplementation(() => undefined);
    mount(`/login?next=${encodeURIComponent("/device?code=ABCD-EFGH")}`, {
      capabilities: BOTH,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "使用 Google 继续" }),
    );
    await vi.waitFor(() => expect(go).toHaveBeenCalled());
    expect(go.mock.calls[0]![0]).toContain("https://google.test/");
    expect(recalledOAuthNext()).toBe("/device?code=ABCD-EFGH");
  });

  it("没有 next：清掉上一次留下的落点，不串到这次登录", async () => {
    vi.spyOn(external, "go").mockImplementation(() => undefined);
    sessionStorage.setItem("armadra.cloud.oauthNext", "/t/old/hosts");
    mount("/login", { capabilities: BOTH });
    fireEvent.click(
      await screen.findByRole("button", { name: "使用 GitHub 继续" }),
    );
    await vi.waitFor(() => expect(recalledOAuthNext()).toBeNull());
  });

  it("取授权地址失败：按码出文案，不跳走，可再点", async () => {
    const go = vi.spyOn(external, "go").mockImplementation(() => undefined);
    mount("/login", {
      capabilities: BOTH,
      fail: { "auth.oauthStart": "rate_limited" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "使用 GitHub 继续" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
    expect((button("使用 GitHub 继续") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("授权地址不是 http(s) 不跳", async () => {
    const go = vi.spyOn(external, "go").mockImplementation(() => undefined);
    const api = mount("/login", { capabilities: BOTH });
    vi.spyOn(api.client.auth, "oauthStart").mockResolvedValue({
      authorizationUrl: "javascript:alert(1)",
      state: "s",
      expiresAtMs: Date.now() + 1000,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "使用 GitHub 继续" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
  });
});

describe("注册页的第三方登录按钮", () => {
  it("口令与第三方并存：表单加两个按钮", async () => {
    mount("/register", { capabilities: BOTH });
    await screen.findByRole("button", { name: "使用 GitHub 继续" });
    expect(
      screen.getByRole("button", { name: "使用 Google 继续" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("名称")).toBeTruthy();
    expect(screen.getByText("或")).toBeTruthy();
  });

  it("没有 auth.password：只有按钮和「登录」入口，没有口令注册表单", async () => {
    mount("/register", { capabilities: ONLY_OAUTH });
    await screen.findByRole("button", { name: "使用 GitHub 继续" });
    expect(screen.queryByLabelText("口令")).toBeNull();
    expect(screen.queryByLabelText("名称")).toBeNull();
    expect(screen.getByRole("link", { name: "已有账号？登录" })).toBeTruthy();
  });

  it("没有 oauth 能力位：照旧只有口令注册", async () => {
    mount("/register");
    await screen.findByLabelText("名称");
    expect(button("使用 GitHub 继续")).toBeNull();
  });

  it("点击带着 next 走同一条授权流程", async () => {
    const go = vi.spyOn(external, "go").mockImplementation(() => undefined);
    mount(`/register?next=${encodeURIComponent("/j/lnk1")}`, {
      capabilities: BOTH,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "使用 GitHub 继续" }),
    );
    await vi.waitFor(() => expect(go).toHaveBeenCalled());
    expect(recalledOAuthNext()).toBe("/j/lnk1");
  });
});

describe("回跳页 /login/oauth/:provider", () => {
  const here = () => window.location.pathname + window.location.search;
  const NEXT_KEY = "armadra.cloud.oauthNext";
  const callback = (
    options: MockOptions = {},
    query = "code=c1&state=s1",
    provider = "github",
  ) => {
    const api = mount(`/login/oauth/${provider}?${query}`, {
      capabilities: BOTH,
      ...options,
    });
    return { api, finish: vi.spyOn(api.client.auth, "oauthFinish") };
  };

  it("是公开路由，不取会话", () => {
    expect(matchRoute("/login/oauth/github")).toMatchObject({
      id: "oauth",
      area: "public",
      params: { provider: "github" },
    });
  });

  it("成功：带 code、state、设备调 oauthFinish，进存下的 next，清掉存值和地址栏参数", async () => {
    sessionStorage.setItem(NEXT_KEY, "/t/rd/hosts?status=online");
    visit("/");
    const api = createMockApi({ signedIn: false, capabilities: BOTH });
    const finish = vi.spyOn(api.client.auth, "oauthFinish");
    const me = vi.spyOn(api.client.me, "get");
    visit("/login/oauth/github?code=c1&state=s1");
    render(<ConsoleRoot api={api} />);
    await waitFor(() => expect(here()).toBe("/t/rd/hosts?status=online"));
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0]![0]).toMatchObject({
      provider: "github",
      state: "s1",
      code: "c1",
      device: { platform: "browser" },
    });
    expect(sessionStorage.getItem(NEXT_KEY)).toBeNull();
    // 回跳页本身不取会话：登录完成才开始取。
    expect(me.mock.invocationCallOrder[0]).toBeGreaterThan(
      finish.mock.invocationCallOrder[0]!,
    );
  });

  it("没有存下的 next 回 /me；存的不是站内路径也回 /me", async () => {
    callback();
    await waitFor(() => expect(here()).toBe("/me"));
    cleanup();
    sessionStorage.setItem(NEXT_KEY, "//evil.com");
    callback();
    await waitFor(() => expect(here()).toBe("/me"));
  });

  it("设备码批准页的落点：登录后回到 /device?code=…", async () => {
    sessionStorage.setItem(NEXT_KEY, "/device?code=ABCD-EFGH");
    callback();
    await waitFor(() => expect(here()).toBe("/device?code=ABCD-EFGH"));
    expect(sessionStorage.getItem(NEXT_KEY)).toBeNull();
  });

  it("主机画布的落点 /h/<主机> 整页跳过去", async () => {
    sessionStorage.setItem(NEXT_KEY, "/h/host1");
    const replace = vi.fn();
    visit("/login/oauth/github?code=c1&state=s1");
    vi.stubGlobal("location", { ...window.location, replace, assign: replace });
    const api = createMockApi({ signedIn: false, capabilities: BOTH });
    render(<ConsoleRoot api={api} />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/h/host1"));
  });

  it("严格模式下只发一次 oauthFinish（state 一次性）", async () => {
    visit("/login/oauth/google?code=c1&state=s1");
    const api = createMockApi({ signedIn: false, capabilities: BOTH });
    const finish = vi.spyOn(api.client.auth, "oauthFinish");
    render(
      <React.StrictMode>
        <ConsoleRoot api={api} />
      </React.StrictMode>,
    );
    await waitFor(() => expect(here()).toBe("/me"));
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("两步验证挑战：进第二步，验证后进 next", async () => {
    sessionStorage.setItem(NEXT_KEY, "/t/rd/hosts");
    const { api } = callback({ oauthFinish: "mfa" });
    const verify = vi.spyOn(api.client.auth, "mfaVerify");
    await screen.findByLabelText("验证码");
    fireEvent.change(screen.getByLabelText("验证码"), {
      target: { value: "123456" },
    });
    fireEvent.submit(screen.getByLabelText("验证码").closest("form")!);
    await waitFor(() => expect(here()).toBe("/t/rd/hosts"));
    expect(verify.mock.calls[0]![0]).toMatchObject({
      challengeId: "mock-mfa",
      code: "123456",
    });
    expect(sessionStorage.getItem(NEXT_KEY)).toBeNull();
  });

  it("两步验证码不对：留在第二步显示文案", async () => {
    const { api } = callback({ oauthFinish: "mfa" });
    vi.spyOn(api.client.auth, "mfaVerify").mockRejectedValue(
      Object.assign(new Error("x"), { status: 401, code: "mfa_invalid" }),
    );
    fireEvent.change(await screen.findByLabelText("验证码"), {
      target: { value: "000000" },
    });
    fireEvent.submit(screen.getByLabelText("验证码").closest("form")!);
    await waitFor(() =>
      expect(screen.getByLabelText("验证码").getAttribute("aria-invalid")).toBe(
        "true",
      ),
    );
    expect(here().startsWith("/login/oauth/")).toBe(true);
  });

  it.each([
    [
      "邮箱已有口令账号",
      { error: "conflict", details: { reason: "account_exists" } },
      "该邮箱已有账号，请用原方式登录",
    ],
    [
      "state 过期或不符",
      { error: "credentials_invalid" },
      "登录已过期，请重新登录",
    ],
    ["登录方式未开放", { error: "not_found" }, "该登录方式未开放"],
    ["提供方邮箱未验证", { error: "email_unverified" }, "先验证邮箱再继续"],
    ["账号已停用", { error: "account_disabled" }, "账号已停用，联系支持"],
    ["暂停注册", { error: "registrations_paused" }, "暂停注册"],
  ])(
    "失败（%s）：按码出文案，保留 next 的「返回登录」",
    async (_name, error, text) => {
      sessionStorage.setItem(NEXT_KEY, "/device?code=ABCD-EFGH");
      callback({ oauthFinish: error });
      expect(await screen.findByText(text)).toBeTruthy();
      expect(here()).toBe("/login/oauth/github");
      const back = screen.getByRole("link", { name: "返回登录" });
      expect(back.getAttribute("href")).toBe(
        `/login?next=${encodeURIComponent("/device?code=ABCD-EFGH")}`,
      );
      fireEvent.click(back);
      await waitFor(() => expect(here()).toContain("/login?next="));
      expect((await h1()).textContent).toBe("登录");
    },
  );

  it("没有 next 的失败：返回登录是 /login", async () => {
    callback({ oauthFinish: { error: "credentials_invalid" } });
    await screen.findByText("登录已过期，请重新登录");
    expect(
      screen.getByRole("link", { name: "返回登录" }).getAttribute("href"),
    ).toBe("/login");
  });

  it("提供方回传 error=access_denied（用户取消）：提示已取消，不调 oauthFinish", async () => {
    const { finish } = callback({}, "error=access_denied&state=s1");
    await screen.findByText("已取消登录");
    expect(finish).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "返回登录" })).toBeTruthy();
  });

  it("提供方的其他 error：通用文案", async () => {
    const { finish } = callback({}, "error=server_error&state=s1");
    await screen.findByText("核心处理这个请求时失败");
    expect(finish).not.toHaveBeenCalled();
  });

  it("缺 code 或 state：当作过期，不调 oauthFinish", async () => {
    const { finish } = callback({}, "code=c1");
    await screen.findByText("登录已过期，请重新登录");
    expect(finish).not.toHaveBeenCalled();
  });

  it("不认识的提供方：未开放，不调 oauthFinish", async () => {
    const { finish } = callback({}, "code=c1&state=s1", "gitlab");
    await screen.findByText("该登录方式未开放");
    expect(finish).not.toHaveBeenCalled();
  });

  it("code、state 读出来就从地址栏拿掉", async () => {
    callback({ oauthFinish: { error: "credentials_invalid" } });
    await screen.findByText("登录已过期，请重新登录");
    expect(window.location.search).toBe("");
  });
});
