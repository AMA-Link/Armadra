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
 * 掉线、撤销盖一层，登出整页「已登出」，访客的访问被收回整页「访问已被收回」。
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
  it("没有控制台会话：不出任何登录表单，整页换到 /login?next=/h/<主机>（同源，Cookie 会话共享）", () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace });
    const { host } = fakeHost({ kind: "login" });
    page(host);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent(`/h/${HOST}`)}`,
    );
    expect(screen.queryByLabelText("口令")).toBeNull();
    expect(screen.queryByLabelText("邮箱")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByTestId("app")).toBeNull();
  });

  it("进去之前：失败按码给文案与回到主机列表", () => {
    const { host } = fakeHost({ kind: "failed", code: "source_too_old" });
    page(host);
    expect(screen.getByText("这台主机的版本太旧，升级后再打开")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "回到主机列表" }).getAttribute("href"),
    ).toBe("/t/test-team/hosts");
    expect(screen.queryByTestId("app")).toBeNull();
  });

  it("端到端太旧与「版本太旧」同一句；设备钥不可用给重试", () => {
    const old = fakeHost({ kind: "failed", code: "e2e_unsupported" });
    const first = page(old.host);
    expect(screen.getByText("这台主机的版本太旧，升级后再打开")).toBeTruthy();
    first.unmount();
    const key = fakeHost({ kind: "failed", code: "e2e_device_unavailable" });
    page(key.host);
    expect(screen.getByText("这个浏览器不能保存设备钥")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("主机身份变了：附上指纹前 16 位，不给「仍然连接」", () => {
    const { host } = fakeHost({
      kind: "failed",
      code: "identity_changed",
      fingerprint: "0123456789abcdef",
    });
    page(host);
    expect(screen.getByText("主机的身份和上次不同，已停止连接")).toBeTruthy();
    expect(
      screen.getByText("主机现在的身份指纹 0123 4567 89ab cdef"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
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

  it("访客（分享链接）：没有主机顶栏；访问被收回是终态，整页状态卡、卸下画布，没有回主机列表", () => {
    const { host, set } = fakeHost(
      { kind: "connecting" },
      {
        info: {
          name: "host1",
          space: "personal",
          owner: false,
          consoleHref: "/",
          guest: true,
        },
      },
    );
    page(host);
    act(() => set({ kind: "entered" }));
    expect(screen.getByTestId("app")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "登出" })).toBeNull();
    expect(screen.queryByRole("link", { name: "控制台" })).toBeNull();
    act(() => set({ kind: "failed", code: "access_revoked" }));
    expect(screen.getByText("访问已被收回")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "回到主机列表" })).toBeNull();
    // 不是盖层：画布（与它的「已断开」之类）不再留在页面里。
    expect(screen.queryByTestId("app")).toBeNull();
    expect(document.querySelector('[data-slot="host-cover"]')).toBeNull();
  });

  it("是主人却不是本机 owner：顶栏提示与修正办法", () => {
    const { host } = fakeHost({ kind: "entered" }, { ownerMismatch: true });
    page(host);
    expect(screen.getByText("这台主机把你当作成员，不是主人")).toBeTruthy();
    expect(screen.getByRole("button", { name: "怎样修正" })).toBeTruthy();
  });
});
