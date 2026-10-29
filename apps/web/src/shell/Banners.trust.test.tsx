import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

/**
 * 待信任的新设备（云端控制台 §3.5.3）：云端转来请求时横幅提示；「查看」打开对话框，
 * 背书人输入新设备上显示的校验码，码只交给主机、不上传云端，横幅与对话框都不显示它。
 */

const api = vi.hoisted(() => ({
  listSources: vi.fn(),
  cloudTrustList: vi.fn(),
  cloudAccess: vi.fn(),
  cloudTrustReject: vi.fn(),
}));
vi.mock("../api/remote-services", async (original) => ({
  ...(await original<typeof import("../api/remote-services")>()),
  ...api,
}));
vi.mock("../api/client", () => ({
  localClient: () => ({ devices: host.localDevices }),
  runtimeApi: {
    health: () => Promise.resolve({ ok: true }),
    terminalBackend: () => Promise.resolve({ kind: "direct" }),
    agentIntegration: () => Promise.resolve({ legacy: { found: [] } }),
    agents: () => Promise.resolve([]),
  },
}));
const platform = vi.hoisted(() => ({ desktop: true }));
vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  isDesktop: () => platform.desktop,
}));
const host = vi.hoisted(() => ({
  devices: {
    list: vi.fn(),
    approve: vi.fn(),
  },
  localDevices: {
    list: vi.fn(),
    approve: vi.fn(),
  },
}));
vi.mock("../sources/registry", async (original) => {
  const module = await original<typeof import("../sources/registry")>();
  return {
    ...module,
    sourceRegistry: () => {
      const real = module.sourceRegistry();
      return {
        ...real,
        get: (sourceId: string) =>
          sourceId === HOST
            ? { client: { devices: host.devices } }
            : real.get(sourceId),
      };
    },
  };
});
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/ui/toast", () => ({ toast: toasts }));

const { installDomPolyfills, TestProviders } = await import(
  "../app/test-harness"
);
const { usePreferencesStore } = await import("../app/preferences-store");
const { RuntimeRequestError } = await import("../api/request");
const { Banners } = await import("./Banners");
const { CloudTrustDialog } = await import("../sources/trust/CloudTrustDialog");
const { useTrustDialog } = await import("../sources/trust/trust-store");

installDomPolyfills();

const HOST = "f".repeat(32);
const cloud = {
  serviceId: "cloud",
  kind: "saas",
  issuer: "https://cloud.test",
  hasCredentials: true,
  guest: false,
};
const request = {
  requestId: "r1",
  sourceId: HOST,
  sourceName: "build-01",
  teamId: "t1",
  member: { accountId: "a2", email: "bo@x.test", displayName: "Bo" },
  device: { name: "Bo's iPhone", platform: "ios" },
  requestedAtMs: 1,
  expiresAtMs: 2,
};
const pending = (over: Record<string, unknown> = {}) => ({
  deviceId: "d1",
  principalId: "p1",
  principalName: "Bo",
  principalKind: "member",
  label: "Bo's iPhone",
  platform: "ios",
  status: "pending",
  pendingId: "pend-1",
  approvedBy: "",
  issuer: "",
  fingerprint: "",
  createdAtMs: 1,
  approvedAtMs: 0,
  lastSeenAtMs: 0,
  revokedAtMs: 0,
  ...over,
});

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  platform.desktop = true;
  api.listSources.mockResolvedValue({ sources: [], remotes: [cloud] });
  api.cloudTrustList.mockResolvedValue({ requests: [request] });
  api.cloudTrustReject.mockResolvedValue({});
  api.cloudAccess.mockResolvedValue({ sourceId: "e".repeat(32) });
  host.devices.list.mockResolvedValue({ devices: [pending()] });
  host.devices.approve.mockResolvedValue({
    device: pending({ status: "trusted", pendingId: null }),
  });
});
afterEach(() => {
  cleanup();
  for (const spy of [
    ...Object.values(api),
    host.devices.list,
    host.devices.approve,
    host.localDevices.list,
    host.localDevices.approve,
    ...Object.values(toasts),
  ])
    spy.mockReset();
  act(() => useTrustDialog.getState().hide());
});

function mount() {
  render(
    <TestProviders>
      <Banners />
      <CloudTrustDialog />
    </TestProviders>,
  );
}

async function openDialog() {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "View" }));
  return screen.findByTestId("cloud-trust-dialog");
}

async function typeCode(code: string) {
  const input = await screen.findByLabelText(
    "Enter the code shown on the new device",
  );
  fireEvent.change(input, { target: { value: code } });
}

/** 主机记录没对上：就地说明，「信任」不可点，码不会交出去。 */
async function expectBlocked(message: string) {
  const dialog = await openDialog();
  expect(await screen.findByText(message)).toBeTruthy();
  await typeCode("482913");
  const trust = screen.getByRole("button", { name: "Trust" });
  expect(trust.hasAttribute("disabled")).toBe(true);
  fireEvent.click(trust);
  await new Promise((done) => setTimeout(done, 20));
  expect(host.devices.approve).not.toHaveBeenCalled();
  return dialog;
}

describe("待信任设备横幅与对话框", () => {
  it("云端转来请求：横幅点名成员，不显示校验码", async () => {
    mount();
    const banner = await screen.findByText("Bo's new device needs trust");
    expect(banner.closest("[data-slot=banner]")?.textContent).not.toMatch(
      /\d{6}/,
    );
  });

  it("多条请求只说数量", async () => {
    api.cloudTrustList.mockResolvedValue({
      requests: [request, { ...request, requestId: "r2" }],
    });
    mount();
    expect(await screen.findByText("2 new devices need trust")).toBeTruthy();
  });

  it("没有请求、或不在桌面壳里：没有横幅，也不问云端", async () => {
    api.cloudTrustList.mockResolvedValue({ requests: [] });
    mount();
    await waitFor(() => expect(api.cloudTrustList).toHaveBeenCalled());
    expect(screen.queryByText(/needs trust/)).toBeNull();
    cleanup();
    api.cloudTrustList.mockClear();
    platform.desktop = false;
    mount();
    await new Promise((done) => setTimeout(done, 20));
    expect(api.cloudTrustList).not.toHaveBeenCalled();
    expect(screen.queryByText(/needs trust/)).toBeNull();
  });

  it("信任：校验码只交给主机的 devices.approve，不上传云端", async () => {
    const dialog = await openDialog();
    expect(dialog.textContent).toContain("Bo's iPhone");
    expect(dialog.textContent).toContain("build-01");
    const trust = screen.getByRole("button", { name: "Trust" });
    expect(trust.hasAttribute("disabled")).toBe(true);
    await typeCode("482913");
    await waitFor(() => expect(trust.hasAttribute("disabled")).toBe(false));
    fireEvent.click(trust);
    await waitFor(() =>
      expect(host.devices.approve).toHaveBeenCalledWith({
        pendingId: "pend-1",
        sas: "482913",
      }),
    );
    expect(api.cloudTrustReject).not.toHaveBeenCalled();
    expect(JSON.stringify(api.cloudTrustList.mock.calls)).not.toContain(
      "482913",
    );
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Trusted Bo's iPhone"),
    );
  });

  it("校验码不对：就地提示，申请还在，可以再输", async () => {
    host.devices.approve.mockRejectedValueOnce(
      new RuntimeRequestError(403, "x", "sas_mismatch"),
    );
    await openDialog();
    await typeCode("111111");
    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    expect(await screen.findByText("The code doesn’t match")).toBeTruthy();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("主机上还没有这台设备的申请：就地说清楚，「信任」不可点", async () => {
    host.devices.list.mockResolvedValue({ devices: [] });
    await expectBlocked(
      "This host has no request from that device yet. Ask it to reconnect",
    );
  });

  it("同名设备多条申请时优先取成员对得上的那条", async () => {
    host.devices.list.mockResolvedValue({
      devices: [
        pending({ pendingId: "other", principalName: "Cy" }),
        pending({ pendingId: "bo" }),
      ],
    });
    await openDialog();
    await typeCode("482913");
    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    await waitFor(() =>
      expect(host.devices.approve).toHaveBeenCalledWith({
        pendingId: "bo",
        sas: "482913",
      }),
    );
  });

  it("拒绝：只告诉云端这条请求作废，不带校验码", async () => {
    await openDialog();
    await typeCode("482913");
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(api.cloudTrustReject).toHaveBeenCalledWith("cloud", "r1"),
    );
    expect(host.devices.approve).not.toHaveBeenCalled();
  });

  it("请求的主机就是本机：与本机登记 id 相等，走本机 core，不查源表", async () => {
    api.cloudAccess.mockResolvedValue({ sourceId: HOST });
    host.localDevices.list.mockResolvedValue({ devices: [pending()] });
    host.localDevices.approve.mockResolvedValue({
      device: pending({ status: "trusted", pendingId: null }),
    });
    await openDialog();
    await typeCode("482913");
    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    await waitFor(() =>
      expect(host.localDevices.approve).toHaveBeenCalledWith({
        pendingId: "pend-1",
        sas: "482913",
      }),
    );
    expect(host.devices.approve).not.toHaveBeenCalled();
  });

  it("只认精确匹配：成员对不上就不放行，不退回模糊匹配", async () => {
    host.devices.list.mockResolvedValue({
      devices: [pending({ principalName: "Cy" })],
    });
    await expectBlocked(
      "This host has no request from that device yet. Ask it to reconnect",
    );
  });

  it("同名同成员多条申请：不猜，提示去主机处理", async () => {
    host.devices.list.mockResolvedValue({
      devices: [pending({ pendingId: "a" }), pending({ pendingId: "b" })],
    });
    await expectBlocked(
      "The host has several requests with that name. Handle it in the host's device list",
    );
  });

  it("明确没有背书权限：不显示「信任」与云端报的平台，只留「拒绝」并说在已信任的设备上处理", async () => {
    api.cloudTrustList.mockResolvedValue({
      requests: [
        { ...request, device: { name: "Bo's iPhone", platform: "browser" } },
      ],
    });
    host.devices.list.mockRejectedValue(
      new RuntimeRequestError(403, "x", "forbidden"),
    );
    const dialog = await openDialog();
    expect(await screen.findByText("Use a trusted device")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Trust" })).toBeNull();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(dialog.textContent).not.toContain("Browser");
    expect(host.devices.approve).not.toHaveBeenCalled();
  });

  it("主机记录第一次读失败、第二次才成功：不显示云端报的平台，「信任」不可点，不放行；重试后按主机显示", async () => {
    api.cloudTrustList.mockResolvedValue({
      requests: [
        { ...request, device: { name: "Bo's iPhone", platform: "browser" } },
      ],
    });
    host.devices.list
      .mockRejectedValueOnce(new Error("relay dropped"))
      .mockResolvedValue({
        devices: [pending({ platform: "desktop", principalKind: "owner" })],
      });
    const dialog = await expectBlocked(
      "Couldn't read this request on the host",
    );
    expect(dialog.textContent).not.toContain("Browser");
    expect(host.devices.list).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dialog.textContent).toContain("Desktop"));
    expect(dialog.textContent).not.toContain("Browser");
    expect(host.devices.approve).not.toHaveBeenCalled();
  });

  it("平台以主机那一行为准：云端报 browser、主机记的是 owner 的 desktop，显示「Desktop」、原生端提示与不一致警示", async () => {
    api.cloudTrustList.mockResolvedValue({
      requests: [
        { ...request, device: { name: "Bo's iPhone", platform: "browser" } },
      ],
    });
    host.devices.list.mockResolvedValue({
      devices: [pending({ platform: "desktop", principalKind: "owner" })],
    });
    const dialog = await openDialog();
    await waitFor(() => expect(dialog.textContent).toContain("Desktop"));
    expect(dialog.textContent).not.toContain("Browser");
    expect(dialog.textContent).toContain(
      "Once allowed, it can approve the owner's new devices",
    );
    expect(dialog.textContent).toContain(
      "The cloud reports a different platform. Showing the host's record",
    );
    // 放行的就是给人看过的那一行。
    await typeCode("482913");
    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    await waitFor(() =>
      expect(host.devices.approve).toHaveBeenCalledWith({
        pendingId: "pend-1",
        sas: "482913",
      }),
    );
  });

  it("放行的是给人看过的那一行：之后主机上换了一条同名申请，也不改批那一条", async () => {
    host.devices.list
      .mockResolvedValueOnce({ devices: [pending({ platform: "ios" })] })
      .mockResolvedValue({
        devices: [pending({ pendingId: "swapped", platform: "desktop" })],
      });
    const dialog = await openDialog();
    await waitFor(() => expect(dialog.textContent).toContain("iOS"));
    await typeCode("482913");
    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    await waitFor(() => expect(host.devices.approve).toHaveBeenCalled());
    expect(host.devices.approve).toHaveBeenCalledWith({
      pendingId: "pend-1",
      sas: "482913",
    });
  });

  it("主机与云端一致、申请人是成员：只显示平台，没有提示与警示", async () => {
    const dialog = await openDialog();
    await waitFor(() => expect(dialog.textContent).toContain("iOS"));
    expect(dialog.textContent).not.toContain("Once allowed");
    expect(dialog.textContent).not.toContain("different platform");
  });

  it("主机那一行还没查回来：平台先不显示云端报的", async () => {
    api.cloudTrustList.mockResolvedValue({
      requests: [
        { ...request, device: { name: "Bo's iPhone", platform: "browser" } },
      ],
    });
    host.devices.list.mockReturnValue(new Promise(() => undefined));
    const dialog = await openDialog();
    await new Promise((done) => setTimeout(done, 20));
    expect(dialog.textContent).not.toContain("Browser");
  });

  it("窗口重新聚焦：不重查主机上的那一行，给人看过的不会悄悄换掉", async () => {
    const dialog = await openDialog();
    await waitFor(() => expect(dialog.textContent).toContain("iOS"));
    expect(host.devices.list).toHaveBeenCalledTimes(1);
    const { focusManager, onlineManager } = await import(
      "@tanstack/react-query"
    );
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await new Promise((done) => setTimeout(done, 30));
    expect(host.devices.list).toHaveBeenCalledTimes(1);
    act(() => focusManager.setFocused(undefined));
  });
});
