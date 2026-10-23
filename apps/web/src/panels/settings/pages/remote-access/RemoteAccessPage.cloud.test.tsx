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

import { RemoteAccessPage } from "./RemoteAccessPage";

/**
 * 远程访问页与 Armadra 云的接线（云端控制台 §3.5.1）：行菜单「打开控制台」。
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
