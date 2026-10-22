import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { matchRoute } from "../router";
import { ConsoleShell } from "./ConsoleShell";
import type { ConsoleTeam, ConsoleUser } from "./model";

const user: ConsoleUser = {
  name: "Zed",
  email: "zed@example.com",
  emailVerified: true,
};
const teams: ConsoleTeam[] = [
  { slug: "rd", name: "R&D", role: "member" },
  { slug: "lab", name: "Lab", role: "owner" },
];

/** 宽屏（≥1024）还是顶栏加抽屉。 */
function viewport(wide: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("min-width: 1024px") ? wide : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

const shell = (
  path: string,
  extra: Partial<Parameters<typeof ConsoleShell>[0]> = {},
) => (
  <ConsoleShell user={user} teams={teams} match={matchRoute(path)!} {...extra}>
    <h1>页面</h1>
  </ConsoleShell>
);

const original = window.matchMedia;
beforeEach(() => viewport(true));
afterEach(() => {
  cleanup();
  window.matchMedia = original;
  window.history.replaceState(null, "", "/");
});

describe("ConsoleShell 宽屏", () => {
  it("地标：第一个可聚焦元素是「跳到正文」，导航与 main 都有名字", () => {
    render(shell("/t/rd/hosts"));
    const focusable = document.querySelector<HTMLElement>(
      "a[href], button, [tabindex='0']",
    );
    expect(focusable?.textContent).toBe("跳到正文");
    expect(screen.getByRole("navigation", { name: "导航" })).toBeTruthy();
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    fireEvent.click(screen.getByText("跳到正文"));
    expect(document.activeElement).toBe(main);
  });

  it("导航是真链接，当前页 aria-current；成员看不到审计", () => {
    render(shell("/t/rd/hosts"));
    const nav = within(screen.getByRole("navigation", { name: "导航" }));
    const hosts = nav.getByRole("link", { name: "主机" });
    expect(hosts.getAttribute("href")).toBe("/t/rd/hosts");
    expect(hosts.getAttribute("aria-current")).toBe("page");
    expect(
      nav.getByRole("link", { name: "概览" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(nav.queryByRole("link", { name: "审计" })).toBeNull();
    expect(nav.getByRole("link", { name: "成员" })).toBeTruthy();
  });

  it("点导航走 History 不整页重载，修饰键放行", () => {
    render(shell("/me"));
    const link = screen.getByRole("link", { name: "链接" });
    // 在 React 之后看一眼：谁拦下了默认行为（jsdom 不实现整页跳转，顺手压掉）。
    const prevented: boolean[] = [];
    const spy = (event: Event) => {
      prevented.push(event.defaultPrevented);
      event.preventDefault();
    };
    document.addEventListener("click", spy);
    fireEvent.click(link, { ctrlKey: true });
    expect(window.location.pathname).toBe("/");
    fireEvent.click(link);
    document.removeEventListener("click", spy);
    expect(window.location.pathname).toBe("/me/links");
    expect(prevented).toEqual([false, true]);
  });

  it("计数只在 >0 时出现", () => {
    render(shell("/t/lab", { counts: { trust: 2, links: 0 } }));
    const trust = screen.getByRole("link", { name: /设备信任/ });
    expect(within(trust).getByText("2")).toBeTruthy();
    expect(
      within(screen.getByRole("link", { name: "链接" })).queryByText("0"),
    ).toBeNull();
  });

  it("运营后台：标题加「运营」徽标和返回控制台，没有空间切换", () => {
    render(shell("/ops/nodes", { operator: true }));
    expect(screen.getByText("运营")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "返回控制台" }).getAttribute("href"),
    ).toBe("/");
    expect(
      screen.getByRole("link", { name: "节点" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByText("个人空间")).toBeNull();
  });

  it("邮箱已验证时没有提示", () => {
    render(shell("/me"));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("未验证提示", () => {
  const unverified = { ...user, emailVerified: false };

  it("页头之上常驻；重新发送成功后按钮换「已发送」", async () => {
    const resend = vi.fn().mockResolvedValue(undefined);
    render(
      <ConsoleShell
        user={unverified}
        teams={teams}
        match={matchRoute("/me")!}
        onResendVerification={resend}
      >
        <h1>页面</h1>
      </ConsoleShell>,
    );
    const alert = screen.getByRole("status");
    expect(alert.textContent).toContain("验证邮箱后才能登记主机和分享");
    expect(alert.compareDocumentPosition(screen.getByText("页面"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    fireEvent.click(screen.getByRole("button", { name: "重新发送验证邮件" }));
    expect(await screen.findByRole("button", { name: "已发送" })).toBeTruthy();
    expect(resend).toHaveBeenCalledOnce();
  });

  it("没给发送回调就不画按钮", () => {
    render(shell("/me", { user: unverified }));
    expect(
      screen.queryByRole("button", { name: "重新发送验证邮件" }),
    ).toBeNull();
  });
});

describe("ConsoleShell 窄屏", () => {
  it("顶栏：打开导航抽屉，点链接后收起", async () => {
    viewport(false);
    render(shell("/me"));
    expect(screen.queryByRole("navigation", { name: "导航" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
    const nav = await screen.findByRole("navigation", { name: "导航" });
    fireEvent.click(within(nav).getByRole("link", { name: "主机" }));
    expect(window.location.pathname).toBe("/me/hosts");
    expect(screen.queryByRole("navigation", { name: "导航" })).toBeNull();
  });

  it("顶栏有账号菜单按钮", () => {
    viewport(false);
    render(shell("/me"));
    expect(screen.getByRole("button", { name: "账号菜单" })).toBeTruthy();
  });
});
