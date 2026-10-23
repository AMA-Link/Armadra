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
import { TooltipProvider } from "@/ui/tooltip";

const api = vi.hoisted(() => ({
  executionHosts: vi.fn(),
  validateExecutionHost: vi.fn(),
  exportExecutionHosts: vi.fn(),
  importExecutionHosts: vi.fn(),
  resyncExecutionHost: vi.fn(),
  scanSshHostKeys: vi.fn(),
  openRemoteWorkspace: vi.fn(),
}));
const openWorkspace = vi.hoisted(() => vi.fn());
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
vi.mock("@/api/client", () => ({ localRuntimeApi: api }));
vi.mock("@/ui/toast", () => ({ toast: toasts }));
vi.mock("../../../app/workspace-actions", () => ({
  useOpenWorkspace: () => openWorkspace,
}));
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
  openWorkspace.mockReset();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MachinesPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("设置 → SSH", () => {
  it("页头有「添加主机」且没有副标题；表格卡：名称 · 地址 · Worker · 操作，不再查执行主机表", async () => {
    mount();
    const heading = await screen.findByTestId("settings-heading");
    expect(heading.tagName).toBe("H2");
    expect(
      heading.parentElement?.querySelectorAll("p, [data-slot=description]"),
    ).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Add host" })).toBeTruthy();
    const table = await screen.findByRole("table");
    const row = within(table).getByText("Build box").closest("tr")!;
    expect(within(row).getByText("ci@build.example:2222")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Validate" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Resync" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Open" })).toBeTruthy();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Name", "Address", "Worker", "Actions"]);
    expect(screen.queryByRole("button", { name: "Resync all" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Import / export" }),
    ).toBeNull();
    expect(api.executionHosts).not.toHaveBeenCalled();
  });

  it("打开远程项目：切到那块工作空间，并提示已打开（切换在对话框背后，看不见）", async () => {
    api.openRemoteWorkspace.mockResolvedValue({
      id: "ws-remote",
      name: "project",
    });
    mount();
    const table = await screen.findByRole("table");
    await click(within(table).getByRole("button", { name: "Open" }));
    const path = await screen.findByRole("textbox", {
      name: "Remote project path",
    });
    fireEvent.change(path, { target: { value: "/srv/project" } });
    await click(screen.getByRole("button", { name: "Open remote project" }));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Opened project"),
    );
    expect(api.openRemoteWorkspace).toHaveBeenCalledWith({
      name: "project",
      executionHostId: "build-box",
      rootPath: "/srv/project",
    });
    expect(openWorkspace).toHaveBeenCalledWith({
      id: "ws-remote",
      name: "project",
    });
  });

  it("没配 Worker 的主机不给「重新同步」", async () => {
    runtime.hosts = [boxSsh];
    mount();
    const table = await screen.findByRole("table");
    expect(within(table).queryByRole("button", { name: "Resync" })).toBeNull();
  });

  it("验证一步问完：结论落在 Worker 胶囊上，只有失败才弹提示", async () => {
    api.validateExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      reachable: true,
      workerOk: false,
      capabilities: [],
      reason: "noWorkerConfigured",
      detail: "",
    });
    mount();
    const status = (name: string) =>
      screen.findByText(name, { selector: "[data-slot=status-pill]" });
    expect(screen.queryByText("Reachable, no Worker")).toBeNull();
    await click(await screen.findByRole("button", { name: "Validate" }));
    expect((await status("Reachable, no Worker")).dataset.tone).toBe("paused");
    expect(toasts.error).not.toHaveBeenCalled();

    api.validateExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      reachable: false,
      workerOk: false,
      capabilities: [],
      reason: "unreachable",
      detail: "ssh: connect timed out",
    });
    await click(screen.getByRole("button", { name: "Validate" }));
    expect((await status("Unreachable")).dataset.tone).toBe("failed");
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
    expect((await status("Worker 0.1.0 · linux/aarch64")).dataset.tone).toBe(
      "done",
    );
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("表里「重新同步」直接重连 Worker", async () => {
    api.resyncExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      name: "Build box",
    });
    mount();
    await click(await screen.findByRole("button", { name: "Resync" }));
    expect(api.resyncExecutionHost).toHaveBeenCalledWith("build-box");
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Resynced Build box"),
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
    await click(await screen.findByRole("button", { name: "Add host" }));
    expect(screen.getByTestId("settings-heading").textContent).toBe("Add host");
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

  it("没有主机：卡内一句空态，页头仍有「添加主机」", async () => {
    runtime.hosts = [];
    mount();
    expect(await screen.findByText("No hosts yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Add host" })).toHaveLength(1);
  });

  it("窄屏：一台一张条目，不画表格", async () => {
    compact.value = true;
    mount();
    expect(await screen.findByText("Build box")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("ci@build.example:2222")).toBeTruthy();
  });
});
