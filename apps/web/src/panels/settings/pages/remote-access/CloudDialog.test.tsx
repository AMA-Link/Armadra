import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills } from "@/app/test-harness";

const api = vi.hoisted(() => ({
  addCloud: vi.fn(),
  pollCloudDevice: vi.fn(),
  cloudSpaces: vi.fn(),
  registerToSpace: vi.fn(),
}));
vi.mock("../../../../api/remote-services", async (original) => ({
  ...(await original<typeof import("../../../../api/remote-services")>()),
  ...api,
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/ui/toast", () => ({ toast: toasts }));
const platform = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("../../../../platform", async (original) => ({
  ...(await original<typeof import("../../../../platform")>()),
  ...platform,
}));

import { AddCloudDialog } from "./CloudDialog";

const remote = {
  serviceId: "svc",
  kind: "saas",
  issuer: "https://cloud.test",
  label: "cloud.test",
  accountHint: "",
  fingerprint: "",
  addedAtMs: 1,
  lastOkAtMs: 0,
  registered: false,
  hasCredentials: false,
};

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
  api.addCloud.mockResolvedValue({
    remote,
    next: {
      deviceCode: {
        userCode: "ABCD-EFGH",
        verificationUrl: "https://cloud.test/device",
        expiresAtMs: Date.now() + 600_000,
        intervalMs: 10,
      },
    },
  });
  api.cloudSpaces.mockResolvedValue({
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
  });
  api.registerToSpace.mockResolvedValue({ remote, sourceId: "h" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <AddCloudDialog initialIssuer="" onClose={onClose} onChanged={onChanged} />,
  );
  fireEvent.change(screen.getByLabelText("Address"), {
    target: { value: "https://cloud.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Get device code" }));
  return { onClose, onChanged };
}

describe("添加 Armadra 云", () => {
  it("显示设备码，批准后选空间登记，完成关闭", async () => {
    api.pollCloudDevice
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValue({ status: "ready" });
    const { onClose } = mount();
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(api.addCloud).toHaveBeenCalledWith("https://cloud.test");
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(platform.openExternal).toHaveBeenCalledWith(
      "https://cloud.test/device",
    );
    const register = await screen.findByRole("button", {
      name: "Register this computer",
    });
    expect(api.pollCloudDevice).toHaveBeenCalledTimes(2);
    fireEvent.click(register);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.registerToSpace).toHaveBeenCalledWith({
      serviceId: "svc",
      space: { kind: "personal" },
    });
  });

  it("被拒绝：停止轮询，给重新获取", async () => {
    api.pollCloudDevice.mockResolvedValue({ status: "denied" });
    mount();
    expect(await screen.findByText("Denied in the browser")).toBeTruthy();
    const calls = api.pollCloudDevice.mock.calls.length;
    await new Promise((done) => setTimeout(done, 60));
    expect(api.pollCloudDevice).toHaveBeenCalledTimes(calls);
    expect(screen.getByRole("button", { name: "New code" })).toBeTruthy();
  });

  it("选团队空间出现终端提醒，选个人不出现；角色受限的团队置灰", async () => {
    api.cloudSpaces.mockResolvedValue({
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
        {
          kind: "team",
          teamId: "t2",
          slug: "bill",
          name: "Billing",
          role: "billing",
          plan: "team",
        },
      ],
    });
    api.pollCloudDevice.mockResolvedValue({ status: "ready" });
    mount();
    await screen.findByRole("button", { name: "Register this computer" });
    const note = /run commands as this computer's system account/;
    expect(screen.queryByText(note)).toBeNull();
    const group = screen.getByRole("radiogroup", { name: "Register to" });
    expect(
      within(group)
        .getByRole("radio", { name: "Personal space" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const billing = within(group).getByRole("radio", { name: /Billing/ });
    expect(billing.hasAttribute("disabled")).toBe(true);
    expect(group.textContent).toContain("Cannot register hosts");
    fireEvent.click(within(group).getByRole("radio", { name: "Acme" }));
    expect(await screen.findByText(note)).toBeTruthy();
    fireEvent.click(
      within(group).getByRole("radio", { name: "Personal space" }),
    );
    await waitFor(() => expect(screen.queryByText(note)).toBeNull());
  });

  it("已登记的重新登录就绪后直接关闭，不进登记步骤", async () => {
    api.addCloud.mockResolvedValue({
      remote: { ...remote, registered: true },
      next: {
        deviceCode: {
          userCode: "ABCD-EFGH",
          verificationUrl: "https://cloud.test/device",
          expiresAtMs: Date.now() + 600_000,
          intervalMs: 10,
        },
      },
    });
    api.pollCloudDevice.mockResolvedValue({ status: "ready" });
    const { onClose } = mount();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.cloudSpaces).not.toHaveBeenCalled();
  });

  it("轮询出错：停止并给新设备码；取空间失败单独重试", async () => {
    api.pollCloudDevice.mockRejectedValue(new Error("boom"));
    mount();
    expect(await screen.findByText("boom")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New code" })).toBeTruthy();
    cleanup();
    vi.clearAllMocks();
    api.addCloud.mockResolvedValue({
      remote,
      next: {
        deviceCode: {
          userCode: "ABCD-EFGH",
          verificationUrl: "https://cloud.test/device",
          expiresAtMs: Date.now() + 600_000,
          intervalMs: 10,
        },
      },
    });
    api.pollCloudDevice.mockResolvedValue({ status: "ready" });
    api.cloudSpaces
      .mockRejectedValueOnce(new Error("spaces down"))
      .mockResolvedValue({ spaces: [{ kind: "personal", plan: "free" }] });
    mount();
    expect(await screen.findByText("spaces down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "Register this computer" }),
    ).toBeTruthy();
    expect(api.pollCloudDevice).toHaveBeenCalledTimes(1);
  });

  it("设备码旁有倒计时（tabular）", async () => {
    api.addCloud.mockResolvedValue({
      remote,
      next: {
        deviceCode: {
          userCode: "ABCD-EFGH",
          verificationUrl: "https://cloud.test/device",
          expiresAtMs: Date.now() + 64_500,
          intervalMs: 600_000,
        },
      },
    });
    api.pollCloudDevice.mockResolvedValue({ status: "pending" });
    mount();
    const timer = await screen.findByRole("timer", {
      name: "Time left on the device code",
    });
    expect(timer.textContent).toMatch(/^1:0[3-5]$/);
    expect(timer.className).toContain("tabular-nums");
  });

  it("倒计时走完：本地收尾成「已过期」，给新设备码", async () => {
    api.addCloud.mockResolvedValue({
      remote,
      next: {
        deviceCode: {
          userCode: "ABCD-EFGH",
          verificationUrl: "https://cloud.test/device",
          expiresAtMs: Date.now() + 1_200,
          intervalMs: 600_000,
        },
      },
    });
    api.pollCloudDevice.mockResolvedValue({ status: "pending" });
    mount();
    expect(
      await screen.findByText(
        "The device code expired",
        {},
        { timeout: 5_000 },
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.getByRole("button", { name: "New code" })).toBeTruthy();
  });

  it("复制设备码：写剪贴板并提示", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    api.pollCloudDevice.mockResolvedValue({ status: "pending" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-EFGH"));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Device code copied"),
    );
  });
});
