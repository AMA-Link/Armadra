import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceEndorsement } from "@armadra/shared";

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { dispatchWorkspaceEvent } from "@/api/events";
import { localSource } from "@/api/source";
import { useNeedsStore } from "@/notifications/needs-store";
import { useHostNeedsSync } from "@/notifications/use-host-needs";
import { DeviceEndorsedNotice } from "./E2eDevices";

const devices = vi.hoisted(() => ({
  endorsements: vi.fn(),
  markEndorsementsRead: vi.fn(async () => undefined),
}));
const platform = vi.hoisted(() => ({
  notify: vi.fn(async (_title: string, _body: string) => undefined),
}));
vi.mock("../../../../api/devices", () => ({
  DEVICES_QUERY_KEY: ["devices"],
  ENDORSEMENTS_QUERY_KEY: ["endorsements"],
  devicesApi: devices,
}));
vi.mock("../../../../platform", async (load) => ({
  ...(await load<typeof import("../../../../platform")>()),
  notify: platform.notify,
}));

installDomPolyfills();

const record = (
  id: string,
  over: Partial<DeviceEndorsement> = {},
): DeviceEndorsement => ({
  id,
  deviceId: `dev_${id}`,
  principalId: "p_member",
  principalName: "李四",
  deviceLabel: `iPad ${id}`,
  devicePlatform: "ios",
  endorserDeviceId: "dev_browser",
  endorserPrincipalId: "p_owner",
  endorserLabel: "Armadra Web (Chrome)",
  createdAtMs: 1,
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

function Harness() {
  useHostNeedsSync();
  return <DeviceEndorsedNotice />;
}

const mount = () =>
  render(
    <TestProviders>
      <Harness />
    </TestProviders>,
  );

const title = (id: string) => `Armadra Web (Chrome) 放行了 李四 的 iPad ${id}`;

beforeEach(() => {
  useNeedsStore.setState({ host: [], hostSynced: false });
});

afterEach(() => {
  cleanup();
  devices.endorsements.mockReset();
  devices.markEndorsementsRead.mockClear();
  platform.notify.mockClear();
});

describe("背书通知（契约 §88.7、§81.1）", () => {
  it("页面打开前错过的只进铃铛，不补弹", async () => {
    devices.endorsements.mockResolvedValue([record("old")]);
    mount();
    await waitFor(() =>
      expect(useNeedsStore.getState().host.map((row) => row.id)).toEqual([
        "old",
      ]),
    );
    await new Promise((done) => setTimeout(done, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(platform.notify).not.toHaveBeenCalled();
  });

  it("连续几次背书排成队列，按先后各弹一次并各发一条系统通知；「知道了」标已读后显示下一条", async () => {
    devices.endorsements.mockResolvedValue([record("old")]);
    mount();
    await waitFor(() => expect(useNeedsStore.getState().host).toHaveLength(1));
    // 列表新的在前：b 比 a 晚。
    devices.endorsements.mockResolvedValue([
      record("b"),
      record("a"),
      record("old"),
    ]);
    endorsed();
    expect(await screen.findByText(title("a"))).toBeTruthy();
    expect(platform.notify.mock.calls.map(([text]) => text)).toEqual([
      title("a"),
      title("b"),
    ]);
    expect(useNeedsStore.getState().host).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() =>
      expect(devices.markEndorsementsRead).toHaveBeenCalledWith(["a"]),
    );
    expect(await screen.findByText(title("b"))).toBeTruthy();
    expect(screen.queryByText(title("a"))).toBeNull();
    await waitFor(() =>
      expect(useNeedsStore.getState().host.map((row) => row.id)).toEqual([
        "b",
        "old",
      ]),
    );

    // Esc 只收起：不标已读，铃铛里还在。
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByText(title("b"))).toBeNull());
    expect(devices.markEndorsementsRead).toHaveBeenCalledTimes(1);
    expect(useNeedsStore.getState().host.map((row) => row.id)).toContain("b");
  });

  it("别的主机的事件不重读；标已读被拒（浏览器）时清单不动", async () => {
    devices.endorsements.mockResolvedValue([]);
    mount();
    await waitFor(() => expect(devices.endorsements).toHaveBeenCalledTimes(1));
    await new Promise((done) => setTimeout(done, 20));
    endorsed("src_remote");
    await new Promise((done) => setTimeout(done, 20));
    expect(devices.endorsements).toHaveBeenCalledTimes(1);

    devices.endorsements.mockResolvedValue([record("a")]);
    devices.markEndorsementsRead.mockRejectedValueOnce(new Error("forbidden"));
    endorsed();
    expect(await screen.findByText(title("a"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByText(title("a"))).toBeNull());
    expect(useNeedsStore.getState().host.map((row) => row.id)).toEqual(["a"]);
  });
});
