import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrustedDevice } from "@armadra/shared";

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { COMPACT_QUERY } from "@/platform/layout";
import { E2eDevices } from "./E2eDevices";

const devices = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../../../api/devices", () => ({
  DEVICES_QUERY_KEY: ["devices"],
  devicesApi: devices,
}));

installDomPolyfills();

const device: TrustedDevice = {
  deviceId: "dev-1",
  principalId: "p",
  principalName: "Owner",
  principalKind: "owner",
  label: "MacBook",
  platform: "desktop",
  status: "trusted",
  pendingId: null,
  approvedBy: "",
  issuer: "",
  fingerprint: "f",
  createdAtMs: 1,
  approvedAtMs: 1,
  lastSeenAtMs: 1_700_000_000_000,
  revokedAtMs: 0,
};

const original = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = original;
  devices.list.mockReset();
});

function phone(compact: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: compact && query === COMPACT_QUERY,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

describe("已配对设备：窄屏换成列表", () => {
  it("手机宽度画一行一台的列表，没有会被裁的表格", async () => {
    phone(true);
    devices.list.mockResolvedValue([device]);
    render(
      <TestProviders>
        <E2eDevices />
      </TestProviders>,
    );
    await screen.findByText("MacBook");
    expect(document.querySelector("[data-slot=e2e-devices-list]")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: "操作" })).toBeTruthy();
  });

  it("桌面宽度仍是表格", async () => {
    phone(false);
    devices.list.mockResolvedValue([device]);
    render(
      <TestProviders>
        <E2eDevices />
      </TestProviders>,
    );
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(document.querySelector("[data-slot=e2e-devices-list]")).toBeNull();
  });
});
