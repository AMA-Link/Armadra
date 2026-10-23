import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

const access = vi.hoisted(() => ({ member: false, remote: false }));
const settings = vi.hoisted(() => ({
  data: { updates: { notify: true } } as Record<string, unknown>,
}));
const save = vi.hoisted(() => ({ mutate: vi.fn() }));
const runtimeSettings = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../../app/use-access", () => ({
  useAccess: () => ({ member: access.member }),
}));
vi.mock("../remote-access", () => ({
  useRemoteAccess: () => ({ remote: access.remote }),
}));
vi.mock("../../../sources/context", () => ({
  useCurrentSource: () => ({ descriptor: { label: "" } }),
}));
// 推送设备有自己的用例（`PushDevices.test.tsx`）。
vi.mock("./PushDevices", () => ({ PushDevices: () => null }));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => {
    runtimeSettings.calls += 1;
    return { settings, save };
  },
}));

import { usePreferencesStore } from "../../../app/preferences-store";
import { translate } from "../../../i18n";
import { NotificationsPage } from "./NotificationsPage";

const zh = (key: string) => translate("zh-CN", key);

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  access.member = false;
  access.remote = false;
  runtimeSettings.calls = 0;
  save.mutate.mockClear();
});
afterEach(cleanup);

describe("设置 → 通知（§2.2 映射）", () => {
  it("原 3 项加「更新下载完成」；后者是主机项，切换即存", () => {
    render(<NotificationsPage />);
    for (const key of [
      "settings.notifyNeedsYou",
      "settings.sound",
      "updates.notify",
    ])
      expect(screen.getByRole("switch", { name: zh(key) }), key).toBeTruthy();
    expect(screen.getByText(zh("settings.soundVolume"))).toBeTruthy();
    expect(
      screen.getByRole("button", { name: zh("settings.preview") }),
    ).toBeTruthy();
    // 页头存在，且没有副标题（只有一个 h2 与动作）
    expect(screen.getByTestId("settings-heading")).toBeTruthy();
    // 设置恒指本机（#301）：本机改本机不画作用范围徽标。
    expect(document.querySelector("[data-settings-scope]")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: zh("updates.notify") }));
    expect(save.mutate).toHaveBeenCalledWith({ updates: { notify: false } });
  });

  it("成员与远端主机不画这一行，也不读设置文档", () => {
    for (const flags of [
      { member: true, remote: false },
      { member: false, remote: true },
    ]) {
      Object.assign(access, flags);
      runtimeSettings.calls = 0;
      render(<NotificationsPage />);
      expect(
        screen.queryByRole("switch", { name: zh("updates.notify") }),
      ).toBeNull();
      expect(runtimeSettings.calls).toBe(0);
      cleanup();
    }
  });
});

describe("设置未到时的占位", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("主机开关先占位，不先显示默认「开」；到了换成真开关", () => {
    const original = { ...settings };
    Object.assign(settings, { data: undefined, isLoading: true });
    const { rerender, container } = render(<NotificationsPage />);
    expect(
      screen.queryByRole("switch", { name: zh("updates.notify") }),
    ).toBeNull();
    act(() => void vi.advanceTimersByTime(200));
    expect(
      container.querySelectorAll("[data-slot=skeleton-settings-row]").length,
    ).toBe(1);
    act(() => void vi.advanceTimersByTime(300));
    Object.assign(settings, original, { isLoading: false });
    rerender(<NotificationsPage />);
    expect(
      screen.getByRole("switch", { name: zh("updates.notify") }),
    ).toBeTruthy();
    expect(
      container.querySelector("[data-slot=skeleton-settings-row]"),
    ).toBeNull();
  });
});
