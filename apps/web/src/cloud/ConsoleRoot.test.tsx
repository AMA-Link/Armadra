import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConsoleRoot, type ConsoleSession } from "./ConsoleRoot";

const session: ConsoleSession = {
  user: { name: "Zed", email: "zed@example.com", emailVerified: true },
  teams: [
    { slug: "rd", name: "R&D", role: "member" },
    { slug: "bill", name: "Billing", role: "billing" },
  ],
};

const visit = (path: string) => window.history.replaceState(null, "", path);

beforeEach(() => {
  // 宽屏：固定侧栏。
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

describe("ConsoleRoot", () => {
  it("没有运营会话访问 /ops/* 整页「找不到这个页面」，不带侧栏，不露出运营后台", () => {
    visit("/ops/nodes");
    render(<ConsoleRoot session={session} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "找不到这个页面",
    );
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByText("运营")).toBeNull();
  });

  it("不认识的路径同样是找不到，按钮回到 /", () => {
    visit("/nope");
    render(<ConsoleRoot session={session} />);
    act(() => screen.getByRole("button", { name: "回到概览" }).click());
    expect(window.location.pathname).toBe("/me");
  });

  it("有运营会话进 /ops，h1 是当前项", () => {
    visit("/ops/nodes");
    render(<ConsoleRoot session={{ ...session, operator: true }} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("节点");
    expect(screen.getByText("运营")).toBeTruthy();
  });

  it("没有会话是「登录已过期」，点重新登录带上 next", () => {
    visit("/t/rd/hosts?status=online");
    render(<ConsoleRoot session={null} />);
    expect(screen.getByRole("heading").textContent).toBe("登录已过期");
    act(() => screen.getByRole("button", { name: "重新登录" }).click());
    expect(window.location.pathname + window.location.search).toBe(
      `/login?next=${encodeURIComponent("/t/rd/hosts?status=online")}`,
    );
  });

  it("团队里角色看不到的页是「没有权限」，团队不存在是找不到", () => {
    visit("/t/bill/hosts");
    const { unmount } = render(<ConsoleRoot session={session} />);
    expect(screen.getByRole("heading").textContent).toBe(
      "没有权限执行这个操作",
    );
    unmount();
    visit("/t/ghost");
    render(<ConsoleRoot session={session} />);
    expect(screen.getByRole("heading").textContent).toBe("找不到这个页面");
  });

  it("`/` 跳到上次的空间", () => {
    localStorage.setItem("armadra.cloud.space", "rd");
    visit("/");
    render(<ConsoleRoot session={session} />);
    expect(window.location.pathname).toBe("/t/rd");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("概览");
  });

  it("进入空间页后记下它", () => {
    visit("/t/rd/members");
    render(<ConsoleRoot session={session} />);
    expect(localStorage.getItem("armadra.cloud.space")).toBe("rd");
  });
});
