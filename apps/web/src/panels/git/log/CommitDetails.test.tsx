import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitCommitDetail,
  GitCommitFileDiff,
  GitLogCommit,
} from "@armadra/shared";

import { installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { CommitDetails } from "./CommitDetails";

installDomPolyfills();

const commitDetail = vi.fn<() => Promise<GitCommitDetail>>();
const commitFile = vi.fn<() => Promise<GitCommitFileDiff>>();

vi.mock("../../../git/gateway", () => ({
  gitGateway: {
    commitDetail: () => commitDetail(),
    commitFile: () => commitFile(),
  },
}));

const oid = (char: string) => char.repeat(40);

const commit: GitLogCommit = {
  repositoryPath: ".",
  oid: oid("a"),
  parents: [oid("b")],
  subject: "fix(web): the thing",
  authorName: "Ada",
  authorEmail: "ada@example.invalid",
  authorTime: "2026-09-01T00:00:00Z",
  committerTime: "2026-09-01T00:00:00Z",
  refs: ["HEAD -> refs/heads/main"],
};

const detail: GitCommitDetail = {
  oid: oid("a"),
  baseOid: oid("b"),
  commit: { ...commit },
  files: [
    { status: "M", path: "apps/web/src/a.ts", additions: 3, deletions: 1 },
    { status: "M", path: "apps/web/src/b.ts", additions: 1, deletions: 0 },
    {
      status: "R",
      path: "old/c.ts -> apps/host/c.ts",
      additions: 0,
      deletions: 0,
    },
  ],
  truncated: false,
};

function view(overrides: Partial<Parameters<typeof CommitDetails>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CommitDetails
        workspaceId="workspace"
        target={{ workspaceId: "workspace", repositoryPath: "/project" }}
        commit={commit}
        base={null}
        onBaseChange={() => undefined}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  usePreferencesStore.getState().setGitPreference("flatFiles", false);
  commitDetail.mockResolvedValue(detail);
  commitFile.mockResolvedValue({
    oid: oid("a"),
    baseOid: oid("b"),
    path: "apps/web/src/a.ts",
    patch: "@@ -1 +1 @@\n-old\n+new",
    truncated: false,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("提交详情", () => {
  it("按目录分组，合并只有一条路的段", async () => {
    view();
    await screen.findByText("web/src");
    expect(screen.getByText("a.ts")).toBeTruthy();
    // 重命名的两端都在，新名字是行的标题。
    expect(screen.getByText("old/c.ts", { exact: false })).toBeTruthy();
  });

  it("切到平铺后每一行是完整路径", async () => {
    view();
    await screen.findByText("web/src");
    usePreferencesStore.getState().setGitPreference("flatFiles", true);
    expect(await screen.findByText("apps/web/src/a.ts")).toBeTruthy();
    expect(screen.queryByText("web/src")).toBeNull();
    usePreferencesStore.getState().setGitPreference("flatFiles", false);
  });

  it("上「变更文件」下「提交详情」，顶部写明比较方向（#935 C2）", async () => {
    const { container } = view();
    await screen.findByText("web/src");
    expect(
      container.querySelector('[data-slot="git-log-changed-files"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-slot="git-log-commit-info"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-slot="git-log-compare"]')!.textContent,
    ).toContain(`Compare ${oid("b").slice(0, 7)} → ${oid("a").slice(0, 7)}`);
    // 没点过文件时不打开差异。
    expect(commitFile).not.toHaveBeenCalled();
  });

  it("单击文件只选中；双击才在对话框里打开差异", async () => {
    view();
    const file = await screen.findByText("a.ts");
    fireEvent.click(file);
    expect(commitFile).not.toHaveBeenCalled();
    fireEvent.doubleClick(file);
    await waitFor(() => expect(commitFile).toHaveBeenCalled());
    expect((await screen.findByLabelText("File diff")).textContent).toContain(
      "+new",
    );
  });

  it("选中后「打开 Diff」按钮可用；回车也能打开", async () => {
    view();
    const openDiff = await screen.findByRole("button", { name: "Open diff" });
    expect(openDiff.hasAttribute("disabled")).toBe(true);
    const file = await screen.findByText("a.ts");
    fireEvent.click(file);
    expect(openDiff.hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(file.closest("button")!, { key: "Enter" });
    expect(await screen.findByLabelText("File diff")).toBeTruthy();
  });

  it("差异对话框里的并排开关进偏好", async () => {
    view();
    fireEvent.doubleClick(await screen.findByText("a.ts"));
    await screen.findByLabelText("File diff");
    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
    expect(usePreferencesStore.getState().git.diffSplit).toBe(true);
    usePreferencesStore.getState().setGitPreference("diffSplit", false);
  });

  it("点父提交交给外面去日志里定位", async () => {
    const onSelectParent = vi.fn();
    view({ onSelectParent });
    fireEvent.click(
      await screen.findByRole("button", { name: oid("b").slice(0, 7) }),
    );
    expect(onSelectParent).toHaveBeenCalledWith(oid("b"));
  });

  it("合并提交才有「与哪个父比」的切换", async () => {
    const onBaseChange = vi.fn();
    const single = view();
    await screen.findByText("web/src");
    expect(screen.queryByText("Compare against")).toBeNull();
    single.unmount();
    view({
      commit: { ...commit, parents: [oid("b"), oid("c")] },
      onBaseChange,
    });
    await screen.findByText("Compare against");
    fireEvent.click(screen.getByText("Parent 2"));
    expect(onBaseChange).toHaveBeenCalledWith(oid("c"));
  });

  it("hash 与 ref 徽标都在最上面", async () => {
    view();
    await screen.findByText(oid("a"));
    expect(screen.getByText("HEAD")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
  });
});
