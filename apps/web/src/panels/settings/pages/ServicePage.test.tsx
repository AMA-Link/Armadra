import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "../../../app/preferences-store";
import {
  IdentityRequestError,
  IdentityTransportError,
  type IdentityHello,
} from "../../../api/identity";

const probe = vi.fn();
const backupData = vi.fn();
vi.mock("../../../host/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../host/connection")>()),
  probeHost: (...args: unknown[]) => probe(...args),
}));
const access = vi.hoisted(() => ({ member: false, remote: false }));
vi.mock("../../../app/use-access", () => ({
  useAccess: () => ({ member: access.member }),
}));
vi.mock("../remote-access", () => ({
  useRemoteAccess: () => ({ remote: access.remote }),
}));
const settingsState = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutate: vi.fn(),
}));
vi.mock("../../../api/client", () => ({
  localClient: () => ({
    system: {
      hello: async () => ({ hostName: "mbp", systemHostName: "mbp" }),
    },
  }),
  localRuntimeApi: {
    dataInfo: async () => ({
      dataDir: "/Users/dev/Library/Application Support/Armadra",
      dbBytes: 1024,
      conversations: 3,
      boardLogRetentionDays: 30,
    }),
    backupData: (...args: unknown[]) => backupData(...args),
    localSettings: async () => ({ file: "", paths: [] }),
  },
}));
const sampling = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock("../../resources/use-resources", () => ({
  useResources: () => ({
    snapshot: sampling.snapshot,
    error: null,
    loading: false,
    refresh: () => undefined,
  }),
}));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: settingsState.data },
    save: { mutate: settingsState.mutate, isPending: false },
  }),
}));
vi.mock("../../../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform")>()),
  revealPath: vi.fn(),
}));

import { ServicePage } from "./ServicePage";

const hello: IdentityHello = {
  sourceId: "host-confirmed",
  hostInstanceId: "process-confirmed",
  maxFrameBytes: 1_048_576,
  capabilities: ["identity.native-session.v1"],
  protocol: { major: 1, minor: 1 },
};

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ServicePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  probe.mockReset().mockResolvedValue(hello);
});
afterEach(() => {
  access.member = false;
  access.remote = false;
  settingsState.data = {};
  settingsState.mutate.mockReset();
  sampling.snapshot = null;
  backupData.mockReset();
  cleanup();
});

describe("设置 → 本机服务", () => {
  it("打开就查一次连接；服务 ID 与能力折在「诊断」里", async () => {
    draw();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("已确认服务响应"),
    );
    expect(probe).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("host-confirmed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "诊断" }));
    expect(await screen.findByText("host-confirmed")).toBeTruthy();
    expect(screen.getByText("process-confirmed")).toBeTruthy();
    expect(screen.getByText("identity.native-session.v1")).toBeTruthy();
  });

  it("拒绝按本地文案说，不打印服务端原话；再查一次只发一次请求", async () => {
    probe.mockRejectedValue(
      new IdentityRequestError(403, "PERMISSION_DENIED", "raw remote detail"),
    );
    draw();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("拒绝访问"),
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      "raw remote detail",
    );
    probe.mockRejectedValue(new IdentityTransportError());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    });
    expect(screen.getByRole("status").textContent).toContain("无法连接");
    act(() => usePreferencesStore.setState({ locale: "en" }));
    expect(screen.getByRole("status").textContent).toContain("Cannot connect");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("owner：终端会话、电源与资源、数据三组；数据目录旁有「在访达中打开」", async () => {
    draw();
    expect(screen.getByText("终端会话")).toBeTruthy();
    expect(screen.getByText("电源与资源")).toBeTruthy();
    expect(screen.getByText("数据")).toBeTruthy();
    expect(await screen.findByText(/Application Support/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "在访达中打开" })).toBeTruthy();
    // 会话索引的条数与重建在「会话」页，这里不重复。
    expect(screen.queryByRole("button", { name: "重建" })).toBeNull();
  });

  it("远端主机：路径照常显示，不给打开（那是别的机器上的路径）", async () => {
    access.remote = true;
    draw();
    expect(await screen.findByText(/Application Support/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "在访达中打开" })).toBeNull();
  });

  it("主机名称（§61）：占位是系统主机名，失焦保存去首尾空白的名字，没变不存", async () => {
    settingsState.data = { host: { name: "" } };
    draw();
    const input = await screen.findByRole("textbox", { name: "主机名称" });
    await waitFor(() => expect(input.getAttribute("placeholder")).toBe("mbp"));
    fireEvent.blur(input);
    expect(settingsState.mutate).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  书房  " } });
    fireEvent.blur(input);
    expect(settingsState.mutate).toHaveBeenCalledWith(
      { host: { name: "书房" } },
      expect.anything(),
    );
  });

  it("主机名称清空：存空串，回到系统主机名", async () => {
    settingsState.data = { host: { name: "书房" } };
    draw();
    const input = await screen.findByRole("textbox", { name: "主机名称" });
    expect((input as HTMLInputElement).value).toBe("书房");
    fireEvent.change(input, { target: { value: " " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(settingsState.mutate).toHaveBeenCalledWith(
      { host: { name: "" } },
      expect.anything(),
    );
  });

  it("页头只有一个动作「立即备份」，没有副标题；点击备份数据库", async () => {
    backupData.mockResolvedValue({ path: "/tmp/x", bytes: 1 });
    draw();
    const heading = screen.getByTestId("settings-heading");
    expect(heading.parentElement?.querySelector("p")).toBeNull();
    const actions = heading.parentElement!.querySelector(
      "[data-slot=settings-page-actions]",
    )!;
    expect(actions.querySelectorAll("button")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "立即备份" }));
    });
    expect(backupData).toHaveBeenCalledTimes(1);
    // 备份挪到页头：数据组里不再有那一行
    expect(screen.queryByText("备份数据库")).toBeNull();
  });

  it("托盘：五张，值来自资源采样；没有样本时全是 —", async () => {
    draw();
    const values = () =>
      [...document.querySelectorAll("[data-slot=tray-value]")].map(
        (node) => node.textContent,
      );
    expect(values()).toEqual(["—", "—", "—", "—", "—"]);
    cleanup();
    sampling.snapshot = {
      host: {
        hostId: "local",
        location: "local",
        platform: "darwin",
        cpuPercent: 12,
        cpuCores: 8,
        memory: {
          totalBytes: 100,
          usedBytes: 50,
          availableBytes: 50,
          swapTotalBytes: null,
          swapUsedBytes: null,
          pressure: null,
        },
        loadAverage: null,
        disk: null,
        power: { source: null, batteryPercent: null, charging: null },
        uptimeSeconds: 7_200,
        sampledAt: "2026-10-23T08:00:00Z",
      },
      executionHosts: [],
      sessions: [
        { sessionId: "a", alive: true, unknownReason: null },
        { sessionId: "b", alive: false, unknownReason: "exited" },
      ],
      components: [],
    };
    draw();
    await waitFor(() =>
      expect(values()).toEqual(["12%", "50%", "—", "2小时 0分", "1"]),
    );
  });

  it("成员只见连接状态", async () => {
    access.member = true;
    draw();
    await waitFor(() => expect(probe).toHaveBeenCalled());
    expect(screen.queryByText("终端会话")).toBeNull();
    expect(screen.queryByText("数据")).toBeNull();
    // 托盘与备份都是整台机器的事，成员没有
    expect(document.querySelector("[data-slot=settings-kpi]")).toBeNull();
    expect(screen.queryByRole("button", { name: "立即备份" })).toBeNull();
  });
});
