import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills } from "@/app/test-harness";

const api = vi.hoisted(() => ({
  listSources: vi.fn(),
  addCloud: vi.fn(),
  remoteSources: vi.fn(),
  mountRemoteSource: vi.fn(),
  relayPending: vi.fn(),
  shareStatus: vi.fn(),
  notifyShellSourcesChanged: vi.fn(),
  remotePasswordChangeable: vi.fn(),
  listShareLinks: vi.fn(),
}));
vi.mock("../../../../api/remote-services", async (original) => ({
  ...(await original<typeof import("../../../../api/remote-services")>()),
  ...api,
}));
vi.mock("@/ui/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
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

/** 「我的其他电脑」的添加入口按账号情况显示（#677）。 */

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
  guest: false,
};
const relay = {
  ...cloud,
  serviceId: "relay",
  kind: "personal",
  issuer: "https://relay.test:8102",
  label: "relay.test:8102",
  accountHint: "dev",
  fingerprint: "ab".repeat(32),
};
const summary = {
  kind: "desktop",
  online: true,
  lastSeenAtMs: 1,
  owner: true,
  via: "owner",
  relayOrigin: "https://cloud.test",
  coreVersion: "0.11.0",
  mounted: false,
};

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
  api.notifyShellSourcesChanged.mockResolvedValue(false);
  api.relayPending.mockResolvedValue([]);
  api.remotePasswordChangeable.mockResolvedValue(false);
  api.shareStatus.mockResolvedValue({ sourceId: "h", registrations: [] });
  api.listShareLinks.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  for (const spy of Object.values(api)) spy.mockReset();
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

/** 「我的其他电脑」那一组里的按钮。 */
async function mineGroup() {
  const title = (await screen.findAllByText("My other computers"))[0]!;
  return within(title.closest("section, div")!.parentElement!);
}

describe("我的其他电脑 · 添加入口", () => {
  it("登录着 Armadra 云：「从 Armadra 云添加」，列出云上自己的其他电脑并连接", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [cloud] });
    api.remoteSources.mockResolvedValue({
      sources: [
        { ...summary, sourceId: local.sourceId, name: "self-row" },
        { ...summary, sourceId: "o".repeat(32), name: "studio" },
        {
          ...summary,
          sourceId: "t".repeat(32),
          name: "team-box",
          via: "org",
          owner: false,
        },
      ],
    });
    api.mountRemoteSource.mockResolvedValue({});
    mount();
    const button = await screen.findByRole("button", {
      name: "Add from Armadra Cloud",
    });
    expect(
      screen.queryByRole("button", { name: "Add from account" }),
    ).toBeNull();
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("studio")).toBeTruthy();
    expect(api.remoteSources).toHaveBeenCalledWith("cloud");
    // 本机与别人 / 团队的不列。
    await waitFor(() =>
      expect(within(dialog).queryByText("self-row")).toBeNull(),
    );
    expect(within(dialog).queryByText("team-box")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(api.mountRemoteSource).toHaveBeenCalledWith(
        "cloud",
        "o".repeat(32),
      ),
    );
  });

  it("云与个人中转都登录着：取 Armadra 云，下拉里没有中转", async () => {
    api.listSources.mockResolvedValue({
      sources: [local],
      remotes: [relay, cloud],
    });
    api.remoteSources.mockResolvedValue({ sources: [] });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add from Armadra Cloud" }),
    );
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(api.remoteSources).toHaveBeenCalledWith("cloud"),
    );
    expect(api.remoteSources).not.toHaveBeenCalledWith("relay");
    expect(within(dialog).queryByRole("combobox")).toBeNull();
  });

  it("只有个人中转：保留原来的「从中转账号添加」", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [relay] });
    api.remoteSources.mockResolvedValue({
      sources: [{ ...summary, sourceId: "o".repeat(32), name: "studio" }],
    });
    mount();
    const button = await screen.findByRole("button", {
      name: "Add from account",
    });
    expect(
      screen.queryByRole("button", { name: "Add from Armadra Cloud" }),
    ).toBeNull();
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("studio")).toBeTruthy();
    expect(api.remoteSources).toHaveBeenCalledWith("relay");
  });

  it("都没有：「登录 Armadra 云」，打开设备码登录，用默认地址", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    mount();
    const group = await mineGroup();
    expect(
      group.queryByRole("button", { name: "Add from account" }),
    ).toBeNull();
    expect(
      group.queryByRole("button", { name: "Add from Armadra Cloud" }),
    ).toBeNull();
    fireEvent.click(
      await group.findByRole("button", { name: "Sign in to Armadra Cloud" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: "Sign in" }),
    ).toBeTruthy();
    expect(
      dialog.querySelector('[data-slot="cloud-issuer"]')?.textContent,
    ).toBe("app.armadra.com");
    expect(api.addCloud).not.toHaveBeenCalled();
  });

  it("Armadra 云登出了：「登录 Armadra 云」带那一行的地址", async () => {
    api.listSources.mockResolvedValue({
      sources: [local],
      remotes: [{ ...cloud, hasCredentials: false }],
    });
    mount();
    const group = await mineGroup();
    fireEvent.click(
      await group.findByRole("button", { name: "Sign in to Armadra Cloud" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      dialog.querySelector('[data-slot="cloud-issuer"]')?.textContent,
    ).toBe("cloud.test");
  });
});
