import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PushDevice } from "@armadra/shared";

const devices = vi.fn();
const setKinds = vi.fn();
const toastError = vi.fn();
vi.mock("../../../api/push", () => ({
  pushApi: {
    devices: () => devices(),
    setKinds: (deviceId: string, kinds: string[]) => setKinds(deviceId, kinds),
  },
}));
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { TestProviders, installDomPolyfills } from "../../../app/test-harness";
import { usePreferencesStore } from "../../../app/preferences-store";
import { PushDevices } from "./PushDevices";

/** 设置 → 通知 → 推送设备：逐台改收哪些种类（契约 §74，#326）。 */

installDomPolyfills();
afterEach(cleanup);

const ALL = [
  "approval",
  "agentDone",
  "agentError",
  "agentWaiting",
  "deliveryFailed",
  "schedule",
  "resources",
  "comment",
  "workflowGate",
] as const;

const device = (patch: Partial<PushDevice>): PushDevice => ({
  deviceId: "d1",
  platform: "ios",
  transport: "direct",
  appVersion: "0.3.0",
  locale: "zh-CN",
  encrypted: true,
  kinds: [...ALL],
  createdAt: "2026-10-01T00:00:00.000Z",
  current: false,
  ...patch,
});

const mount = () =>
  render(
    <TestProviders>
      <PushDevices />
    </TestProviders>,
  );

const open = async (name: string) => {
  fireEvent.click(
    await screen.findByRole("button", { name: new RegExp(name) }),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  usePreferencesStore.setState({ locale: "zh-CN" });
});

describe("推送设备", () => {
  it("没有登记的设备时整组不画", async () => {
    devices.mockResolvedValue({ devices: [] });
    const view = mount();
    await waitFor(() => expect(devices).toHaveBeenCalled());
    expect(view.container.textContent).toBe("");
  });

  it("逐台列出，展开后改一个种类就存这一台的完整列表", async () => {
    devices.mockResolvedValue({
      devices: [
        device({ deviceId: "d1", deviceName: "我的 iPhone", editable: true }),
        device({
          deviceId: "d2",
          platform: "android",
          deviceName: "同事的手机",
          editable: false,
        }),
      ],
    });
    setKinds.mockImplementation(async (deviceId: string, kinds: string[]) => ({
      device: device({ deviceId, kinds: kinds as PushDevice["kinds"] }),
    }));
    mount();
    expect(await screen.findByText("推送设备")).toBeTruthy();
    await open("我的 iPhone");
    fireEvent.click(
      screen.getByRole("switch", { name: "我的 iPhone · Agent 出错" }),
    );
    await waitFor(() =>
      expect(setKinds).toHaveBeenCalledWith(
        "d1",
        ALL.filter((kind) => kind !== "agentError"),
      ),
    );

    // 成员的设备只列不改。
    await open("同事的手机");
    const locked = screen.getByRole("switch", {
      name: "同事的手机 · Agent 出错",
    });
    expect((locked as HTMLButtonElement).disabled).toBe(true);
  });

  it("没有设备名时用平台名；当前设备带标记", async () => {
    devices.mockResolvedValue({
      devices: [device({ platform: "web", current: true, editable: true })],
    });
    mount();
    expect(await screen.findByText("当前设备")).toBeTruthy();
    expect(screen.getAllByText("浏览器").length).toBeGreaterThan(0);
  });

  it("保存失败：开关退回原样并提示", async () => {
    devices.mockResolvedValue({
      devices: [device({ deviceName: "我的 iPhone", editable: true })],
    });
    setKinds.mockRejectedValue(new Error("boom"));
    mount();
    await open("我的 iPhone");
    const toggle = screen.getByRole("switch", {
      name: "我的 iPhone · 等待审批",
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "我的 iPhone · 等待审批" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });
});
