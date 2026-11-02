import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  sessionChange: new Set<(change: string) => void>(),
  ticketForm: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/ui/toast", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock("../../../../api/identity", async (original) => {
  const actual = await original<typeof import("../../../../api/identity")>();
  return {
    ...actual,
    resumeIdentity: (...args: never[]) => mocks.resume(...args),
    renewCsrf: async () => "",
    onIdentitySessionChange: (listener: (change: string) => void) => {
      mocks.sessionChange.add(listener);
      return () => mocks.sessionChange.delete(listener);
    },
  };
});

vi.mock("../../../../api/security", async (original) => {
  const actual = await original<typeof import("../../../../api/security")>();
  return {
    ...actual,
    mfaStatus: async () => ({
      enrolled: false,
      pending: false,
      enrolledAtMs: 0,
      verifiedAtMs: 0,
      recoveryCodesRemaining: 0,
      requireFor: "all",
      required: true,
    }),
    listPasskeys: async () => ({
      available: false,
      rpId: "",
      reason: "passkey_unavailable_on_ip_host",
      passkeys: [],
    }),
    oauthProviders: async () => ({ configured: false, providers: [] }),
    oauthBindings: async () => [],
    listSessions: async () => [
      {
        sessionId: "s1",
        principalId: "p".repeat(32),
        deviceId: "d1",
        deviceName: "这台",
        createdAtMs: 1,
        lastSeenAtMs: 2,
        expiresAtMs: Date.now() + 3_600_000,
        remoteIp: "127.0.0.1",
        userAgent: "",
        current: true,
      },
    ],
    listLockouts: async () => [],
    listMembers: async () => [],
    readAudit: async () => ({ entries: [], nextBeforeId: 0 }),
  };
});

// 设备登录与设备表另有用例（SecurityPage.devices.test）：这里只占位。
vi.mock("./DeviceSignIn", () => ({
  DeviceSignIn: ({ ticketForm }: { ticketForm?: boolean }) => {
    mocks.ticketForm(ticketForm);
    return <h3>设备登录</h3>;
  },
}));
vi.mock("../gateway/GatewaySection", () => ({
  GatewayDevicesSection: () => <h3>已配对设备</h3>,
}));
vi.mock("./E2eDevices", () => ({ E2eDevices: () => null }));

import { usePreferencesStore } from "../../../../app/preferences-store";
import { installDomPolyfills } from "../../../../app/test-harness";
import { SecurityPage } from "./SecurityPage";

installDomPolyfills();

function session(scopes: string[]) {
  return {
    hostId: "h",
    device: {
      deviceId: "d1",
      principalId: "p".repeat(32),
      displayName: "",
      role: "member",
      createdAtUnixMs: 0,
      revision: 0,
    },
    scopes: scopes.map((permission) => ({
      permission,
      workspaceId: "",
      executionHostId: "",
    })),
    expiresAtUnixMs: 0,
  };
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SecurityPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  mocks.resume.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.ticketForm.mockReset();
  mocks.sessionChange.clear();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("SecurityPage", () => {
  it("成员：设备登录在最上，两步验证要求排登录方式第一，设备与登录会话随后，审计不出现", async () => {
    mocks.resume.mockResolvedValue(session(["canvas:read"]));
    mount();
    expect(await screen.findByText("需要开启两步验证")).toBeTruthy();
    expect(await screen.findByText("这台")).toBeTruthy();
    expect(
      screen.getByText("用 IP 地址访问时无法使用通行密钥，请改用域名"),
    ).toBeTruthy();
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((node) => node.textContent);
    expect(headings[0]).toBe("设备登录");
    expect(headings[1]).toBe("两步验证");
    expect(headings.indexOf("已配对设备")).toBeGreaterThan(
      headings.indexOf("第三方账号"),
    );
    expect(headings.indexOf("登录会话")).toBeGreaterThan(
      headings.indexOf("已配对设备"),
    );
    expect(headings).not.toContain("审计");
  });

  it("没登录也没有回调：只有「设备登录」一张表单；配对之后换成账号内容，续期不重取", async () => {
    mocks.resume.mockResolvedValue(null);
    mount();
    expect(await screen.findByText("已配对设备")).toBeTruthy();
    expect(document.querySelector('[data-slot="sign-in"]')).toBeNull();
    const calls = mocks.resume.mock.calls.length;
    act(() => {
      for (const listener of mocks.sessionChange) listener("rotated");
    });
    expect(mocks.resume.mock.calls.length).toBe(calls);
    mocks.resume.mockResolvedValue(session(["canvas:read"]));
    await act(async () => {
      for (const listener of mocks.sessionChange) listener("appeared");
    });
    expect(await screen.findByText("需要开启两步验证")).toBeTruthy();
  });

  it("OAuth 回调落在没登录的页上：登录表单在，「设备登录」不再给配对票表单", async () => {
    mocks.resume.mockResolvedValue(null);
    window.history.replaceState(null, "", "#oauth=error&code=oauth_not_bound");
    mount();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="sign-in"]')).toBeTruthy(),
    );
    expect(mocks.ticketForm).toHaveBeenLastCalledWith(false);
  });

  it("owner 看得到审计", async () => {
    mocks.resume.mockResolvedValue(session(["identity:manage"]));
    mount();
    expect(await screen.findByText("审计")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "所有成员" })).toBeNull();
  });

  it("没登录：登录表单；OAuth 回调的 mfa 片段直接进第二步并抹掉地址栏", async () => {
    mocks.resume.mockResolvedValue(null);
    window.history.replaceState(null, "", "#oauth=mfa&challengeId=ch1");
    mount();
    expect(
      await screen.findByRole("heading", { name: "两步验证" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("验证码")).toBeTruthy();
    expect(window.location.hash).toBe("");
  });

  it("OAuth 错误：没登录时写在表单里，登录了弹一条", async () => {
    mocks.resume.mockResolvedValue(null);
    window.history.replaceState(null, "", "#oauth=error&code=oauth_not_bound");
    mount();
    expect(await screen.findByText("这个账号还没有绑定")).toBeTruthy();

    cleanup();
    mocks.resume.mockResolvedValue(session([]));
    window.history.replaceState(null, "", "#oauth=bound");
    mount();
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("已绑定"),
    );
  });
});
