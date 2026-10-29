import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrustedDevice } from "@armadra/shared";

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { dispatchWorkspaceEvent } from "@/api/events";
import { localSource } from "@/api/source";
import { DeviceEndorsedNotice } from "./E2eDevices";

const devices = vi.hoisted(() => ({ list: vi.fn() }));
const platform = vi.hoisted(() => ({ notify: vi.fn(async () => undefined) }));
vi.mock("../../../../api/devices", () => ({
  DEVICES_QUERY_KEY: ["devices"],
  devicesApi: devices,
}));
vi.mock("../../../../platform", async (load) => ({
  ...(await load<typeof import("../../../../platform")>()),
  notify: platform.notify,
}));

installDomPolyfills();

const row = (over: Partial<TrustedDevice>): TrustedDevice => ({
  deviceId: "dev",
  principalId: "p",
  principalName: "",
  principalKind: "member",
  label: "",
  platform: "browser",
  status: "trusted",
  pendingId: null,
  approvedBy: "local",
  issuer: "",
  fingerprint: "f",
  createdAtMs: 1,
  approvedAtMs: 1,
  lastSeenAtMs: 1,
  revokedAtMs: 0,
  ...over,
});

const endorsed = (sourceId = localSource.sourceId) =>
  act(() =>
    dispatchWorkspaceEvent(
      {
        type: "devices.endorsed",
        deviceId: "dev_new",
        principalId: "p_member",
        endorserDeviceId: "dev_browser",
        endorserPrincipalId: "p_owner",
      },
      sourceId,
    ),
  );

afterEach(() => {
  cleanup();
  devices.list.mockReset();
  platform.notify.mockClear();
});

describe("背书通知（契约 §88.7）", () => {
  it("本机收到 devices.endorsed：说明哪台设备放行了谁的哪台设备，另发系统通知", async () => {
    devices.list.mockResolvedValue([
      row({
        deviceId: "dev_browser",
        principalId: "p_owner",
        principalKind: "owner",
        label: "Armadra Web (Chrome)",
      }),
      row({
        deviceId: "dev_new",
        principalId: "p_member",
        principalName: "李四",
        label: "iPad",
        approvedBy: "endorse:dev_browser",
      }),
    ]);
    render(
      <TestProviders>
        <DeviceEndorsedNotice />
      </TestProviders>,
    );
    endorsed();
    const title = "Armadra Web (Chrome) 放行了 李四 的 iPad";
    expect(await screen.findByText(title)).toBeTruthy();
    expect(platform.notify).toHaveBeenCalledWith(title, "");
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByText(title)).toBeNull());
  });

  it("别的主机的事件、查不到这台设备：不弹", async () => {
    devices.list.mockResolvedValue([]);
    render(
      <TestProviders>
        <DeviceEndorsedNotice />
      </TestProviders>,
    );
    endorsed("src_remote");
    expect(devices.list).not.toHaveBeenCalled();
    endorsed();
    await waitFor(() => expect(devices.list).toHaveBeenCalledTimes(1));
    await new Promise((done) => setTimeout(done, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(platform.notify).not.toHaveBeenCalled();
  });
});
