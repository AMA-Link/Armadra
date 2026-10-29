import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrustedDevice } from "@armadra/shared";

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { dispatchWorkspaceEvent } from "@/api/events";
import { localSource } from "@/api/source";
import { DeviceApprovalPrompt, E2eDevices } from "./E2eDevices";

const devices = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../../../api/devices", () => ({
  DEVICES_QUERY_KEY: ["devices"],
  devicesApi: devices,
}));

installDomPolyfills();

const HINT = "放行后，它能批准主人的新设备";

const row = (over: Partial<TrustedDevice>): TrustedDevice => ({
  deviceId: "dev",
  principalId: "p",
  principalName: "",
  principalKind: "owner",
  label: "MacBook",
  platform: "desktop",
  status: "pending",
  pendingId: "pend-1",
  approvedBy: "",
  issuer: "",
  fingerprint: "f",
  createdAtMs: 1,
  approvedAtMs: 0,
  lastSeenAtMs: 1,
  revokedAtMs: 0,
  ...over,
});

const pending = (platform: string) =>
  act(() =>
    dispatchWorkspaceEvent(
      {
        type: "devices.pending",
        pendingId: "pend-1",
        deviceId: "dev",
        label: "MacBook",
        platform,
      },
      localSource.sourceId,
    ),
  );

const prompt = () =>
  render(
    <TestProviders>
      <DeviceApprovalPrompt />
    </TestProviders>,
  );

afterEach(() => {
  cleanup();
  devices.list.mockReset();
});

describe("放行提示显示设备自报的平台（契约 §88.7）", () => {
  it("主人的新设备自报 desktop：徽标「桌面」，并提示放行后它能批准主人的新设备", async () => {
    devices.list.mockResolvedValue([row({})]);
    prompt();
    pending("desktop");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("MacBook 请求访问")).toBeTruthy();
    expect(within(dialog).getByText("桌面")).toBeTruthy();
    await waitFor(() => expect(devices.list).toHaveBeenCalled());
    expect(within(dialog).getByText(HINT)).toBeTruthy();
  });

  it("自报 browser：徽标「浏览器」，没有那句提示", async () => {
    devices.list.mockResolvedValue([row({ platform: "browser" })]);
    prompt();
    pending("browser");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("浏览器")).toBeTruthy();
    await waitFor(() => expect(devices.list).toHaveBeenCalled());
    expect(within(dialog).queryByText(HINT)).toBeNull();
  });

  it("成员的原生设备：只显示平台，不提示（成员的设备批不了主人的）", async () => {
    devices.list.mockResolvedValue([row({ principalKind: "member" })]);
    prompt();
    pending("ios");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("iOS")).toBeTruthy();
    await waitFor(() => expect(within(dialog).queryByText(HINT)).toBeNull());
  });

  it("成员的原生设备申请：申请人查回来之前提示只占位、不可见，查回来是成员就去掉，从不闪现", async () => {
    let answer: (rows: TrustedDevice[]) => void = () => undefined;
    devices.list.mockReturnValue(
      new Promise<TrustedDevice[]>((resolve) => {
        answer = resolve;
      }),
    );
    prompt();
    pending("android");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Android")).toBeTruthy();
    const placeholder = within(dialog).getByText(HINT);
    expect(placeholder.classList.contains("invisible")).toBe(true);
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    await act(async () => answer([row({ principalKind: "member" })]));
    await waitFor(() => expect(within(dialog).queryByText(HINT)).toBeNull());
  });

  it("主人的原生设备申请：查回来之前占位，查回来后显示", async () => {
    let answer: (rows: TrustedDevice[]) => void = () => undefined;
    devices.list.mockReturnValue(
      new Promise<TrustedDevice[]>((resolve) => {
        answer = resolve;
      }),
    );
    prompt();
    pending("desktop");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(HINT).classList.contains("invisible")).toBe(
      true,
    );
    await act(async () => answer([row({})]));
    await waitFor(() =>
      expect(
        within(dialog).getByText(HINT).classList.contains("invisible"),
      ).toBe(false),
    );
    expect(
      within(dialog).getByText(HINT).getAttribute("aria-hidden"),
    ).toBeNull();
  });

  it("查不到申请人（设备列表失败、或里面没有这条待确认）：原生端仍显示提示", async () => {
    const visibleHint = async () => {
      const dialog = await screen.findByRole("dialog");
      await waitFor(() =>
        expect(
          within(dialog).getByText(HINT).classList.contains("invisible"),
        ).toBe(false),
      );
    };
    devices.list.mockRejectedValue(new Error("forbidden"));
    prompt();
    pending("ios");
    await visibleHint();
    cleanup();
    devices.list.mockReset();
    devices.list.mockResolvedValue([row({ pendingId: "someone-else" })]);
    prompt();
    pending("desktop");
    await visibleHint();
  });

  it("设备列表：每行有平台徽标；主人待确认的原生设备行内有提示", async () => {
    devices.list.mockResolvedValue([
      row({}),
      row({
        deviceId: "dev-2",
        principalId: "p-2",
        principalKind: "member",
        principalName: "李四",
        label: "Chrome",
        platform: "browser",
        status: "trusted",
        pendingId: null,
      }),
    ]);
    render(
      <TestProviders>
        <E2eDevices />
      </TestProviders>,
    );
    const table = await screen.findByRole("table");
    expect(within(table).getByText("桌面")).toBeTruthy();
    expect(within(table).getByText("浏览器")).toBeTruthy();
    expect(within(table).getAllByText(HINT)).toHaveLength(1);
  });
});
