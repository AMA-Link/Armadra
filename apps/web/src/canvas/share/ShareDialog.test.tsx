import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
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
import { useCanvasStore } from "@/store/canvas-store";

const api = vi.hoisted(() => ({
  listSources: vi.fn(),
  shareStatus: vi.fn(),
  shareThisMachine: vi.fn(),
  stopSharing: vi.fn(),
  createShareLink: vi.fn(),
  addCloud: vi.fn(),
  pollCloudDevice: vi.fn(),
  cloudSpaces: vi.fn(),
  registerToSpace: vi.fn(),
  notifyShellSourcesChanged: vi.fn(),
}));
vi.mock("@/api/remote-services", async (original) => ({
  ...(await original<typeof import("@/api/remote-services")>()),
  ...api,
}));
vi.mock("@/agent/sessions", async (original) => ({
  ...(await original<typeof import("@/agent/sessions")>()),
  sessionsQuery: (workspaceId: string | null) => ({
    queryKey: ["test-sessions", workspaceId],
    queryFn: async () =>
      workspaceId === "w1" ? [{ sessionId: "s-build", title: "build" }] : [],
  }),
}));
vi.mock("@/ui/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { ShareDialog } from "./ShareDialog";
import { openShare, useShareStore } from "./share-store";

const ISSUER = "https://relay.test:8102";
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
const relay = {
  serviceId: "svc",
  kind: "personal",
  issuer: ISSUER,
  label: "relay.test:8102",
  accountHint: "dev",
  fingerprint: "ab".repeat(32),
  addedAtMs: 1,
  lastOkAtMs: 1,
  registered: true,
  hasCredentials: true,
  guest: false,
};
const CLOUD_ISSUER = "https://cloud.test";
const cloud = {
  serviceId: "cloud",
  kind: "saas",
  issuer: CLOUD_ISSUER,
  label: "cloud.test",
  accountHint: "ada@example.test",
  fingerprint: "",
  addedAtMs: 1,
  lastOkAtMs: 1,
  registered: false,
  hasCredentials: true,
  guest: false,
};
const cloudRegistered = {
  sourceId: local.sourceId,
  registrations: [
    {
      issuer: CLOUD_ISSUER,
      mode: "personal",
      tunnel: {
        state: "ready",
        node: null,
        since: null,
        streams: 0,
        lastError: null,
      },
    },
  ],
};
const registered = {
  sourceId: local.sourceId,
  registrations: [
    {
      issuer: ISSUER,
      mode: "personal",
      tunnel: {
        state: "ready",
        node: null,
        since: null,
        streams: 0,
        lastError: null,
      },
    },
  ],
};
const URL_ = `${ISSUER}/j/L#S.inv.tok`;

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
  api.notifyShellSourcesChanged.mockResolvedValue(false);
  api.createShareLink.mockResolvedValue({
    link: { linkId: "L", label: "Project" },
    url: URL_,
  });
});
afterEach(() => {
  cleanup();
  for (const spy of Object.values(api)) spy.mockReset();
  act(() => useShareStore.getState().close());
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ShareDialog />
    </QueryClientProvider>,
  );
  act(() => openShare({ workspaceId: "w1", workspaceName: "Project" }));
}

function choose(trigger: string, option: string) {
  fireEvent.pointerDown(screen.getByRole("combobox", { name: trigger }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("画布分享弹层（#301 B5）", () => {
  it("缺省：此工作空间、只读、7 天；建好给二维码与整条链接", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [relay] });
    api.shareStatus.mockResolvedValue(registered);
    mount();
    const dialog = await screen.findByTestId("share-dialog");
    expect(within(dialog).getByText("Share “Project”")).toBeTruthy();
    expect(
      within(dialog).getByRole("combobox", { name: "Scope" }).textContent,
    ).toContain("This workspace");
    expect(
      within(dialog).getByRole("combobox", { name: "Role" }).textContent,
    ).toContain("View only");
    expect(
      within(dialog).getByRole("combobox", { name: "Expires in" }).textContent,
    ).toContain("7 days");
    const create = within(dialog).getByRole("button", { name: "Create link" });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(create);
    await waitFor(() =>
      expect(api.createShareLink).toHaveBeenCalledWith({
        serviceId: "svc",
        target: "workspace",
        workspaceId: "w1",
        readOnly: true,
        role: "viewer",
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        maxUses: 1000,
        label: "Project",
      }),
    );
    const qr = await screen.findByRole("img", { name: "Share link QR code" });
    expect(qr.getAttribute("data-qr-text")).toBe(URL_);
  });

  it("权限只给只读 / 可编辑 / 可执行；仅此会话时不给权限，链接带会话", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [relay] });
    api.shareStatus.mockResolvedValue(registered);
    mount();
    await screen.findByTestId("share-dialog");
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Role" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const options = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["View only", "Can edit", "Can run"]);
    fireEvent.click(screen.getByRole("option", { name: "Can edit" }));
    choose("Expires in", "30 days");
    const create = screen.getByRole("button", { name: "Create link" });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(create);
    await waitFor(() =>
      expect(api.createShareLink).toHaveBeenLastCalledWith(
        expect.objectContaining({
          readOnly: false,
          role: "editor",
          ttlMs: 30 * 24 * 60 * 60 * 1000,
        }),
      ),
    );

    cleanup();
    mount();
    await screen.findByTestId("share-dialog");
    choose("Scope", "Only this session");
    expect(screen.queryByRole("combobox", { name: "Role" })).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Session" }).textContent,
      ).toContain("build"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() =>
      expect(api.createShareLink).toHaveBeenLastCalledWith(
        expect.objectContaining({
          target: "session",
          sessionId: "s-build",
          readOnly: true,
          role: "viewer",
          label: "build",
        }),
      ),
    );
  });

  it("互联网路线没开：建不了；只有个人中转账号时一键开，不弹登录", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [relay] });
    api.shareStatus.mockResolvedValue({
      sourceId: local.sourceId,
      registrations: [],
    });
    api.shareThisMachine.mockResolvedValue({ sourceId: local.sourceId });
    mount();
    const turnOn = await screen.findByRole("button", {
      name: "Turn on Internet route",
    });
    expect(
      screen
        .getByRole("button", { name: "Create link" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(turnOn);
    await waitFor(() =>
      expect(api.shareThisMachine).toHaveBeenCalledWith({
        serviceId: "svc",
        issuer: ISSUER,
        label: "this-mac",
      }),
    );
    expect(api.addCloud).not.toHaveBeenCalled();
  });

  it("没有任何账号：登录 Armadra 云（设备码）→ 选空间登记 → 再签分享链接（#677）", async () => {
    let signedIn = false;
    api.listSources.mockImplementation(async () => ({
      sources: [local],
      remotes: signedIn ? [{ ...cloud, registered: true }] : [],
    }));
    api.shareStatus.mockImplementation(async () =>
      signedIn
        ? cloudRegistered
        : { sourceId: local.sourceId, registrations: [] },
    );
    const device = {
      userCode: "ABCD-EFGH",
      verificationUrl: `${CLOUD_ISSUER}/device`,
      expiresAtMs: Date.now() + 600_000,
      intervalMs: 10,
    };
    api.addCloud.mockResolvedValue({
      remote: { ...cloud, hasCredentials: false },
      next: { deviceCode: device },
    });
    api.pollCloudDevice.mockResolvedValue({ status: "ready" });
    api.cloudSpaces.mockResolvedValue({
      spaces: [{ kind: "personal", plan: "free" }],
    });
    api.registerToSpace.mockImplementation(async () => {
      signedIn = true;
      return { remote: cloud, sourceId: local.sourceId };
    });
    mount();
    const dialog = await screen.findByTestId("share-dialog");
    // 没有路线：按钮是「登录 Armadra 云」，不是旧的中转账号表单。
    expect(
      within(dialog)
        .getByRole("button", { name: "Create link" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Sign in to Armadra Cloud",
      }),
    );
    const cloudDialog = await screen.findByText("Sign in", {
      selector: "button",
    });
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(api.addCloud).not.toHaveBeenCalled();
    fireEvent.click(cloudDialog);
    await waitFor(() =>
      expect(api.addCloud).toHaveBeenCalledWith("https://app.armadra.com"),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Register this computer" }),
    );
    await waitFor(() =>
      expect(api.registerToSpace).toHaveBeenCalledWith({
        serviceId: "cloud",
        space: { kind: "personal" },
      }),
    );
    // 登记完，弹层里的路线行消失，可以建链接。
    await waitFor(() =>
      expect(screen.queryByText("Internet route")).toBeNull(),
    );
    const create = screen.getByRole("button", { name: "Create link" });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(create);
    await waitFor(() =>
      expect(api.createShareLink).toHaveBeenCalledWith(
        expect.objectContaining({ serviceId: "cloud", target: "workspace" }),
      ),
    );
  });

  it("登录着 Armadra 云、本机没登记：直接选空间登记，不再登录（#677）", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [cloud] });
    api.shareStatus.mockResolvedValue({
      sourceId: local.sourceId,
      registrations: [],
    });
    api.addCloud.mockResolvedValue({ remote: cloud, next: "ready" });
    api.cloudSpaces.mockResolvedValue({
      spaces: [{ kind: "personal", plan: "free" }],
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Register this computer" }),
    );
    await waitFor(() =>
      expect(api.addCloud).toHaveBeenCalledWith(CLOUD_ISSUER),
    );
    expect(
      await screen.findByText("Register to", { selector: "label" }),
    ).toBeTruthy();
    expect(api.pollCloudDevice).not.toHaveBeenCalled();
    expect(api.shareThisMachine).not.toHaveBeenCalled();
  });

  it("Armadra 云登出了：登录那一行的地址（#677）", async () => {
    api.listSources.mockResolvedValue({
      sources: [local],
      remotes: [{ ...cloud, hasCredentials: false }],
    });
    api.shareStatus.mockResolvedValue({
      sourceId: local.sourceId,
      registrations: [],
    });
    mount();
    const signIn = await screen.findByRole("button", {
      name: "Sign in to Armadra Cloud",
    });
    // 账号表读到之前按钮已经在了：等表到，才知道登出的那一行的地址。
    await waitFor(() => expect(api.listSources).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 30));
    fireEvent.click(signIn);
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="cloud-issuer"]')?.textContent,
      ).toBe("cloud.test"),
    );
  });

  it("「管理链接」关掉弹层，去设置 → 远程访问", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [relay] });
    api.shareStatus.mockResolvedValue(registered);
    mount();
    await screen.findByTestId("share-dialog");
    fireEvent.click(screen.getByRole("button", { name: "Manage links" }));
    expect(useShareStore.getState().request).toBeNull();
    expect(usePreferencesStore.getState().lastSettingsSection).toBe(
      "remoteAccess",
    );
    expect(useCanvasStore.getState().panels.settings).toBe(true);
  });
});
