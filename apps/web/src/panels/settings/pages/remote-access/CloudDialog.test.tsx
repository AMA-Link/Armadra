import * as React from "react";
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
  stopSharing: vi.fn(),
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
  api.stopSharing.mockResolvedValue(null);
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
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  return { onClose, onChanged };
}

describe("添加 Armadra 云", () => {
  it("没有地址输入，只有「登录」；登录用默认地址，重新登录用那一行自己的地址", async () => {
    const { unmount } = render(
      <AddCloudDialog initialIssuer="" onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    expect(screen.queryByLabelText("Address")).toBeNull();
    expect(screen.getByText("app.armadra.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(api.addCloud).toHaveBeenCalledWith("https://app.armadra.com"),
    );
    unmount();
    cleanup();
    render(
      <AddCloudDialog
        initialIssuer="https://cloud.test"
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("cloud.test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(api.addCloud).toHaveBeenLastCalledWith("https://cloud.test"),
    );
  });

  it("显示设备码，批准后选空间登记，完成关闭", async () => {
    api.pollCloudDevice
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValue({ status: "ready" });
    const { onClose } = mount();
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(api.addCloud).toHaveBeenCalledWith("https://app.armadra.com");
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

  it("autoStart：登录着的账号打开就落到选空间，不用再点「登录」；没登录的仍停在登录", async () => {
    api.addCloud.mockResolvedValue({
      remote: { ...remote, hasCredentials: true },
      next: "ready",
    });
    render(
      <AddCloudDialog
        initialIssuer="https://cloud.test"
        autoStart
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "Register this computer" }),
    ).toBeTruthy();
    expect(api.addCloud).toHaveBeenCalledTimes(1);
    expect(api.addCloud).toHaveBeenCalledWith("https://cloud.test");
    cleanup();
    api.addCloud.mockClear();
    render(
      <AddCloudDialog initialIssuer="" onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    await new Promise((done) => setTimeout(done, 20));
    expect(api.addCloud).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
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

  it("步骤回报在提交后同步发生，早于随后的被动副作用（深链不会在换步骤的空当被收下）", async () => {
    const order: string[] = [];
    function PassiveProbe() {
      React.useEffect(() => {
        order.push("passive");
      });
      return null;
    }
    render(
      <>
        <PassiveProbe />
        <AddCloudDialog
          initialIssuer=""
          onClose={vi.fn()}
          onChanged={vi.fn()}
          onStep={(kind) => order.push(`step:${kind}`)}
        />
      </>,
    );
    // 同一次提交里所有 layout effect 先于被动副作用：回报若走 useEffect，会排在
    // 前面那个兄弟的 passive 之后。
    expect(order.slice(0, 2)).toEqual(["step:address", "passive"]);
  });
});

describe("更换空间（#675）", () => {
  const signedIn = { ...remote, registered: true, hasCredentials: true };
  beforeEach(() => {
    api.addCloud.mockResolvedValue({ remote: signedIn, next: "ready" });
  });
  function mountChange(current = "personal") {
    const onClose = vi.fn();
    const onChanged = vi.fn();
    render(
      <AddCloudDialog
        initialIssuer="https://cloud.test"
        autoStart
        current={current}
        onClose={onClose}
        onChanged={onChanged}
      />,
    );
    return { onClose, onChanged };
  }
  const change = () => screen.findByRole("button", { name: "Change" });
  const pick = (name: string) =>
    fireEvent.click(screen.getByRole("radio", { name }));

  it("直接落到选空间：标题「更换空间」，当前空间置灰并标出，提示原空间的授予与分享链接会失效", async () => {
    mountChange();
    const submit = await change();
    expect(screen.getByText("Change space")).toBeTruthy();
    expect(
      screen.getByText(
        "Grants and share links in the current space will stop working",
      ),
    ).toBeTruthy();
    const current = screen.getByRole("radio", { name: /Personal space/ });
    expect((current as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Current/)).toBeTruthy();
    // 缺省选中第一个可选的（团队），不是当前这个。
    expect(
      screen.getByRole("radio", { name: "Acme" }).getAttribute("data-state"),
    ).toBe("checked");
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("先在原空间撤销，再登记到新空间，最后收尾", async () => {
    const order: string[] = [];
    api.stopSharing.mockImplementation(async (issuer: string) => {
      order.push(`revoke ${issuer}`);
      return null;
    });
    api.registerToSpace.mockImplementation(async (input: unknown) => {
      order.push(`register ${JSON.stringify(input)}`);
      return { remote: signedIn, sourceId: "h" };
    });
    const { onClose, onChanged } = mountChange();
    fireEvent.click(await change());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(order).toEqual([
      "revoke https://cloud.test",
      `register ${JSON.stringify({
        serviceId: "svc",
        space: { kind: "team", teamId: "t1" },
      })}`,
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("从团队换回个人空间", async () => {
    const { onClose } = mountChange("team:t1");
    await change();
    pick("Personal space");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.registerToSpace).toHaveBeenCalledWith({
      serviceId: "svc",
      space: { kind: "personal" },
    });
  });

  it("取消：不撤销、不登记", async () => {
    const { onClose } = mountChange();
    await change();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(api.stopSharing).not.toHaveBeenCalled();
    expect(api.registerToSpace).not.toHaveBeenCalled();
  });

  it("撤销失败：不继续登记，对话框留着给错误", async () => {
    api.stopSharing.mockRejectedValue(new Error("revoke failed"));
    const { onClose } = mountChange();
    fireEvent.click(await change());
    expect(await screen.findByText("revoke failed")).toBeTruthy();
    expect(api.registerToSpace).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("撤销后登记失败：留着重试，重试只补登记，不再撤销", async () => {
    api.registerToSpace
      .mockRejectedValueOnce(new Error("register failed"))
      .mockResolvedValue({ remote: signedIn, sourceId: "h" });
    const { onClose } = mountChange();
    fireEvent.click(await change());
    expect(await screen.findByText("register failed")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.stopSharing).toHaveBeenCalledTimes(1);
    expect(api.registerToSpace).toHaveBeenCalledTimes(2);
  });

  it("角色不能登记的团队置灰；非更换时没有提示", async () => {
    api.cloudSpaces.mockResolvedValue({
      spaces: [
        { kind: "personal", plan: "free" },
        {
          kind: "team",
          teamId: "g",
          slug: "g",
          name: "Guests",
          role: "guest",
          plan: "team",
        },
      ],
    });
    mountChange("team:other");
    await change();
    expect(
      (screen.getByRole("radio", { name: /Guests/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/Cannot register hosts/)).toBeTruthy();
    cleanup();
    api.addCloud.mockResolvedValue({
      remote: { ...signedIn, registered: false },
      next: "ready",
    });
    render(
      <AddCloudDialog
        initialIssuer="https://cloud.test"
        autoStart
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Register this computer" });
    expect(screen.queryByText(/stop working/)).toBeNull();
  });
});
