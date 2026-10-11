import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const cloneRepository = vi.fn();
const gitCloneStatus = vi.fn();
const cancelClone = vi.fn();
const cloneDefaults = vi.fn();
const forgeAccounts = vi.fn();
const forgeRepositories = vi.fn();
const createWorkspace = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    cloneRepository: (input: unknown) => cloneRepository(input),
    gitCloneStatus: (jobId: string) => gitCloneStatus(jobId),
    cancelClone: (jobId: string) => cancelClone(jobId),
    cloneDefaults: () => cloneDefaults(),
  },
  isConflict: () => false,
}));

vi.mock("../api/forge", () => ({
  forgeAccounts: () => forgeAccounts(),
  forgeRepositories: (host: string, cursor?: string | null) =>
    forgeRepositories(host, cursor ?? null),
}));

vi.mock("../files/gateway", () => ({
  filesGateway: {
    createWorkspace: (request: unknown) => createWorkspace(request),
  },
}));

vi.mock("../platform", () => ({
  pickDirectory: vi.fn().mockResolvedValue(null),
  isDesktop: () => false,
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { cloneProgress, NewWorkspaceDialog } from "./NewWorkspaceDialog";

installDomPolyfills();
afterEach(cleanup);

const WORKSPACE = {
  id: "ws-1",
  name: "demo",
  rootPath: "/home/me/Projects/demo",
  color: "#000000",
  permissions: { read: true, write: true, execute: true },
};

describe("cloneProgress", () => {
  it("取最近一行的百分比", () => {
    expect(cloneProgress([])).toBe(null);
    expect(cloneProgress(["remote: Enumerating objects: 12, done."])).toBe(
      null,
    );
    expect(
      cloneProgress([
        "Receiving objects: 100% (20/20), 4.00 KiB | 4.00 MiB/s, done.",
        "Resolving deltas:  60% (3/5)",
      ]),
    ).toBe(60);
  });
});

function row(owner: string, name: string, extra: object = {}) {
  return {
    host: "github.com",
    owner,
    name,
    forge: "github",
    description: "",
    private: false,
    fork: false,
    archived: false,
    defaultBranch: "main",
    cloneUrl: `https://github.com/${owner}/${name}.git`,
    sshUrl: `git@github.com:${owner}/${name}.git`,
    webUrl: `https://github.com/${owner}/${name}`,
    updatedAtMs: 0,
    ...extra,
  };
}

describe("NewWorkspaceDialog", () => {
  beforeEach(() => {
    for (const mock of [
      cloneRepository,
      gitCloneStatus,
      cancelClone,
      cloneDefaults,
      forgeAccounts,
      forgeRepositories,
      createWorkspace,
    ]) {
      mock.mockReset();
    }
    cancelClone.mockResolvedValue(undefined);
    cloneDefaults.mockResolvedValue({ parent: "/home/me/Projects" });
    forgeAccounts.mockResolvedValue([
      { host: "github.com", forge: "github", accountLogin: "octo" },
    ]);
    forgeRepositories.mockResolvedValue({
      items: [row("octo", "demo", { private: true }), row("octo", "other")],
      nextCursor: null,
    });
  });

  function open(onCreated = vi.fn(), onOpenChange = vi.fn()) {
    render(
      <TestProviders>
        <NewWorkspaceDialog
          open
          onOpenChange={onOpenChange}
          onCreated={onCreated}
        />
      </TestProviders>,
    );
    return { onCreated, onOpenChange };
  }

  function tab(name: string) {
    const trigger = screen.getByRole("tab", { name });
    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.click(trigger);
  }

  const primary = (name: string) =>
    screen.getByRole("button", { name }) as HTMLButtonElement;

  it("仓库：选一个仓库，克隆到缺省父目录，完成后交出工作空间", async () => {
    gitCloneStatus
      .mockResolvedValueOnce({
        state: "running",
        lines: ["Receiving objects:  40% (4/10)"],
      })
      .mockResolvedValue({ state: "done", lines: [], workspace: WORKSPACE });
    cloneRepository.mockResolvedValue({ jobId: "job-1" });
    const { onCreated, onOpenChange } = open();

    expect(await screen.findByText("octo/demo")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText("父目录") as HTMLInputElement).value).toBe(
        "/home/me/Projects",
      ),
    );
    expect(primary("克隆").disabled).toBe(true);

    fireEvent.click(screen.getByText("octo/demo"));
    expect(primary("克隆").disabled).toBe(false);
    fireEvent.click(primary("克隆"));

    await waitFor(() =>
      expect(cloneRepository).toHaveBeenCalledWith({
        url: "https://github.com/octo/demo.git",
        parent: "/home/me/Projects",
      }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalled(), {
      timeout: 3_000,
    });
    expect(onCreated.mock.calls[0]?.[0]).toMatchObject({ id: "ws-1" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("仓库：没有账号时只说未连接", async () => {
    forgeAccounts.mockResolvedValue([]);
    open();
    expect(await screen.findByText("未连接代码托管账号")).toBeTruthy();
    expect(forgeRepositories).not.toHaveBeenCalled();
    expect(primary("克隆").disabled).toBe(true);
  });

  it("仓库：一个账号不显示账号选择；按游标加载更多", async () => {
    forgeRepositories.mockImplementation(
      async (_host: string, cursor: string | null) =>
        cursor === null
          ? { items: [row("octo", "demo")], nextCursor: "2" }
          : { items: [row("octo", "later")], nextCursor: null },
    );
    open();
    expect(await screen.findByText("octo/demo")).toBeTruthy();
    expect(screen.queryByLabelText("账号")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("octo/later")).toBeTruthy();
    expect(forgeRepositories).toHaveBeenLastCalledWith("github.com", "2");
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("仓库：多个账号时出现账号选择，列表按所选主机取", async () => {
    forgeAccounts.mockResolvedValue([
      { host: "github.com", forge: "github", accountLogin: "octo" },
      { host: "git.example.com", forge: "gitea", accountLogin: null },
    ]);
    open();
    expect(await screen.findByText("octo/demo")).toBeTruthy();
    expect(screen.getByLabelText("账号")).toBeTruthy();
    expect(forgeRepositories).toHaveBeenCalledWith("github.com", null);
  });

  it("地址：非法地址不能提交；克隆失败显示原因", async () => {
    cloneRepository.mockResolvedValue({ jobId: "job-2" });
    gitCloneStatus.mockResolvedValue({
      state: "error",
      lines: ["fatal: repository not found"],
      error: "fatal: repository not found",
    });
    open();
    tab("地址");

    const field = await screen.findByLabelText("仓库地址");
    fireEvent.change(field, { target: { value: "file:///tmp/demo" } });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() =>
      expect((screen.getByLabelText("父目录") as HTMLInputElement).value).toBe(
        "/home/me/Projects",
      ),
    );
    expect(primary("克隆").disabled).toBe(true);

    fireEvent.change(field, {
      target: { value: "git@github.com:octo/missing.git" },
    });
    expect(primary("克隆").disabled).toBe(false);
    fireEvent.click(primary("克隆"));

    expect(
      await screen.findByText("fatal: repository not found", {
        selector: "span",
      }),
    ).toBeTruthy();
    expect(cloneRepository).toHaveBeenCalledWith({
      url: "git@github.com:octo/missing.git",
      parent: "/home/me/Projects",
    });
  });

  it("地址：目标已存在时显示 core 的拒绝，不起任务", async () => {
    cloneRepository.mockRejectedValue(
      new Error("A file or folder with that name already exists"),
    );
    open();
    tab("地址");
    fireEvent.change(await screen.findByLabelText("仓库地址"), {
      target: { value: "https://github.com/octo/demo.git" },
    });
    await waitFor(() => expect(primary("克隆").disabled).toBe(false));
    fireEvent.click(primary("克隆"));
    expect(
      await screen.findByText(
        "A file or folder with that name already exists",
        { selector: "span" },
      ),
    ).toBeTruthy();
    expect(gitCloneStatus).not.toHaveBeenCalled();
  });

  it("本地：引用已有文件夹，不新建目录", async () => {
    createWorkspace.mockResolvedValue(WORKSPACE);
    const { onCreated } = open();
    tab("本地");

    expect(screen.queryByLabelText("父目录")).toBeNull();
    fireEvent.change(await screen.findByLabelText("路径"), {
      target: { value: "/home/me/Projects/demo" },
    });
    fireEvent.click(primary("打开"));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createWorkspace.mock.calls[0]?.[0]).toMatchObject({
      name: "demo",
      rootPath: "/home/me/Projects/demo",
    });
    expect(createWorkspace.mock.calls[0]?.[0]).not.toHaveProperty(
      "createDirectory",
    );
  });
});
