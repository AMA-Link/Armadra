import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../../../../app/preferences-store";
import { installDomPolyfills } from "../../../../app/test-harness";
import {
  LockoutList,
  SESSION_PAGE_SIZE,
  SessionList,
  groupSessions,
  platformIcon,
} from "./SessionList";

installDomPolyfills();
beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(cleanup);

const row = (id: string, current: boolean, name: string) => ({
  sessionId: id,
  principalId: "p".repeat(32),
  deviceId: `d-${id}`,
  deviceName: name,
  createdAtMs: 1_000,
  lastSeenAtMs: current ? 3_000 : 2_000,
  // 列表不显示已过期的会话（#706）。
  expiresAtMs: Date.now() + 3_600_000,
  remoteIp: "192.0.2.4",
  userAgent: current ? "Macintosh" : "iPhone",
  current,
});

describe("SessionList", () => {
  it("第一次取数时是标题加 Skeleton，取不到时整块不出现", () => {
    const props = {
      sessions: undefined,
      everyone: false,
      canSeeEveryone: false,
      busy: null,
      onEveryone: vi.fn(),
      onRevoke: vi.fn(),
      onRevokeOthers: vi.fn(),
    };
    const { container, rerender } = render(<SessionList {...props} loading />);
    expect(screen.getByText("登录会话")).toBeTruthy();
    expect(
      container.querySelector('[data-slot="security-loading"]'),
    ).toBeTruthy();
    rerender(<SessionList {...props} />);
    expect(container.textContent).toBe("");
  });

  it("当前设备排第一、带徽标、没有退出钮；其余可退出，「退出其他全部」先确认", () => {
    const onRevoke = vi.fn();
    const onRevokeOthers = vi.fn();
    render(
      <SessionList
        sessions={[row("b", false, "Phone"), row("a", true, "Laptop")]}
        everyone={false}
        canSeeEveryone={false}
        busy={null}
        onEveryone={vi.fn()}
        onRevoke={onRevoke}
        onRevokeOthers={onRevokeOthers}
      />,
    );
    const rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain("Laptop");
    expect(rows[1]?.textContent).toContain("当前");
    expect(screen.queryByRole("button", { name: "退出 Laptop" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "退出 Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(onRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "b" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "退出其他全部" }));
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(onRevokeOthers).toHaveBeenCalled();
  });

  it("owner 能切到所有人，多一列成员", () => {
    const onEveryone = vi.fn();
    const { rerender } = render(
      <SessionList
        sessions={[row("a", true, "Laptop")]}
        everyone={false}
        canSeeEveryone
        busy={null}
        onEveryone={onEveryone}
        onRevoke={vi.fn()}
        onRevokeOthers={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "所有成员" }));
    expect(onEveryone).toHaveBeenCalledWith(true);
    rerender(
      <SessionList
        sessions={[row("a", true, "Laptop")]}
        everyone
        canSeeEveryone
        names={new Map([["p".repeat(32), "小王"]])}
        busy={null}
        onEveryone={onEveryone}
        onRevoke={vi.fn()}
        onRevokeOthers={vi.fn()}
      />,
    );
    expect(screen.getByText("小王")).toBeTruthy();
  });

  it("平台图标按 UA 猜", () => {
    expect(platformIcon("iPhone").displayName).toBe(
      platformIcon("Android Mobile").displayName,
    );
    expect(platformIcon("curl/8")).not.toBe(platformIcon("Windows NT"));
  });
});

/** 同一台设备上的一条会话（桌面壳的页面每次重新配对都多一条）。 */
const onDevice = (
  id: string,
  deviceId: string,
  lastSeenAtMs: number,
  extra: Partial<ReturnType<typeof row>> = {},
) => ({
  ...row(id, false, "本机桌面"),
  deviceId,
  lastSeenAtMs,
  ...extra,
});

const listProps = {
  everyone: false,
  canSeeEveryone: false,
  busy: null,
  onEveryone: vi.fn(),
  onRevokeOthers: vi.fn(),
};

describe("SessionList 按设备归并与分页（#706）", () => {
  it("同一设备的会话归成一组：最近活动取最晚的一条，过期的不算", () => {
    const now = 10_000;
    const groups = groupSessions(
      [
        onDevice("a", "desk", 2_000, { expiresAtMs: now + 1 }),
        onDevice("b", "desk", 5_000, { expiresAtMs: now + 1 }),
        onDevice("c", "desk", 9_000, { expiresAtMs: now }),
        onDevice("d", "phone", 7_000, { expiresAtMs: now + 1 }),
        onDevice("e", "gone", 9_500, { expiresAtMs: now - 1 }),
      ],
      now,
    );
    expect(groups.map((group) => group.deviceId)).toEqual(["phone", "desk"]);
    expect(groups[1]?.sessions.map((session) => session.sessionId)).toEqual([
      "b",
      "a",
    ]);
    expect(groups[1]?.lastActiveMs).toBe(5_000);
  });

  it("当前设备排第一，组里当前那条也排第一", () => {
    const groups = groupSessions([
      onDevice("x", "other", 9_000),
      onDevice("a", "desk", 2_000, { current: true }),
      onDevice("b", "desk", 5_000),
    ]);
    expect(groups[0]?.deviceId).toBe("desk");
    expect(groups[0]?.current).toBe(true);
    expect(groups[0]?.sessions[0]?.sessionId).toBe("a");
  });

  it("一台设备一行，带会话数；展开后逐条退出", () => {
    const onRevoke = vi.fn();
    render(
      <SessionList
        {...listProps}
        sessions={[
          onDevice("a", "desk", 2_000, { current: true }),
          onDevice("b", "desk", 5_000),
          onDevice("c", "desk", 4_000),
        ]}
        onRevoke={onRevoke}
      />,
    );
    const groups = document.querySelectorAll('[data-slot="session-group"]');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.textContent).toContain("3 个会话");
    expect(groups[0]?.textContent).toContain("当前");
    expect(screen.queryByRole("button", { name: "退出 本机桌面" })).toBeNull();

    const expand = screen.getByRole("button", { name: "展开 本机桌面" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll('[data-slot="session-row"]')).toHaveLength(
      3,
    );
    // 当前那条没有退出钮，另外两条有。
    const buttons = screen.getAllByRole("button", { name: "退出 本机桌面" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(onRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "b" }),
    );
    // 「退出其他全部」还在。
    expect(screen.getByRole("button", { name: "退出其他全部" })).toBeTruthy();

    fireEvent.click(expand);
    expect(document.querySelectorAll('[data-slot="session-row"]')).toHaveLength(
      0,
    );
  });

  it("设备多于一页时分页；最后一页只放剩下的", () => {
    const total = SESSION_PAGE_SIZE + 3;
    const sessions = Array.from({ length: total }, (_, index) =>
      onDevice(`s${index}`, `device-${index}`, 100_000 - index, {
        deviceName: `设备 ${index}`,
      }),
    );
    render(
      <SessionList {...listProps} sessions={sessions} onRevoke={vi.fn()} />,
    );
    const rows = () =>
      [...document.querySelectorAll('[data-slot="session-group"]')].map(
        (each) => each.textContent ?? "",
      );
    expect(rows()).toHaveLength(SESSION_PAGE_SIZE);
    expect(rows()[0]).toContain("设备 0");
    const previous = screen.getByRole("button", { name: "上一页" });
    expect((previous as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "第 1 页" })
        .getAttribute("aria-current"),
    ).toBe("page");

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toContain(`设备 ${SESSION_PAGE_SIZE}`);
    expect(
      (screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "第 1 页" }));
    expect(rows()[0]).toContain("设备 0");
  });

  it("一页放得下时不出现分页", () => {
    render(
      <SessionList
        {...listProps}
        sessions={[onDevice("a", "desk", 1)]}
        onRevoke={vi.fn()}
      />,
    );
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("LockoutList", () => {
  it("没有锁着的就不出现；有的可以解锁", () => {
    const { container } = render(
      <LockoutList lockouts={[]} busy={null} onUnlock={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
    const onUnlock = vi.fn();
    const lockout = {
      key: "principal:x",
      principalId: "x".repeat(32),
      failures: 6,
      lockedUntilMs: 5_000,
    };
    render(
      <LockoutList lockouts={[lockout]} busy={null} onUnlock={onUnlock} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "解锁" }));
    expect(onUnlock).toHaveBeenCalledWith(lockout);
  });
});
