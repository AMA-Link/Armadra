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
  pollCloudDevice: vi.fn(),
  cloudSpaces: vi.fn(),
  registerToSpace: vi.fn(),
  registeredSpace: vi.fn(),
  shareStatus: vi.fn(),
  shareThisMachine: vi.fn(),
  stopSharing: vi.fn(),
  relayPending: vi.fn(),
  notifyShellSourcesChanged: vi.fn(),
  listShareLinks: vi.fn(),
}));
vi.mock("../../../../api/remote-services", async (original) => ({
  ...(await original<typeof import("../../../../api/remote-services")>()),
  ...api,
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
const access = vi.hoisted(() => ({
  remote: false,
  via: null as "direct" | "relayed" | null,
  relayIssuer: null as string | null,
}));
vi.mock("../../remote-access", async (original) => ({
  ...(await original<typeof import("../../remote-access")>()),
  useRemoteAccess: () => access,
}));
const gateway = vi.hoisted(() => ({
  status: vi.fn(),
  configure: vi.fn(),
  pair: vi.fn(),
}));
vi.mock("../../../../api/gateway", async (original) => ({
  ...(await original<typeof import("../../../../api/gateway")>()),
  gatewayApi: gateway,
}));

import { HostAccess } from "./HostAccess";

/**
 * 「这台电脑」三行（#675）：开关、互联网访问、手机扫码连接。互联网访问以 Armadra 云
 * 为缺省：已登记 / 登录着没登记 / 没登录三种状态各走一遍，只有个人中转时不变，
 * 取消任何一步都退回仅局域网。
 */

const ISSUER = "https://relay.test:8102";
const CLOUD = "https://cloud.test";
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
  registered: false,
  hasCredentials: true,
};
const cloud = {
  serviceId: "cloud",
  kind: "saas",
  issuer: CLOUD,
  label: "cloud.test",
  accountHint: "ada@example.test",
  fingerprint: "",
  addedAtMs: 1,
  lastOkAtMs: 1,
  registered: false,
  hasCredentials: true,
};
const lan = {
  enabled: true,
  running: true,
  managedBy: "settings",
  listen: "private",
  port: 8443,
  publicOrigin: "",
  address: { host: "0.0.0.0", port: 8443 },
  origin: "https://192.168.1.8:8443",
  origins: ["https://192.168.1.8:8443", "https://100.67.25.43:8443"],
  tls: {
    source: "localCa",
    certFile: "",
    keyFile: "",
    acmeEmail: "",
    fingerprint: "ab".repeat(32),
    subject: null,
    names: [],
    notAfter: null,
    caAvailable: true,
  },
  error: null,
};
const registration = (issuer: string, mode: "personal" | "saas") => ({
  sourceId: local.sourceId,
  registrations: [
    {
      issuer,
      mode,
      label: "this-mac",
      registeredAtMs: 1,
      tunnel: { state: "ready", node: "a" },
      relayOrigins: [],
    },
  ],
});
const spaces = {
  spaces: [
    { kind: "personal", plan: "free" },
    {
      kind: "team",
      teamId: "t1",
      slug: "acme",
      name: "Acme",
      role: "admin",
      plan: "team",
    },
  ],
};

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
  api.notifyShellSourcesChanged.mockResolvedValue(false);
  api.relayPending.mockResolvedValue([]);
  api.shareStatus.mockResolvedValue({
    sourceId: local.sourceId,
    registrations: [],
  });
  api.listShareLinks.mockResolvedValue([]);
  api.cloudSpaces.mockResolvedValue(spaces);
  api.registeredSpace.mockResolvedValue(null);
  api.stopSharing.mockResolvedValue(null);
  gateway.status.mockResolvedValue(lan);
});
afterEach(() => {
  cleanup();
  Object.assign(access, { remote: false, via: null, relayIssuer: null });
  for (const spy of [
    ...Object.values(api),
    ...Object.values(toasts),
    ...Object.values(gateway),
  ])
    spy.mockReset();
});

async function mount(remotes: unknown[]) {
  api.listSources.mockResolvedValue({ sources: [local], remotes });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <HostAccess />
    </QueryClientProvider>,
  );
  await screen.findByText("Internet access");
}

const row = () =>
  screen.getByText("Internet access").closest(".settings-row") as HTMLElement;
const signInButton = () =>
  within(row()).findByRole("button", { name: "Sign in to Armadra Cloud" });

describe("三行", () => {
  it("开关、互联网访问、手机扫码连接；没有可达范围下拉与旧的中转账号表单", async () => {
    await mount([]);
    expect(
      await screen.findByRole("switch", {
        name: "Allow other devices to access this computer",
      }),
    ).toBeTruthy();
    await signInButton();
    expect(
      screen.getByRole("button", { name: "Connect a phone" }),
    ).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("二维码、地址、指纹要点开「手机扫码连接」才有；地址下拉照对外服务给的顺序", async () => {
    gateway.pair.mockResolvedValue({
      ticket: "t",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      origin: "https://192.168.1.8:8443",
      fingerprint: "ab".repeat(32),
      webUrl: "https://192.168.1.8:8443/#pair=t",
      appUrl: "armadra://pair?x",
    });
    await mount([]);
    const scan = await screen.findByRole("button", { name: "Connect a phone" });
    expect(screen.queryByRole("img")).toBeNull();
    expect(gateway.pair).not.toHaveBeenCalled();
    fireEvent.click(scan);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Connect a phone")).toBeTruthy();
    await waitFor(() => expect(gateway.pair).toHaveBeenCalled());
    expect(within(dialog).getByRole("img")).toBeTruthy();
    expect(within(dialog).getByRole("combobox").textContent).toContain(
      "192.168.1.8",
    );
  });
});

describe("互联网访问：没开", () => {
  it("没登录 Armadra 云、没有任何账号：打开设备码登录（只有「登录」，没有口令表单）；取消仍是仅局域网", async () => {
    await mount([]);
    fireEvent.click(await signInButton());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("app.armadra.com")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Password")).toBeNull();
    expect(api.addCloud).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 还是没开：按钮在，局域网那一半不动。
    await signInButton();
    expect(api.shareThisMachine).not.toHaveBeenCalled();
    expect(api.registerToSpace).not.toHaveBeenCalled();
    expect(gateway.configure).not.toHaveBeenCalled();
  });

  it("登出了的 Armadra 云：登录那一行自己的地址，登录完接着选空间登记", async () => {
    api.addCloud.mockResolvedValue({
      remote: { ...cloud, hasCredentials: false },
      next: {
        deviceCode: {
          userCode: "ABCD-EFGH",
          verificationUrl: `${CLOUD}/device`,
          expiresAtMs: Date.now() + 600_000,
          intervalMs: 5,
        },
      },
    });
    api.pollCloudDevice.mockResolvedValue({ status: "ready" });
    api.registerToSpace.mockResolvedValue({ remote: cloud, sourceId: "h" });
    await mount([{ ...cloud, hasCredentials: false }]);
    fireEvent.click(await signInButton());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("cloud.test")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(api.addCloud).toHaveBeenCalledWith(CLOUD));
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Register this computer",
      }),
    );
    await waitFor(() =>
      expect(api.registerToSpace).toHaveBeenCalledWith({
        serviceId: "cloud",
        space: { kind: "personal" },
      }),
    );
  });

  it("登录着、没登记：直接落到选空间，登记完关闭；取消不登记", async () => {
    api.addCloud.mockResolvedValue({ remote: cloud, next: "ready" });
    api.registerToSpace.mockResolvedValue({ remote: cloud, sourceId: "h" });
    await mount([cloud]);
    fireEvent.click(await signInButton());
    const register = await screen.findByRole("button", {
      name: "Register this computer",
    });
    expect(api.addCloud).toHaveBeenCalledWith(CLOUD);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.registerToSpace).not.toHaveBeenCalled();
    await signInButton();

    // 再来一次，选团队登记。
    fireEvent.click(await signInButton());
    await screen.findByRole("button", { name: "Register this computer" });
    fireEvent.click(screen.getByRole("radio", { name: "Acme" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Register this computer" }),
    );
    await waitFor(() =>
      expect(api.registerToSpace).toHaveBeenCalledWith({
        serviceId: "cloud",
        space: { kind: "team", teamId: "t1" },
      }),
    );
    expect(register).toBeTruthy();
  });

  it("只有个人中转账号：按钮是「启用互联网路线」，一键开，行为不变", async () => {
    api.shareThisMachine.mockResolvedValue({ sourceId: local.sourceId });
    await mount([relay]);
    fireEvent.click(
      await within(row()).findByRole("button", {
        name: "Turn on Internet route",
      }),
    );
    await waitFor(() =>
      expect(api.shareThisMachine).toHaveBeenCalledWith({
        serviceId: "svc",
        issuer: ISSUER,
        label: "this-mac",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("云（登录着、没登记）与个人中转都在：优先云，不去开个人中转", async () => {
    api.addCloud.mockResolvedValue({ remote: cloud, next: "ready" });
    await mount([relay, cloud]);
    fireEvent.click(await signInButton());
    await screen.findByRole("button", { name: "Register this computer" });
    expect(api.shareThisMachine).not.toHaveBeenCalled();
  });
});

describe("互联网访问：已登记到 Armadra 云", () => {
  const registered = { ...cloud, registered: true };
  beforeEach(() => {
    api.shareStatus.mockResolvedValue(registration(CLOUD, "saas"));
  });

  it("显示「Armadra Cloud · 空间」与「更换」，没有登录按钮", async () => {
    api.registeredSpace.mockResolvedValue({
      kind: "team",
      teamId: "t1",
      name: "Acme",
    });
    await mount([registered]);
    await waitFor(() => expect(row().textContent).toContain("Acme"));
    expect(row().textContent).toContain("Armadra Cloud · Acme");
    expect(api.registeredSpace).toHaveBeenCalledWith("cloud", local.sourceId);
    expect(within(row()).getByRole("button", { name: "Change" })).toBeTruthy();
    expect(
      within(row()).queryByRole("button", { name: "Sign in to Armadra Cloud" }),
    ).toBeNull();
  });

  it("个人空间写「Personal space」；读不到空间只写云的名字，仍能更换", async () => {
    api.registeredSpace.mockResolvedValue({ kind: "personal" });
    await mount([registered]);
    await waitFor(() =>
      expect(row().textContent).toContain("Armadra Cloud · Personal space"),
    );
    cleanup();
    api.registeredSpace.mockResolvedValue(null);
    await mount([registered]);
    await within(row()).findByRole("button", { name: "Change" });
    expect(row().textContent).not.toContain("·");
  });

  it("更换：确认前不动；撤销 → 登记新空间 → 收尾，顺序固定", async () => {
    api.registeredSpace.mockResolvedValue({ kind: "personal" });
    api.addCloud.mockResolvedValue({ remote: registered, next: "ready" });
    const order: string[] = [];
    api.stopSharing.mockImplementation(async (issuer: string) => {
      order.push(`revoke ${issuer}`);
      return null;
    });
    api.registerToSpace.mockImplementation(async (input: unknown) => {
      order.push(`register ${JSON.stringify(input)}`);
      return { remote: registered, sourceId: "h" };
    });
    await mount([registered]);
    await waitFor(() => expect(row().textContent).toContain("Personal space"));
    fireEvent.click(within(row()).getByRole("button", { name: "Change" }));
    const change = await screen.findByRole("button", { name: "Change" });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Change space")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Grants and share links in the current space will stop working",
      ),
    ).toBeTruthy();
    expect(order).toEqual([]);
    fireEvent.click(change);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(order).toEqual([
      `revoke ${CLOUD}`,
      `register ${JSON.stringify({
        serviceId: "cloud",
        space: { kind: "team", teamId: "t1" },
      })}`,
    ]);
  });

  it("更换时撤销失败：不继续登记，对话框留着；取消不动", async () => {
    api.registeredSpace.mockResolvedValue({ kind: "personal" });
    api.addCloud.mockResolvedValue({ remote: registered, next: "ready" });
    api.stopSharing.mockRejectedValue(new Error("revoke failed"));
    await mount([registered]);
    await waitFor(() => expect(row().textContent).toContain("Personal space"));
    fireEvent.click(within(row()).getByRole("button", { name: "Change" }));
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect(await screen.findByText("revoke failed")).toBeTruthy();
    expect(api.registerToSpace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.registerToSpace).not.toHaveBeenCalled();
  });

  it("停用在行末的菜单里，要确认；确认才撤销", async () => {
    await mount([registered]);
    await within(row()).findByRole("button", { name: "Change" });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for Internet access" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Turn off Internet route" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText("Turn off the Internet route?"),
    ).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.stopSharing).not.toHaveBeenCalled();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for Internet access" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Turn off Internet route" }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Turn off Internet route",
      }),
    );
    await waitFor(() => expect(api.stopSharing).toHaveBeenCalledWith(CLOUD));
  });

  it("页面正经这个云到达这台电脑：更换不给", async () => {
    Object.assign(access, { remote: true, via: "relayed", relayIssuer: CLOUD });
    await mount([registered]);
    const change = await within(row()).findByRole("button", { name: "Change" });
    expect((change as HTMLButtonElement).disabled).toBe(true);
  });
});
