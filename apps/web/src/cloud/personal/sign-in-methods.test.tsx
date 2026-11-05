import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { external } from "../auth/redirect";
import {
  recalledOAuthIntent,
  rememberOAuthIntent,
  takePendingAction,
} from "../auth/oauth-intent";
import {
  MOCK_CAPABILITIES,
  MOCK_OAUTH_STATE,
} from "../mock/create-mock-client";
import { mount, installConsoleHarness } from "../testkit";

installConsoleHarness();
afterEach(() => vi.restoreAllMocks());

const CAPS = [
  ...MOCK_CAPABILITIES,
  "auth.oauth.github",
  "auth.oauth.google",
  "auth.oauth-link",
  "auth.step-up-oauth",
] as const;
const SECURITY = "/me/account?tab=security";
const here = () => window.location.pathname + window.location.search;

describe("账号 · 登录方式", () => {
  it("每个开放的提供方一行：已绑的给登录名与「解绑」，没绑的给「绑定」", async () => {
    mount(SECURITY, { capabilities: CAPS, linkedProviders: ["github"] });
    const group = await screen.findByRole("heading", { name: "登录方式" });
    expect(group).toBeTruthy();
    expect(await screen.findByText("mock-github")).toBeTruthy();
    expect(screen.getByRole("button", { name: "解绑" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "绑定" })).toBeTruthy();
  });

  it("服务端不报 auth.oauth-link：没有绑定按钮", async () => {
    mount(SECURITY, {
      capabilities: [...MOCK_CAPABILITIES, "auth.oauth.github"],
    });
    await screen.findByRole("button", { name: "更改口令" });
    expect(screen.queryByRole("button", { name: "绑定" })).toBeNull();
  });

  it("最后一种登录方式的「解绑」禁用；有口令时可解", async () => {
    mount(SECURITY, {
      capabilities: CAPS,
      linkedProviders: ["github"],
      hasPassword: false,
    });
    const unlink = await screen.findByRole("button", { name: "解绑" });
    expect((unlink as HTMLButtonElement).disabled).toBe(true);
  });

  it("绑定：没提权先弹再验证，口令通过后重试，整页跳去提供方并存下意图", async () => {
    const go = vi.spyOn(external, "go").mockImplementation(() => undefined);
    const api = mount(SECURITY, { capabilities: CAPS });
    const stepUp = vi.spyOn(api.client.auth, "stepUp");
    const start = vi.spyOn(api.client.auth, "oauthLinkStart");
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "绑定" }))[0]!,
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await within(dialog).findByLabelText("口令"), {
      target: { value: "right" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "验证并授权" }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(stepUp).toHaveBeenCalledWith({ password: "right" });
    expect(start).toHaveBeenCalledTimes(2);
    expect(String(go.mock.calls[0]![0])).toContain(MOCK_OAUTH_STATE);
    expect(recalledOAuthIntent()).toMatchObject({
      intent: { purpose: "link", provider: "github" },
      returnTo: SECURITY,
    });
  });

  it("关掉再验证：放弃，不跳转也不报错", async () => {
    const go = vi.spyOn(external, "go").mockImplementation(() => undefined);
    mount(SECURITY, { capabilities: CAPS });
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "绑定" }))[0]!,
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "返回" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(go).not.toHaveBeenCalled();
  });

  it("解绑：确认后没提权 → 再验证（已绑的提供方可用）→ 跳去提供方，意图带着待续的解绑", async () => {
    const go = vi.spyOn(external, "go").mockImplementation(() => undefined);
    mount(SECURITY, { capabilities: CAPS, linkedProviders: ["github"] });
    fireEvent.click(await screen.findByRole("button", { name: "解绑" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "解绑" }));
    const dialog = await screen.findByRole("dialog", { name: "再验证一次" });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "改用已绑定的账号" }),
    );
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "用 GitHub 验证" }),
    );
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(recalledOAuthIntent()).toMatchObject({
      intent: { purpose: "reauth", provider: "github" },
      returnTo: SECURITY,
      action: { kind: "unlinkProvider", provider: "github" },
    });
  });

  it("只有第三方登录的账号：再验证只列已绑定的提供方", async () => {
    mount(SECURITY, {
      capabilities: CAPS,
      linkedProviders: ["github"],
      hasPassword: false,
    });
    fireEvent.click(await screen.findByRole("button", { name: "绑定" }));
    const dialog = await screen.findByRole("dialog", { name: "再验证一次" });
    expect(
      await within(dialog).findByRole("button", { name: "用 GitHub 验证" }),
    ).toBeTruthy();
    expect(within(dialog).queryByLabelText("口令")).toBeNull();
  });
});

describe("回跳页按意图分派", () => {
  it("提权：调 auth.stepUp { oauth }，回原页面，待续的解绑自动接着做", async () => {
    rememberOAuthIntent({ purpose: "reauth", provider: "github" }, SECURITY, {
      kind: "unlinkProvider",
      provider: "github",
    });
    const api = mount(`/login/oauth/github?code=c1&state=${MOCK_OAUTH_STATE}`, {
      capabilities: CAPS,
      linkedProviders: ["github", "google"],
    });
    const stepUp = vi.spyOn(api.client.auth, "stepUp");
    const unlink = vi.spyOn(api.client.auth, "oauthUnlink");
    await waitFor(() => expect(here()).toBe(SECURITY));
    expect(stepUp).toHaveBeenCalledWith({
      oauth: { provider: "github", state: MOCK_OAUTH_STATE, code: "c1" },
    });
    await waitFor(() =>
      expect(unlink).toHaveBeenCalledWith({ provider: "github" }),
    );
    expect(await screen.findAllByText("已解绑 GitHub")).toBeTruthy();
    expect(recalledOAuthIntent()).toBeNull();
    expect(takePendingAction(["unlinkProvider"])).toBeNull();
  });

  it("绑定：调 auth.oauthLinkFinish，提示已绑定，回原页面", async () => {
    rememberOAuthIntent({ purpose: "link", provider: "google" }, SECURITY);
    const api = mount(`/login/oauth/google?code=c2&state=${MOCK_OAUTH_STATE}`, {
      capabilities: CAPS,
      elevated: true,
    });
    const finish = vi.spyOn(api.client.auth, "oauthLinkFinish");
    await waitFor(() => expect(here()).toBe(SECURITY));
    expect(finish).toHaveBeenCalledWith({
      provider: "google",
      state: MOCK_OAUTH_STATE,
      code: "c2",
    });
    expect(await screen.findAllByText("已绑定 Google")).toBeTruthy();
    expect(await screen.findByText("mock-google")).toBeTruthy();
  });

  it("绑定失败：身份已属他人 / 已绑过同类，给出对应文案和「返回账号」", async () => {
    rememberOAuthIntent({ purpose: "link", provider: "google" }, SECURITY);
    mount(`/login/oauth/google?code=c2&state=${MOCK_OAUTH_STATE}`, {
      capabilities: CAPS,
      elevated: true,
      linkFinish: { error: "conflict", details: { reason: "identity_linked" } },
    });
    expect(await screen.findByText("该账号已绑定到其他用户")).toBeTruthy();
    const back = screen.getByRole("link", { name: "返回账号" });
    expect(back.getAttribute("href")).toBe(SECURITY);
  });

  it("提权失败（state 失效）：提示重试并回原页面", async () => {
    rememberOAuthIntent({ purpose: "reauth", provider: "github" }, SECURITY);
    mount(`/login/oauth/github?code=c1&state=${MOCK_OAUTH_STATE}`, {
      capabilities: CAPS,
      // 没有绑定 GitHub：服务端答 credentials_invalid。
    });
    expect(await screen.findByText("验证失败，请重试")).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回账号" })).toBeTruthy();
  });

  it("没有意图就是登录，走 auth.oauthFinish", async () => {
    let finish: ReturnType<typeof vi.spyOn> | undefined;
    mount(
      `/login/oauth/github?code=c1&state=s1`,
      { signedIn: false, capabilities: CAPS },
      null,
      (api) => {
        finish = vi.spyOn(api.client.auth, "oauthFinish");
      },
    );
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
  });
});

describe("账号 · 更改邮箱免口令", () => {
  const open = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "更改邮箱" }));
    return screen.findByRole("dialog");
  };

  it("没有口令的账号：不显示口令框；已提权直接发出申请", async () => {
    const api = mount("/me/account", {
      capabilities: CAPS,
      hasPassword: false,
      linkedProviders: ["github"],
      elevated: true,
    });
    const change = vi.spyOn(api.client.me, "emailChange");
    const dialog = await open();
    await waitFor(() =>
      expect(within(dialog).queryByLabelText("当前口令")).toBeNull(),
    );
    fireEvent.change(within(dialog).getByLabelText("新邮箱"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await screen.findByText("待验证：new@example.com")).toBeTruthy();
    expect(change).toHaveBeenCalledWith({ newEmail: "new@example.com" });
  });

  it("没有口令且没提权：mfa_required 打开再验证，跳转前存下待续的改邮箱", async () => {
    const go = vi.spyOn(external, "go").mockImplementation(() => undefined);
    mount("/me/account", {
      capabilities: CAPS,
      hasPassword: false,
      linkedProviders: ["github"],
    });
    const dialog = await open();
    fireEvent.change(await within(dialog).findByLabelText("新邮箱"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    const stepUp = await screen.findByRole("dialog", { name: "再验证一次" });
    fireEvent.click(
      await within(stepUp).findByRole("button", { name: "用 GitHub 验证" }),
    );
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(recalledOAuthIntent()?.action).toEqual({
      kind: "emailChange",
      newEmail: "new@example.com",
    });
  });

  it("回来后自动发出待续的改邮箱申请", async () => {
    rememberOAuthIntent(
      { purpose: "reauth", provider: "github" },
      "/me/account",
      {
        kind: "emailChange",
        newEmail: "new@example.com",
      },
    );
    const api = mount(`/login/oauth/github?code=c1&state=${MOCK_OAUTH_STATE}`, {
      capabilities: CAPS,
      hasPassword: false,
      linkedProviders: ["github"],
    });
    const change = vi.spyOn(api.client.me, "emailChange");
    expect(await screen.findByText("待验证：new@example.com")).toBeTruthy();
    expect(change).toHaveBeenCalledWith({ newEmail: "new@example.com" });
  });

  it("有口令的账号：口令框照旧，带口令发出", async () => {
    const api = mount("/me/account", { capabilities: CAPS });
    const change = vi.spyOn(api.client.me, "emailChange");
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("新邮箱"), {
      target: { value: "new@example.com" },
    });
    fireEvent.change(await within(dialog).findByLabelText("当前口令"), {
      target: { value: "right" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await screen.findByText("待验证：new@example.com");
    expect(change).toHaveBeenCalledWith({
      newEmail: "new@example.com",
      password: "right",
    });
  });
});
