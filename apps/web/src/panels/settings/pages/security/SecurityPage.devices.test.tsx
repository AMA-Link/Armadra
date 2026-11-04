import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderBare,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { type GatewayStatus, connectUrl, parseConnect } from "@armadra/shared";

const probe = vi.fn();
vi.mock("../../../../host/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../host/connection")>()),
  probeHost: (...args: unknown[]) => probe(...args),
}));
let member = false;
vi.mock("../../../../app/use-access", () => ({
  useAccess: () => ({ member, can: () => !member, session: undefined }),
}));
// 「设备登录」只报一条会话上来：设备表只有一份，在对外服务那一块（G3-11）。
let identitySession: IdentitySession | null = null;
vi.mock("../HostIdentityPanel", async () => {
  const { useEffect } = await import("react");
  return {
    HostIdentityPanel: ({
      onSession,
    }: {
      onSession?(session: IdentitySession | null): void;
    }) => {
      useEffect(() => onSession?.(identitySession), [onSession]);
      return null;
    },
  };
});

vi.mock("./LoginSessions", () => ({
  LoginSessions: () => null,
}));
// 账号那几块不在这份用例里：没有账号会话、登录表单不画（见 SecurityPage.test）。
vi.mock("../../../../api/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/identity")>()),
  resumeIdentity: async () => null,
}));
vi.mock("../../../../session/SignIn", () => ({ SignIn: () => null }));

import { SecurityPage } from "./SecurityPage";
import { HostAccess } from "../remote-access/HostAccess";
import { usePreferencesStore } from "../../../../app/preferences-store";
import {
  IdentityRequestError,
  IdentityTransportError,
  type IdentityHello,
  type IdentitySession,
} from "../../../../api/identity";
import { TestProviders } from "../../../../app/test-harness";

/** 远程访问页的开关一块与账号与设备页放在一起：配置与设备表各一份。 */
function HostPage() {
  return (
    <>
      <HostAccess />
      <SecurityPage />
    </>
  );
}

function render(element: ReactElement) {
  return renderBare(<TestProviders>{element}</TestProviders>);
}

/* ------------------------- 对外服务：假的 core 一份 ------------------------- */

const FP = "ab".repeat(32);
const SOURCE = "0123456789abcdef0123456789abcdef";
const TICKET = "0123456789abcdef.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

function gatewayStatus(overrides: Partial<GatewayStatus> = {}): GatewayStatus {
  return {
    enabled: false,
    running: false,
    managedBy: "settings",
    listen: "private",
    port: 0,
    publicOrigin: "",
    address: null,
    origin: null,
    origins: [],
    tls: {
      source: "localCa",
      certFile: "",
      keyFile: "",
      acmeEmail: "",
      fingerprint: null,
      subject: null,
      names: [],
      notAfter: null,
      caAvailable: false,
    },
    error: null,
    ...overrides,
  };
}

function runningStatus(): GatewayStatus {
  const base = gatewayStatus();
  return {
    ...base,
    enabled: true,
    running: true,
    port: 8443,
    address: { host: "0.0.0.0", port: 8443 },
    origin: "https://192.168.1.20:8443",
    origins: ["https://192.168.1.20:8443", "https://127.0.0.1:8443"],
    tls: { ...base.tls, fingerprint: FP, caAvailable: true },
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * 一个按路径答的 fetch：记下每次调用，`/api/gateway` 的状态随 PUT 改。对外服务
 * 经 `gateway.*` procedure（契约 §43.7）：体与答案都是 `{ json }`，记下来的调用
 * 还原成旧路径的样子（方法、路径、入参），断言照旧读。
 */
function fakeCore(options: {
  status?: GatewayStatus | number;
  devices?: { deviceId: string; name: string; role: string }[] | number;
}) {
  let status = options.status ?? gatewayStatus();
  const calls: Call[] = [];
  const answer = (code: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      const method = init?.method ?? "GET";
      const sent = init?.body ? JSON.parse(String(init.body)) : undefined;
      const rpc = /^\/api\/rpc\/gateway\/(status|configure)$/.exec(
        url.pathname,
      )?.[1];
      const legacy = {
        status: { method: "GET", path: "/api/gateway" },
        configure: { method: "PUT", path: "/api/gateway" },
      } as const;
      const route =
        rpc === undefined
          ? { method, path: url.pathname }
          : legacy[rpc as keyof typeof legacy];
      const body = rpc === undefined ? sent : sent?.json;
      calls.push({ method: route.method, path: route.path, body });
      const reply = (code: number, payload: unknown) =>
        answer(
          code,
          rpc !== undefined && code === 200 ? { json: payload } : payload,
        );
      if (route.path === "/api/gateway") {
        if (typeof status === "number")
          return answer(status, { code: "forbidden", message: "" });
        if (route.method === "PUT") {
          const patch = body as Partial<GatewayStatus>;
          status =
            patch.enabled === true
              ? runningStatus()
              : { ...status, ...patch, running: false, origins: [] };
        }
        return reply(200, status);
      }
      if (route.path === "/api/rpc/connect/offer") {
        const origin = "https://192.168.1.20:8443";
        const expiresAtMs = Date.now() + 120_000;
        return answer(200, {
          json: {
            sourceId: SOURCE,
            expiresAtMs,
            uri: connectUrl(origin, {
              sourceId: SOURCE,
              expiresAtMs,
              direct: { origins: [origin], ticket: TICKET, fingerprint: FP },
              relay: null,
            }),
            direct: {
              origins: [origin],
              fingerprint: FP,
              code: null,
              webUrl: `${origin}/#pair=${TICKET}&fp=${FP}`,
            },
            relay: null,
          },
        });
      }
      // 设备经 procedure（契约 §42.1）：体是 `{ json }`，答案也是。
      if (url.pathname === "/api/rpc/identity/devices/list") {
        const devices = options.devices ?? 401;
        if (typeof devices === "number")
          return answer(devices, { code: "unauthenticated", message: "" });
        return answer(200, {
          json: {
            devices: devices.map((device, index) => ({
              ...device,
              principalId: "p",
              epoch: index + 1,
              createdAtMs: Date.UTC(2026, 9, 1),
              revokedAtMs: 0,
            })),
            nextId: "",
            hasMore: false,
          },
        });
      }
      if (url.pathname === "/api/rpc/identity/devices/revoke")
        return answer(200, {
          json: { deviceId: body.json.deviceId, revoked: true },
        });
      return answer(404, { code: "not_found", message: "" });
    }),
  );
  return calls;
}

const hello: IdentityHello = {
  sourceId: "host-confirmed",
  hostInstanceId: "process-confirmed",
  maxFrameBytes: 1_048_576,
  capabilities: ["identity.native-session.v1"],
  protocol: { major: 1, minor: 1 },
};

function sessionFor(deviceId: string, manage: boolean): IdentitySession {
  return {
    hostId: "h",
    expiresAtUnixMs: 0,
    device: {
      deviceId,
      principalId: "p",
      displayName: "Mac",
      role: "owner",
      createdAtUnixMs: 1,
      revision: 1,
    },
    scopes: [
      { permission: "identity:read", workspaceId: "", executionHostId: "" },
      ...(manage
        ? [
            {
              permission: "identity:manage",
              workspaceId: "",
              executionHostId: "",
            },
          ]
        : []),
    ],
  };
}

beforeEach(() => {
  member = false;
  identitySession = null;
  probe.mockReset();
  usePreferencesStore.setState({ locale: "zh-CN" });
  // 缺省是成员：`/api/gateway` 403，对外服务这一块不出现。
  fakeCore({ status: 403 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("账号与设备：设备登录与设备表", () => {
  it("opens with one connection check, so device sign-in can confirm the service", async () => {
    probe.mockResolvedValue(hello);
    render(<SecurityPage />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("页头没有副标题，也没有与设备表重复的计数卡片", async () => {
    probe.mockResolvedValue(hello);
    render(<SecurityPage />);
    expect(screen.getByTestId("settings-heading")).toBeTruthy();
    expect(document.querySelector('[data-slot="settings-kpi"]')).toBeNull();
  });

  it("checks when a pairing link lands in a page that is already open", async () => {
    probe.mockResolvedValue(hello);
    const original = window.location.hash;
    try {
      render(<SecurityPage />);
      await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
      await act(async () => {
        window.history.replaceState(null, "", "#pair=abc.def");
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        await Promise.resolve();
      });
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      window.history.replaceState(
        null,
        "",
        original || window.location.pathname,
      );
    }
  });

  it("retries a failed check by itself while a pairing ticket waits, twice at most", async () => {
    probe.mockRejectedValue(new IdentityTransportError());
    const original = window.location.hash;
    window.history.replaceState(null, "", "#pair=abc.def");
    try {
      render(<SecurityPage />);
      await waitFor(() => expect(probe).toHaveBeenCalledTimes(3), {
        timeout: 4_000,
      });
      await new Promise((done) => setTimeout(done, 1_500));
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      window.history.replaceState(
        null,
        "",
        original || window.location.pathname,
      );
    }
  });

  it("checking again keeps the failure alert in place, only the button goes loading (no taller skeleton in between)", async () => {
    probe.mockRejectedValue(new IdentityTransportError());
    render(<SecurityPage />);
    const alert = await screen.findByRole("status");
    expect(alert.textContent).toContain("无法连接");
    let release: (value: typeof hello) => void = () => undefined;
    probe.mockReturnValue(
      new Promise<typeof hello>((resolve) => {
        release = resolve;
      }),
    );
    const button = within(alert).getByRole("button", { name: "检查连接" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByRole("status")).toBe(alert);
    expect(alert.textContent).toContain("无法连接");
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => release(hello));
    await waitFor(() => expect(alert.isConnected).toBe(false));
  });

  it("a failed check says why and offers to check again, without remote text", async () => {
    probe.mockRejectedValue(
      new IdentityRequestError(403, "PERMISSION_DENIED", "raw remote detail"),
    );
    render(<SecurityPage />);
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("拒绝访问");
    expect(status.textContent).not.toContain("raw remote detail");
    probe.mockResolvedValue(hello);
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
  });
});

describe("允许其他设备访问与已配对设备", () => {
  it("without /api/gateway only the switch is left (for the Internet route), no pairing", async () => {
    const calls = fakeCore({ status: 403 });
    render(<HostPage />);
    await waitFor(() =>
      expect(calls.some((call) => call.path === "/api/gateway")).toBe(true),
    );
    const toggle = screen.getByRole("switch", {
      name: "允许其他设备访问这台电脑",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("img", { name: "配对二维码" })).toBeNull();
  });

  it("a member on the server shell does not even ask", async () => {
    member = true;
    const calls = fakeCore({ status: runningStatus() });
    render(<HostPage />);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(
      calls.filter((call) => call.path.startsWith("/api/gateway")),
    ).toEqual([]);
    expect(
      screen.queryByRole("switch", { name: "允许其他设备访问这台电脑" }),
    ).toBeNull();
  });

  it("off shows only the switch; turning it on PUTs /api/gateway, the QR only shows once 连接手机 is opened", async () => {
    const calls = fakeCore({});
    render(<HostPage />);
    const toggle = await screen.findByRole("switch", {
      name: "允许其他设备访问这台电脑",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("互联网访问")).toBeNull();
    expect(screen.queryByRole("button", { name: "连接手机" })).toBeNull();
    expect(screen.queryByRole("img", { name: "配对二维码" })).toBeNull();

    fireEvent.click(toggle);
    const scan = await screen.findByRole("button", { name: "连接手机" });
    // 三行：开关、互联网访问、连接手机；点开对话框之前不铸配对码。
    expect(screen.getByText("互联网访问")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "配对二维码" })).toBeNull();
    expect(calls.some((call) => call.path === "/api/rpc/connect/offer")).toBe(
      false,
    );
    fireEvent.click(scan);
    const dialog = await screen.findByRole("dialog");
    const qr = await within(dialog).findByRole("img", { name: "配对二维码" });
    const put = calls.find((call) => call.method === "PUT");
    expect(put).toEqual({
      method: "PUT",
      path: "/api/gateway",
      body: { enabled: true },
    });
    expect(
      calls.find((call) => call.path === "/api/rpc/connect/offer")?.method,
    ).toBe("POST");
    // 二维码里是连接手机的网页链接（契约 §99.2）：同一个来源，票与指纹在片段里。
    const scanned = parseConnect(qr.getAttribute("data-qr-text") ?? "");
    expect(scanned.ok && scanned.webOrigin).toBe("https://192.168.1.20:8443");
    expect(scanned.ok && scanned.payload.direct).toEqual({
      origins: ["https://192.168.1.20:8443"],
      ticket: TICKET,
      fingerprint: FP,
    });
    expect(within(dialog).getByText(/2:00|1:59/)).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("link", { name: "下载 CA" })
        .getAttribute("href"),
    ).toBe("https://192.168.1.20:8443/ca.crt");
    // 关掉对话框：二维码收起。
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "配对二维码" })).toBeNull(),
    );
  });

  it("keeps the paired devices listed after the switch is turned off", async () => {
    const calls = fakeCore({
      status: runningStatus(),
      devices: [{ deviceId: "d-phone", name: "iPhone", role: "owner" }],
    });
    render(<HostPage />);
    await screen.findByRole("button", { name: "连接手机" });
    expect(await screen.findByText("iPhone")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("switch", { name: "允许其他设备访问这台电脑" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "连接手机" })).toBeNull(),
    );
    expect(calls.filter((call) => call.method === "PUT").at(-1)?.body).toEqual({
      enabled: false,
    });
    const table = screen.getByRole("table");
    expect(within(table).getByText("iPhone")).toBeTruthy();
    expect(
      within(table).getByRole("button", { name: "撤销 iPhone" }),
    ).toBeTruthy();
  });

  it("names why it could not start instead of printing the core's message", async () => {
    fakeCore({
      status: gatewayStatus({
        enabled: true,
        error: { code: "port_in_use", message: "raw EADDRINUSE detail" },
      }),
    });
    render(<HostPage />);
    expect((await screen.findByRole("alert")).textContent).toBe("端口已被占用");
    expect(document.body.textContent).not.toContain("raw EADDRINUSE");
  });

  it("a shell-managed gateway is read-only but still pairs", async () => {
    fakeCore({ status: { ...runningStatus(), managedBy: "shell" } });
    render(<HostPage />);
    const scan = await screen.findByRole("button", { name: "连接手机" });
    expect(
      (
        screen.getByRole("switch", {
          name: "允许其他设备访问这台电脑",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(scan);
    await screen.findByRole("img", { name: "配对二维码" });
  });

  it("lists paired devices once, marks this device and revokes the displayed revision", async () => {
    identitySession = sessionFor("d-mac", true);
    const calls = fakeCore({
      status: runningStatus(),
      devices: [
        { deviceId: "d-mac", name: "Mac", role: "owner" },
        { deviceId: "d-phone", name: "iPhone", role: "owner" },
      ],
    });
    render(<HostPage />);
    expect(await screen.findByText("iPhone")).toBeTruthy();
    // 只有一份设备表
    expect(screen.getAllByRole("table")).toHaveLength(1);
    const mac = screen.getByText("Mac").closest("tr") as HTMLElement;
    expect(within(mac).getByText("当前")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "撤销 iPhone" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销" }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.path === "/api/rpc/identity/devices/revoke")
          ?.body,
      ).toEqual({ json: { deviceId: "d-phone", expectedRevision: 2 } }),
    );
  });

  it("a member without the gateway block still sees its devices, read-only without manage", async () => {
    member = true;
    identitySession = sessionFor("d-mac", false);
    fakeCore({
      status: 403,
      devices: [{ deviceId: "d-mac", name: "Mac", role: "member" }],
    });
    render(<HostPage />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Mac")).toBeTruthy();
    expect(within(table).queryByRole("button")).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "允许其他设备访问这台电脑" }),
    ).toBeNull();
  });

  it("says when ACME renewal keeps failing and when it retries", async () => {
    const running = runningStatus();
    fakeCore({
      status: {
        ...running,
        tls: {
          ...running.tls,
          source: "acme",
          acme: {
            directory: "https://acme.test/dir",
            profile: null,
            names: ["armadra.example"],
            notAfter: "2026-10-20T00:00:00.000Z",
            renewAt: "2026-10-05T08:00:00.000Z",
            failures: 2,
            lastError: { code: "acme_failed", message: "raw CA detail" },
          },
        },
      },
    });
    render(<HostPage />);
    const alert = await screen.findByText(/^证书续期失败/);
    // 时间是下一次重试，不是失败发生的时间。
    expect(alert.closest("[role=alert]")?.textContent).toMatch(
      /^证书续期失败，将于 2026 年 10 月 5 日 \d{2}:\d{2} 重试$/,
    );
    expect(document.body.textContent).not.toContain("raw CA detail");
  });
});
