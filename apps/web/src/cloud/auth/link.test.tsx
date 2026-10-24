import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hosted = vi.hoisted(() => ({ join: vi.fn(), resumeLink: vi.fn() }));
vi.mock("../../sources/hosted", async (original) => ({
  ...(await original<typeof import("../../sources/hosted")>()),
  startHostedRelay: () => ({
    join: hosted.join,
    resumeLink: hosted.resumeLink,
  }),
}));
vi.mock("../../challenge/TurnstileWidget", () => ({
  TurnstileWidget: ({ onToken }: { onToken: (token: string) => void }) => (
    <button type="button" onClick={() => onToken("turnstile-token")}>
      pass-challenge
    </button>
  ),
}));

import { usePreferencesStore } from "@/app/preferences-store";
import { ConsoleRoot } from "../ConsoleRoot";
import { createMockApi, type MockOptions } from "../mock/create-mock-client";
import { MOCK_LINK } from "../mock/fixtures";
import { guestKey } from "../../sources/hosted";
import { matchRoute } from "../router";

const LINK_ID = "0123456789abcdef";
const SECRET = "S".repeat(43);
const INVITE = `${"c".repeat(32)}.${"D".repeat(43)}`;
const HASH = `#${SECRET}.${INVITE}`;
const visit = (url: string) => window.history.replaceState(null, "", url);
const here = () => window.location.pathname + window.location.search;
const LOGIN_FOR_LINK = `/login?next=${encodeURIComponent(`/j/${LINK_ID}`)}`;

beforeEach(() => {
  usePreferencesStore.getState().setLocale("zh-CN");
  hosted.resumeLink.mockReset();
  hosted.join.mockReset();
  hosted.join.mockResolvedValue("a".repeat(32));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  visit("/");
});

const mount = (
  options: MockOptions = {},
  onJoined = vi.fn(),
  prepare: (api: ReturnType<typeof createMockApi>) => void = () => undefined,
) => {
  const api = createMockApi(options);
  prepare(api);
  render(<ConsoleRoot api={api} onJoined={onJoined} />);
  return { api, onJoined };
};
const join = () => screen.findByRole("button", { name: "加入" });

describe("分享链接落地页（SaaS）", () => {
  it("/j/:linkId 是公开路由", () => {
    expect(matchRoute(`/j/${LINK_ID}`)).toMatchObject({
      id: "join",
      area: "public",
      params: { linkId: LINK_ID },
    });
  });

  it("显示源、权限与有效期；不点「加入」就不接受；片段读入内存后从地址栏移除", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    const { api } = mount({ signedIn: false });
    const accept = vi.spyOn(api.client.links, "accept");
    expect(await screen.findByText("studio")).toBeTruthy();
    expect(screen.getByText("执行")).toBeTruthy();
    expect(screen.getByText(/有效至/)).toBeTruthy();
    expect(window.location.hash).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(accept).not.toHaveBeenCalled();
  });

  it("加载态：摘要到之前是带名字的 status", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    mount({ signedIn: false, latencyMs: 60 });
    expect((await screen.findByRole("status")).getAttribute("aria-label")).toBe(
      "加载中",
    );
    await screen.findByText("studio");
  });

  it("匿名允许：「加入」不登录就接受，以访客经托管中继进画布，地址换成 /app/", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    const { api, onJoined } = mount({ signedIn: false });
    const accept = vi.spyOn(api.client.links, "accept");
    fireEvent.click(await join());
    await waitFor(() => expect(onJoined).toHaveBeenCalledOnce());
    expect(accept.mock.calls[0]![0]).toMatchObject({
      linkId: LINK_ID,
      secret: SECRET,
      device: { platform: "browser" },
    });
    expect(accept.mock.calls[0]![0]).not.toHaveProperty("challenge");
    const [link, accepted] = hosted.join.mock.calls[0]!;
    expect(link).toMatchObject({
      linkId: LINK_ID,
      secret: SECRET,
      invitationToken: INVITE,
    });
    expect(accepted).toHaveProperty("guestSession");
    expect(here()).toBe("/app/");
  });

  it("要求登录且没有会话：主按钮是「登录后加入」，replace 去登录，登录后回来仍带着秘密", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    const push = vi.spyOn(window.history, "pushState");
    const { api, onJoined } = mount({
      signedIn: false,
      linkRequiresAccount: true,
    });
    const accept = vi.spyOn(api.client.links, "accept");
    fireEvent.click(await screen.findByRole("button", { name: "登录后加入" }));
    await waitFor(() => expect(here()).toBe(LOGIN_FOR_LINK));
    expect(push).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    await screen.findByRole("heading", { level: 1, name: "登录" });
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "zed@example.com" },
    });
    fireEvent.change(screen.getByLabelText("口令"), {
      target: { value: "correct horse" },
    });
    fireEvent.submit(screen.getByLabelText("邮箱").closest("form")!);
    fireEvent.click(await join());
    await waitFor(() => expect(onJoined).toHaveBeenCalledOnce());
    expect(here()).toBe("/app/");
    expect(hosted.join.mock.calls[0]![0]).toMatchObject({ secret: SECRET });
    push.mockRestore();
  });

  it("要求登录且已有会话：直接是「加入」，带着会话接受", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    const { api, onJoined } = mount({ linkRequiresAccount: true });
    const ensure = vi.spyOn(api, "ensureCsrf");
    fireEvent.click(await join());
    await waitFor(() => expect(onJoined).toHaveBeenCalledOnce());
    expect(ensure).toHaveBeenCalled();
  });

  it("接受时云端答 anonymous_links_disabled：改成「登录后加入」，不出错误文案", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    mount({
      signedIn: false,
      fail: { "links.accept": "anonymous_links_disabled" },
    });
    fireEvent.click(await join());
    await screen.findByRole("button", { name: "登录后加入" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(hosted.join).not.toHaveBeenCalled();
  });

  it.each([
    ["link_expired", "链接已过期"],
    ["link_secret_invalid", "链接不完整，请复制完整的链接"],
    ["rate_limited", "请求过于频繁，请稍后重试"],
  ])("接受失败 %s：按码给文案，按钮变「重试」", async (code, message) => {
    visit(`/j/${LINK_ID}${HASH}`);
    mount({ signedIn: false, fail: { "links.accept": code } });
    fireEvent.click(await join());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(hosted.join).not.toHaveBeenCalled();
  });

  it("托管中继加入失败：显示按码的文案，留在页面", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    hosted.join.mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "link_exhausted" }),
    );
    const { onJoined } = mount({ signedIn: false });
    fireEvent.click(await join());
    await screen.findByRole("alert");
    expect(onJoined).not.toHaveBeenCalled();
    expect(here()).toBe(`/j/${LINK_ID}`);
  });

  it("链接失效：整页说明，不显示「加入」", async () => {
    visit(`/j/${MOCK_LINK.gone}${HASH}`);
    mount({ signedIn: false });
    await screen.findByText("链接已停用或不存在");
    expect(screen.queryByRole("button", { name: "加入" })).toBeNull();
    expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();
  });

  it("次数用完：「加入」禁用并说明", async () => {
    visit(`/j/${MOCK_LINK.exhausted}${HASH}`);
    mount({ signedIn: false });
    const button = await join();
    expect(button.hasAttribute("disabled")).toBe(true);
    expect((await screen.findByRole("alert")).textContent).toMatch(/用完|次数/);
  });

  it("没有片段（秘密缺失）：说明链接不完整，不查询", async () => {
    visit(`/j/${LINK_ID}`);
    const { api } = mount({ signedIn: false });
    const get = vi.spyOn(api.client.links, "get");
    await screen.findByText("这不是一条完整的分享链接");
    expect(get).not.toHaveBeenCalled();
  });

  it("要求人机验证：令牌到之前「加入」禁用，之后随 links.accept 一起发", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    const { api, onJoined } = mount({ signedIn: false }, vi.fn(), (made) => {
      vi.spyOn(made.client.platform, "info").mockResolvedValue({
        challenge: {
          provider: "turnstile",
          siteKey: "k",
          scope: ["links.accept"],
        },
      } as never);
    });
    const accept = vi.spyOn(api.client.links, "accept");
    const button = await join();
    const pass = await screen.findByText("pass-challenge");
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(pass);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(onJoined).toHaveBeenCalledOnce());
    expect(accept.mock.calls[0]![0]).toMatchObject({
      challenge: { provider: "turnstile", token: "turnstile-token" },
    });
  });

  it("中继加入失败后重试：只重跑加入，不再 links.accept（接受会消耗次数）", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    hosted.join.mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "source_unreachable" }),
    );
    const { api, onJoined } = mount({ signedIn: false });
    const accept = vi.spyOn(api.client.links, "accept");
    fireEvent.click(await join());
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledOnce());
    expect(accept).toHaveBeenCalledOnce();
    expect(hosted.join).toHaveBeenCalledTimes(2);
    expect(hosted.join.mock.calls[1]![1]).toBe(hosted.join.mock.calls[0]![1]);
  });

  it("link_frozen：整页 PageState，没有「加入」（摘要时与接受时都一样）", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    mount({ signedIn: false, fail: { "links.get": "link_frozen" } });
    await screen.findByText("链接已冻结，联系分享的人");
    expect(screen.queryByRole("button", { name: "加入" })).toBeNull();
    cleanup();
    visit(`/j/${LINK_ID}${HASH}`);
    mount({ signedIn: false, fail: { "links.accept": "link_frozen" } });
    fireEvent.click(await join());
    await screen.findByText("链接已冻结，联系分享的人");
    expect(screen.queryByRole("button", { name: "加入" })).toBeNull();
  });

  it("链接带主人名：标题是「加入 {owner} 的 {target}」，并有首字头像；缺字段时只显示源名", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    mount({ signedIn: false, linkOwnerName: "alice" });
    expect(await screen.findByText("加入 alice 的 studio")).toBeTruthy();
    expect(screen.getByText("A")).toBeTruthy();
    cleanup();
    visit(`/j/${LINK_ID}${HASH}`);
    mount({ signedIn: false });
    expect(await screen.findByText("studio")).toBeTruthy();
    expect(screen.queryByText(/^加入 .* 的/)).toBeNull();
  });

  it("已加入过：主按钮是「打开」，经访客记录续上而不再接受；续不上回到「加入」", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    localStorage.setItem(
      guestKey(window.location.origin, LINK_ID),
      JSON.stringify({
        issuer: window.location.origin,
        cloudRefreshToken: "r",
        sources: {},
        entered: null,
      }),
    );
    hosted.resumeLink.mockResolvedValueOnce(null);
    const { api, onJoined } = mount({ signedIn: false });
    const accept = vi.spyOn(api.client.links, "accept");
    fireEvent.click(await screen.findByRole("button", { name: "打开" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "没能加入",
    );
    await screen.findByRole("button", { name: "重试" });
    expect(onJoined).not.toHaveBeenCalled();
    cleanup();
    visit(`/j/${LINK_ID}${HASH}`);
    hosted.resumeLink.mockResolvedValueOnce({ kind: "entered" });
    const again = mount({ signedIn: false });
    fireEvent.click(await screen.findByRole("button", { name: "打开" }));
    await waitFor(() => expect(again.onJoined).toHaveBeenCalledOnce());
    expect(accept).not.toHaveBeenCalled();
    expect(hosted.join).not.toHaveBeenCalled();
  });

  it("刚接受的结果碰到失效不作废；沿用的旧结果碰到失效才作废并重新 links.accept", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    hosted.join.mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "cloud_assertion_replayed" }),
    );
    hosted.join.mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "cloud_assertion_invalid" }),
    );
    const { api, onJoined } = mount({ signedIn: false });
    const accept = vi.spyOn(api.client.links, "accept");
    fireEvent.click(await join());
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    // 第二次是沿用旧结果碰到失效：作废，第三次重新接受。
    await waitFor(() => expect(hosted.join).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledOnce());
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it("主人名里带 {target} 也原样显示，不被二次替换", async () => {
    visit(`/j/${LINK_ID}${HASH}`);
    mount({ signedIn: false, linkOwnerName: "{target}x" });
    expect(await screen.findByText("加入 {target}x 的 studio")).toBeTruthy();
  });
});
