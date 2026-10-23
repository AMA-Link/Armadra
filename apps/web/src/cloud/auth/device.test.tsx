import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleRoot } from "../ConsoleRoot";
import { createMockApi, type MockOptions } from "../mock/create-mock-client";
import { MOCK_DEVICE_CODES } from "../mock/fixtures";
import { matchRoute } from "../router";
import { cleanUserCode, normalizeUserCode } from "./device-code";
import { requestedAgo } from "./DevicePage";

const visit = (url: string) => window.history.replaceState(null, "", url);
const here = () => window.location.pathname + window.location.search;
const h1 = () => screen.findByRole("heading", { level: 1 });
const CODE = MOCK_DEVICE_CODES.pending;
const LOGIN_FOR_CODE = `/login?next=${encodeURIComponent(`/device?code=${CODE}`)}`;

afterEach(() => {
  cleanup();
  visit("/");
});

const mount = (options: MockOptions = {}) => {
  const api = createMockApi(options);
  render(<ConsoleRoot api={api} />);
  return api;
};
const codeInput = () => screen.getByLabelText("设备码") as HTMLInputElement;
const enter = (value: string) =>
  fireEvent.change(codeInput(), { target: { value } });

describe("设备码规整", () => {
  it("/device 是公开路由", () => {
    expect(matchRoute("/device", "?code=BCDF-GHJK")).toMatchObject({
      id: "device",
      area: "public",
    });
  });

  it("容忍小写、空白与缺连字符；字母表之外的字符与长度不对都不认", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode(" bcdf ghjk ")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("ABCD-EFGH")).toBeNull();
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(normalizeUserCode("")).toBeNull();
    expect(normalizeUserCode(null)).toBeNull();
  });

  it("粘贴整串：去掉空白与连字符，转大写，最多 8 位", () => {
    expect(cleanUserCode("bcdf-ghjk\n")).toBe("BCDFGHJK");
    expect(cleanUserCode("BCDF-GHJK-LMNP")).toBe("BCDFGHJK");
    expect(cleanUserCode("aei0")).toBe("");
  });

  it("请求时间：一分钟内是刚刚，其余是相对时间", () => {
    const now = 1_000_000_000;
    expect(requestedAgo(now - 20_000, now, "zh-CN", "刚刚")).toBe("刚刚");
    expect(requestedAgo(now - 3 * 60_000, now, "zh-CN", "刚刚")).toBe(
      "3分钟前",
    );
  });
});

describe("设备授权页", () => {
  it("输入框：autocomplete=one-time-code，没填满时「继续」禁用", async () => {
    visit("/device");
    mount();
    expect((await h1()).textContent).toBe("授权设备");
    expect(codeInput().getAttribute("autocomplete")).toBe("one-time-code");
    const next = screen.getByRole("button", { name: "继续" });
    expect(next.hasAttribute("disabled")).toBe(true);
    enter("bcdfgh");
    expect(next.hasAttribute("disabled")).toBe(true);
    enter("bcdfghjk");
    expect(next.hasAttribute("disabled")).toBe(false);
  });

  it("手输小写的码：规整后查询，显示请求方的平台与名字", async () => {
    visit("/device");
    const api = mount();
    const get = vi.spyOn(api.client.auth, "deviceGet");
    await h1();
    enter("bcdfghjk");
    fireEvent.submit(codeInput().closest("form")!);
    await screen.findByText("build-01 请求登录");
    expect(get).toHaveBeenCalledWith({ userCode: CODE });
    expect(screen.getByText(/桌面 · 刚刚/)).toBeTruthy();
  });

  it("?code= 直接进第二步；授权后显示完成并回到控制台", async () => {
    visit(`/device?code=${CODE}`);
    const api = mount();
    const approve = vi.spyOn(api.client.auth, "deviceApprove");
    await screen.findByText("build-01 请求登录");
    fireEvent.click(screen.getByRole("button", { name: "授权" }));
    await screen.findByText("已授权，可以回到 build-01");
    expect(approve).toHaveBeenCalledWith({ userCode: CODE, approve: true });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(here()).not.toBe(`/device?code=${CODE}`));
  });

  it("拒绝：走 deviceDeny，显示已拒绝这次登录", async () => {
    visit(`/device?code=${CODE}`);
    const api = mount();
    const deny = vi.spyOn(api.client.auth, "deviceDeny");
    const approve = vi.spyOn(api.client.auth, "deviceApprove");
    await screen.findByText("build-01 请求登录");
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await screen.findByText("已拒绝这次登录");
    expect(deny).toHaveBeenCalledWith({ userCode: CODE });
    expect(approve).not.toHaveBeenCalled();
  });

  it("加载态：查码期间是带名字的 status，不显示表单", async () => {
    visit(`/device?code=${CODE}`);
    mount({ latencyMs: 80 });
    expect((await screen.findByRole("status")).getAttribute("aria-label")).toBe(
      "加载中",
    );
    expect(screen.queryByLabelText("设备码")).toBeNull();
    await screen.findByText("build-01 请求登录");
  });

  it("未登录：不查码，replace 去 /login，next 只带 user_code；登录后回来继续", async () => {
    visit(`/device?code=${CODE}`);
    const push = vi.spyOn(window.history, "pushState");
    const api = mount({ signedIn: false });
    const get = vi.spyOn(api.client.auth, "deviceGet");
    await waitFor(() => expect(here()).toBe(LOGIN_FOR_CODE));
    expect(get).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(here()).not.toMatch(/device_code|deviceCode/);
    await h1();
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "zed@example.com" },
    });
    fireEvent.change(screen.getByLabelText("口令"), {
      target: { value: "correct horse" },
    });
    fireEvent.submit(screen.getByLabelText("邮箱").closest("form")!);
    await screen.findByText("build-01 请求登录");
    expect(here()).toBe(`/device?code=${CODE}`);
    push.mockRestore();
  });

  it("手输码但未登录：同样带着码去登录", async () => {
    visit("/device");
    mount({ signedIn: false });
    await h1();
    enter("bcdfghjk");
    fireEvent.submit(codeInput().closest("form")!);
    await waitFor(() => expect(here()).toBe(LOGIN_FOR_CODE));
  });

  it.each([
    ["QQQQ-QQQQ", "设备码不正确"],
    ["BCDF-BCDF", "设备码不正确"],
    [MOCK_DEVICE_CODES.expired, "设备码已过期，回到设备上重新获取"],
    [MOCK_DEVICE_CODES.limited, "请求过于频繁，请稍后重试"],
  ])("%s：错误在设备码下，焦点回到输入框", async (code, message) => {
    visit(`/device?code=${code}`);
    mount();
    await screen.findByText(message);
    expect(codeInput().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(codeInput());
    expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();
  });

  it("地址里的码格式不对：留在输入页，不查询", async () => {
    visit("/device?code=ABC");
    const api = mount();
    const get = vi.spyOn(api.client.auth, "deviceGet");
    await h1();
    expect(codeInput()).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });

  it("批准时码已被别处处理：回到输入页并说明", async () => {
    visit(`/device?code=${CODE}`);
    const api = mount();
    await screen.findByText("build-01 请求登录");
    // 先在别处处理掉，再点授权：云端答查无此码。
    await api.client.auth.deviceDeny({ userCode: CODE });
    fireEvent.click(screen.getByRole("button", { name: "授权" }));
    await screen.findByText("设备码不正确");
    expect(document.activeElement).toBe(codeInput());
  });

  it("批准要求提权：引导口令再验证，成功后接着批准；口令错留在原地", async () => {
    visit(`/device?code=${CODE}`);
    const api = mount({ deviceNeedsStepUp: true });
    const stepUp = vi.spyOn(api.client.auth, "stepUp");
    await screen.findByText("build-01 请求登录");
    fireEvent.click(screen.getByRole("button", { name: "授权" }));
    await screen.findByRole("heading", { name: "再验证一次" });
    const secret = screen.getByLabelText("口令") as HTMLInputElement;
    expect(secret.getAttribute("autocomplete")).toBe("current-password");
    fireEvent.change(secret, { target: { value: "wrong" } });
    fireEvent.submit(secret.closest("form")!);
    await screen.findByText("账号或口令不正确");
    expect(document.activeElement).toBe(secret);
    fireEvent.change(secret, { target: { value: "right" } });
    fireEvent.submit(secret.closest("form")!);
    await screen.findByText("已授权，可以回到 build-01");
    expect(stepUp).toHaveBeenLastCalledWith({ password: "right" });
  });

  it("提权可以改用验证码，也可以返回", async () => {
    visit(`/device?code=${CODE}`);
    const api = mount({ deviceNeedsStepUp: true });
    const stepUp = vi.spyOn(api.client.auth, "stepUp");
    await screen.findByText("build-01 请求登录");
    fireEvent.click(screen.getByRole("button", { name: "授权" }));
    await screen.findByRole("heading", { name: "再验证一次" });
    fireEvent.click(screen.getByRole("button", { name: "改用验证码" }));
    const input = screen.getByLabelText("验证码") as HTMLInputElement;
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByText("已授权，可以回到 build-01");
    expect(stepUp).toHaveBeenCalledWith({ totpCode: "123456" });
  });

  it("提权页的「返回」回到请求卡", async () => {
    visit(`/device?code=${CODE}`);
    mount({ deviceNeedsStepUp: true });
    await screen.findByText("build-01 请求登录");
    fireEvent.click(screen.getByRole("button", { name: "授权" }));
    await screen.findByRole("heading", { name: "再验证一次" });
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await screen.findByText("build-01 请求登录");
  });
});
