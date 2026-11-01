import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleRoot } from "../ConsoleRoot";
import {
  createMockApi,
  MOCK_CAPABILITIES,
  type MockOptions,
} from "../mock/create-mock-client";
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
