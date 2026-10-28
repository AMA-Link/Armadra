import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConsoleHost,
  HostInfo,
  HostView,
} from "../../sources/console-host";
import { HostRoot } from "./HostRoot";

/**
 * `/h/` 的页面（设计 saas-host-open §2.1、§2.5）：进去之前整页状态卡，进去之后画布加顶栏，
 * 掉线、撤销盖一层，登出整页「已登出」。
 */

afterEach(cleanup);

const HOST = "a".repeat(32);

function fakeHost(view: HostView, over: Partial<ConsoleHost> = {}) {
  const listeners = new Set<() => void>();
  let current = view;
  const info: HostInfo = {
    name: "host1",
    space: "team",
    owner: false,
    consoleHref: `/t/test-team/hosts/${HOST}`,
  };
  const host = {
    hostId: HOST,
    issuer: "https://app.saas.example",
    get view() {
      return current;
    },
    status: { state: "ready", lastError: null, relayDown: false },
    info,
    ownerMismatch: false,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    guest: () => null,
    dispose: () => undefined,
    ...over,
  } as ConsoleHost;
  return {
    host,
    set(next: HostView) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const page = (host: ConsoleHost) =>
  render(
    <HostRoot hostId={HOST} host={host}>
      <div data-testid="app">画布</div>
    </HostRoot>,
  );

describe("控制台 /h/ 页面", () => {
  it("进去之前：失败按码给文案与回到主机列表", () => {
    const { host } = fakeHost({ kind: "failed", code: "source_too_old" });
    page(host);
    expect(screen.getByText("这台主机的版本太旧，升级后再打开")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "回到主机列表" }).getAttribute("href"),
    ).toBe("/t/test-team/hosts");
    expect(screen.queryByTestId("app")).toBeNull();
  });

  it("账号没映射：给出在主机上补登录的命令", () => {
    const { host } = fakeHost({
      kind: "failed",
      code: "cloud_account_unlinked",
    });
    page(host);
    expect(
      screen.getByText(
        "armadra-server cloud login --issuer https://app.saas.example",
      ),
    ).toBeTruthy();
  });

  it("进去之后：画布加顶栏；撤销盖一层、画布不卸载；登出整页已登出", () => {
    const { host, set } = fakeHost({ kind: "connecting" });
    page(host);
    expect(host.open).toHaveBeenCalledTimes(1);
    act(() => set({ kind: "entered" }));
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(screen.getByText("host1")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "登出" }).click());
    expect(host.signOut).toHaveBeenCalledTimes(1);
    act(() => set({ kind: "failed", code: "source_access_denied" }));
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(screen.getByText("你没有这台主机的访问权限")).toBeTruthy();
    act(() => set({ kind: "signedOut" }));
    expect(screen.queryByTestId("app")).toBeNull();
    expect(screen.getByText("已登出")).toBeTruthy();
  });

  it("是主人却不是本机 owner：顶栏提示与修正办法", () => {
    const { host } = fakeHost({ kind: "entered" }, { ownerMismatch: true });
    page(host);
    expect(screen.getByText("这台主机把你当作成员，不是主人")).toBeTruthy();
    expect(screen.getByRole("button", { name: "怎样修正" })).toBeTruthy();
  });
});
