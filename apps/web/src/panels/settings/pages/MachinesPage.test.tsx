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

const api = vi.hoisted(() => ({
  executionHosts: vi.fn(),
  validateExecutionHost: vi.fn(),
  exportExecutionHosts: vi.fn(),
  importExecutionHosts: vi.fn(),
  resyncExecutionHost: vi.fn(),
  scanSshHostKeys: vi.fn(),
}));
const toasts = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  });
  return toast;
});
const runtime = vi.hoisted(() => ({
  hosts: [] as unknown[],
  mutate: vi.fn(),
}));
const compact = vi.hoisted(() => ({ value: false }));
vi.mock("@/api/client", () => ({ runtimeApi: api }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/platform/layout", async (original) => ({
  ...(await original<typeof import("@/platform/layout")>()),
  useCompactLayout: () => compact.value,
}));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: { ssh: { hosts: runtime.hosts } } },
    save: { mutate: runtime.mutate, isPending: false },
  }),
}));

import { MachinesPage } from "./MachinesPage";

const boxSsh = { id: "build-box", name: "Build box", host: "build.example" };

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en", settingsSubpage: null });
  runtime.hosts = [
    { ...boxSsh, user: "ci", port: 2222, worker: { path: "/opt/armadra" } },
  ];
  compact.value = false;
});
afterEach(() => {
  cleanup();
  for (const spy of Object.values(api)) spy.mockReset();
  for (const spy of [toasts, toasts.success, toasts.error, toasts.warning])
    spy.mockReset();
  runtime.mutate.mockReset();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MachinesPage />
    </QueryClientProvider>,
  );
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("设置 → SSH", () => {
  it("一张表：名称 · 地址 · 验证；不列 Worker 与工作区数，不再查执行主机表", async () => {
    mount();
    const table = await screen.findByRole("table");
    const row = within(table).getByText("Build box").closest("tr")!;
    expect(within(row).getByText("ci@build.example:2222")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Validate" })).toBeTruthy();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.queryByText("Worker")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resync all" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Import / export" }),
    ).toBeNull();
    expect(api.executionHosts).not.toHaveBeenCalled();
  });

  it("验证一步问完：只跑终端的机器连得上就是答案，Worker 握手成功说版本", async () => {
    api.validateExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      reachable: true,
      workerOk: false,
      capabilities: [],
      reason: "noWorkerConfigured",
      detail: "",
    });
    mount();
    await click(await screen.findByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Reachable, no Worker"),
    );

    api.validateExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      reachable: false,
      workerOk: false,
      capabilities: [],
      reason: "unreachable",
      detail: "ssh: connect timed out",
    });
    await click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Unreachable", {
        description: "ssh: connect timed out",
      }),
    );

    api.validateExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      reachable: true,
      workerOk: true,
      platform: "linux",
      architecture: "aarch64",
      runtimeVersion: "0.1.0",
      capabilities: [],
      detail: "",
    });
    await click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith(
        "Worker 0.1.0 · linux/aarch64",
      ),
    );
  });

  it("点名称进子页：连接参数、在那台机器上打开项目、主机密钥；Worker 填过时「高级」展开", async () => {
    mount();
    await click(await screen.findByRole("button", { name: "Build box" }));
    expect(usePreferencesStore.getState().settingsSubpage).toBe(
      "ssh:build-box",
    );
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe(
      "build.example",
    );
    expect(
      (screen.getByLabelText("Worker path") as HTMLInputElement).value,
    ).toBe("/opt/armadra");
    expect(screen.getByLabelText("Remote project path")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Host key" })).toBeTruthy();
    expect(screen.queryByText("Health history")).toBeNull();
    api.resyncExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      name: "Build box",
    });
    await click(screen.getByRole("button", { name: "Resync" }));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Resynced Build box"),
    );
  });

  it("新建主机：五项平铺，额外参数与 Worker 收在「高级」里，保存带上已有主机", async () => {
    runtime.hosts = [boxSsh];
    mount();
    await click(await screen.findByRole("button", { name: "Add" }));
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Key")).toBeTruthy();
    expect(screen.queryByLabelText("Worker path")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resync" })).toBeNull();
    await click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByLabelText("Worker path")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Far" },
    });
    fireEvent.change(screen.getByLabelText("Host"), {
      target: { value: "far.example" },
    });
    await click(screen.getByRole("button", { name: "Save" }));
    const saved = runtime.mutate.mock.calls[0]![0] as {
      ssh: { hosts: Array<{ name: string; host: string }> };
    };
    expect(saved.ssh.hosts.map((host) => host.host)).toEqual([
      "build.example",
      "far.example",
    ]);
  });

  it("没有主机：一句话加「添加」", async () => {
    runtime.hosts = [];
    mount();
    expect(await screen.findByText("No hosts yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("窄屏：一台一张条目，不画表格", async () => {
    compact.value = true;
    mount();
    expect(await screen.findByText("Build box")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("ci@build.example:2222")).toBeTruthy();
  });
});
