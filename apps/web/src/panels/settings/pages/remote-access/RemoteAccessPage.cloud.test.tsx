import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills } from "@/app/test-harness";

const api = vi.hoisted(() => ({
  listSources: vi.fn(),
  addCloud: vi.fn(),
  pollCloudDevice: vi.fn(),
  relayPending: vi.fn(),
  shareStatus: vi.fn(),
  notifyShellSourcesChanged: vi.fn(),
  remotePasswordChangeable: vi.fn(),
}));
vi.mock("../../../../api/remote-services", async (original) => ({
  ...(await original<typeof import("../../../../api/remote-services")>()),
  ...api,
}));
const platform = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("../../../../platform", async (original) => ({
  ...(await original<typeof import("../../../../platform")>()),
  ...platform,
}));
const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@/ui/toast", () => ({ toast: toasts }));
vi.mock("../../../../sources/bootstrap", () => ({
  applySourceTable: vi.fn(async () => undefined),
  reloadIntoSettings: vi.fn(),
}));
vi.mock("../../../../app/workspaces-query", () => ({
  useWorkspacesQuery: () => ({ data: [] }),
}));
vi.mock("../../remote-access", async (original) => ({
  ...(await original<typeof import("../../remote-access")>()),
  useRemoteAccess: () => ({ remote: false, via: null, relayIssuer: null }),
}));
vi.mock("../../../../api/gateway", async (original) => ({
  ...(await original<typeof import("../../../../api/gateway")>()),
  gatewayApi: { status: vi.fn().mockRejectedValue(new Error("forbidden")) },
}));

import { offerCloudLink } from "../../../../sources/cloud-intent";
import { RemoteAccessPage } from "./RemoteAccessPage";

/**
 * 远程访问页与 Armadra 云的两处接线（云端控制台 §3.5.1）：行菜单「打开控制台」与
 * `armadra://cloud` 深链打开「添加 Armadra 云」。
 */

const local = {
  sourceId: "h".repeat(32),
  kind: "local",
  label: "this-mac",
  baseUrl: "",
  relayOrigin: "",
  fingerprint: "",
  cloudIssuer: "",
  principalHint: "owner",
  addedAtMs: 1,
  lastOkAtMs: 1,
  orderIndex: 0,
  hasCredentials: true,
};
const cloud = {
  serviceId: "cloud",
  kind: "saas",
  issuer: "https://cloud.test",
  label: "cloud.test",
  accountHint: "ada@example.test",
  fingerprint: "",
  addedAtMs: 1,
  lastOkAtMs: 1,
  registered: false,
  hasCredentials: true,
};

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
  api.notifyShellSourcesChanged.mockResolvedValue(false);
  api.relayPending.mockResolvedValue([]);
  api.remotePasswordChangeable.mockResolvedValue(false);
  api.shareStatus.mockResolvedValue({ sourceId: "h", registrations: [] });
});
afterEach(() => {
  cleanup();
  for (const spy of [
    ...Object.values(api),
    ...Object.values(toasts),
    platform.openExternal,
  ])
    spy.mockReset();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RemoteAccessPage />
    </QueryClientProvider>,
  );
}

function openMenu(name: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: `Actions for ${name}` }),
    { button: 0, ctrlKey: false },
  );
}

describe("行菜单「打开控制台」", () => {
  it("Armadra 云的行：点了在系统浏览器打开 <issuer>/me", async () => {
    platform.openExternal.mockResolvedValue(true);
    api.listSources.mockResolvedValue({ sources: [local], remotes: [cloud] });
    mount();
    await screen.findByText("cloud.test");
    openMenu("cloud.test");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Open console" }),
    );
    expect(platform.openExternal).toHaveBeenCalledWith("https://cloud.test/me");
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("壳没能打开浏览器：给一句提示", async () => {
    platform.openExternal.mockResolvedValue(false);
    api.listSources.mockResolvedValue({ sources: [local], remotes: [cloud] });
    mount();
    await screen.findByText("cloud.test");
    openMenu("cloud.test");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Open console" }),
    );
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Could not open the browser"),
    );
  });

  it("个人中转的行没有这一项", async () => {
    api.listSources.mockResolvedValue({
      sources: [local],
      remotes: [{ ...cloud, kind: "personal", label: "relay.test" }],
    });
    mount();
    await screen.findByText("relay.test");
    openMenu("relay.test");
    await screen.findByRole("menuitem", { name: "Rename" });
    expect(screen.queryByRole("menuitem", { name: "Open console" })).toBeNull();
  });
});

describe("armadra://cloud 深链", () => {
  it("深链交来：打开「添加 Armadra 云」，地址预填，不自动取设备码", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    mount();
    await screen.findByText("This computer");
    offerCloudLink(
      `armadra://cloud?issuer=${encodeURIComponent("https://cloud.test")}`,
    );
    const field = (await screen.findByLabelText("Address")) as HTMLInputElement;
    expect(field.value).toBe("https://cloud.test");
    expect(
      screen.getByRole("button", { name: "Get device code" }),
    ).toBeTruthy();
    await new Promise((done) => setTimeout(done, 30));
    expect(api.addCloud).not.toHaveBeenCalled();
  });

  it("没有 issuer 的深链：对话框打开，地址为空", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    mount();
    await screen.findByText("This computer");
    offerCloudLink("armadra://cloud");
    const field = (await screen.findByLabelText("Address")) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(api.addCloud).not.toHaveBeenCalled();
  });

  it("深链带来的不是已有账号的地址：对话框醒目显示目标域名；已有账号的不提示", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [cloud] });
    mount();
    await screen.findByText("cloud.test");
    offerCloudLink(
      `armadra://cloud?issuer=${encodeURIComponent("https://other.example")}`,
    );
    expect(await screen.findByText("This link connects to")).toBeTruthy();
    expect(screen.getByText("other.example")).toBeTruthy();
    cleanup();
    mount();
    await screen.findByText("cloud.test");
    offerCloudLink(
      `armadra://cloud?issuer=${encodeURIComponent("https://cloud.test")}`,
    );
    await screen.findByLabelText("Address");
    expect(screen.queryByText("This link connects to")).toBeNull();
  });

  it("对话框已不在填地址步骤：新的深链丢掉，不换成别的云", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    api.addCloud.mockResolvedValue({
      remote: { ...cloud, hasCredentials: false },
      next: {
        deviceCode: {
          userCode: "ABCD-EFGH",
          verificationUrl: "https://cloud.test/device",
          expiresAtMs: Date.now() + 600_000,
          intervalMs: 600_000,
        },
      },
    });
    api.pollCloudDevice.mockResolvedValue({ status: "pending" });
    mount();
    await screen.findByText("This computer");
    offerCloudLink(
      `armadra://cloud?issuer=${encodeURIComponent("https://cloud.test")}`,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Get device code" }),
    );
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    offerCloudLink(
      `armadra://cloud?issuer=${encodeURIComponent("https://evil.example")}`,
    );
    await new Promise((done) => setTimeout(done, 40));
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.queryByText("evil.example")).toBeNull();
    expect(api.addCloud).toHaveBeenCalledTimes(1);
  });

  it("还在填地址：新的深链换掉预填的地址", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    mount();
    await screen.findByText("This computer");
    offerCloudLink(
      `armadra://cloud?issuer=${encodeURIComponent("https://a.example")}`,
    );
    const field = (await screen.findByLabelText("Address")) as HTMLInputElement;
    expect(field.value).toBe("https://a.example");
    offerCloudLink(
      `armadra://cloud?issuer=${encodeURIComponent("https://b.example")}`,
    );
    await waitFor(() => expect(field.value).toBe("https://b.example"));
  });
});
