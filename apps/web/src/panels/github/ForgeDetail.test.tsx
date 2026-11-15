import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** Issue / PR 详情与共用组件：Markdown 安全、评论时间线、PR 三页、检查汇总。 */

const forgeApi = vi.hoisted(() => ({
  forgeIssue: vi.fn(),
  forgeIssueComments: vi.fn(),
  forgePull: vi.fn(),
  forgePullComments: vi.fn(),
  forgePullFiles: vi.fn(),
  forgePullChecks: vi.fn(),
  forgePullReviewers: vi.fn(),
  forgePullCommits: vi.fn(),
}));
vi.mock("../../api/forge", async (original) => ({
  ...(await original<typeof import("../../api/forge")>()),
  ...forgeApi,
}));
const openExternal = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/platform", async (original) => ({
  ...(await original<typeof import("@/platform")>()),
  openExternal,
}));

import { usePreferencesStore } from "../../app/preferences-store";
import { forgePullExtSchema } from "../../api/forge";
import { ChecksView, ForgeChecksSummary } from "./ForgeChecksSummary";
import { IssueDetail, PullDetail, closedIssues } from "./ForgeDetail";
import { ForgeItemRow } from "./ForgeItemRow";
import { ForgeStateBadge } from "./ForgeStateBadge";

const REPO = { host: "git.example.test", owner: "acme", name: "app" };
const AT = 1_788_557_900_000;

const issue = {
  number: 21,
  title: "Login bounce",
  body: "hello **bold** <script>alert(1)</script> [bad](javascript:alert(1)) [ok](https://example.test/x)",
  state: "open" as const,
  author: "alice",
  labels: ["bug"],
  commentCount: 2,
  url: "",
  createdAtMs: AT,
  updatedAtMs: AT,
  closedAtMs: null,
};
const pull = {
  number: 12,
  title: "Login rework",
  body: "Split it.\n\nCloses #21",
  state: "open" as const,
  draft: false,
  author: "alice",
  baseRef: "main",
  headRef: "feature/login",
  headSha: "a".repeat(40),
  mergeable: "mergeable" as const,
  url: "",
  createdAtMs: AT,
  updatedAtMs: AT,
  mergedAtMs: null,
  autoMerge: false,
  fromFork: false,
};
const comments = [
  {
    id: "1",
    kind: "review" as const,
    author: "bob",
    body: "ship it",
    state: "approved",
    url: "",
    createdAtMs: AT,
  },
  {
    id: "2",
    kind: "comment" as const,
    author: "carol",
    body: "thanks",
    state: null,
    url: "",
    createdAtMs: AT,
  },
];
const checks = {
  headSha: pull.headSha,
  rollup: "failure" as const,
  checks: [
    { name: "lint", state: "success" as const, url: "https://ci.test/1" },
    { name: "test", state: "success" as const, url: "javascript:alert(1)" },
    { name: "e2e", state: "failure" as const, url: null },
    { name: "build", state: "pending" as const, url: null },
  ],
};

function wrap(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  for (const fn of Object.values(forgeApi)) fn.mockReset();
  openExternal.mockClear();
});
afterEach(cleanup);

describe("共用组件", () => {
  it("状态胶囊：草稿只在开启的 PR 上显示", () => {
    const { rerender } = render(<ForgeStateBadge state="open" draft />);
    expect(screen.getByText("草稿")).toBeTruthy();
    rerender(<ForgeStateBadge state="merged" draft />);
    expect(screen.getByText("已合并")).toBeTruthy();
  });

  it("条目行：编号、标题、作者、标签，可点击打开", () => {
    const onOpen = vi.fn();
    render(
      <ForgeItemRow kind="issue" item={issue} locale="zh-CN" onOpen={onOpen} />,
    );
    expect(screen.getByText("#21")).toBeTruthy();
    expect(screen.getByText("bug")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalled();
  });

  it("检查汇总：3 / 4 通过，展开后每项一行，只放行 http(s) 链接", () => {
    render(
      <ChecksView
        checks={{
          ...checks,
          checks: [
            ...checks.checks,
            { name: "docs", state: "success", url: null },
          ],
        }}
      />,
    );
    expect(screen.getByText("检查 3 / 5 通过")).toBeTruthy();
    fireEvent.click(screen.getByText("检查 3 / 5 通过"));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText("lint").closest("a")?.getAttribute("href")).toBe(
      "https://ci.test/1",
    );
    expect(screen.getByText("test").closest("a")).toBeNull();
  });

  it("紧凑态：一个圆点加 通过/总数；没有检查时不画", async () => {
    forgeApi.forgePullChecks.mockResolvedValue(checks);
    wrap(<ForgeChecksSummary repo={REPO} number={12} compact />);
    expect(await screen.findByText(/2\/4/)).toBeTruthy();
    cleanup();
    forgeApi.forgePullChecks.mockResolvedValue({
      headSha: "",
      rollup: "none",
      checks: [],
    });
    const { container } = wrap(
      <ForgeChecksSummary repo={REPO} number={13} compact />,
    );
    await Promise.resolve();
    expect(container.querySelector("[data-slot=forge-checks]")).toBeNull();
  });
});

describe("Issue 详情", () => {
  it("Markdown 正文不执行 HTML、不放行脚本链接；评论按时间线列出", async () => {
    forgeApi.forgeIssue.mockResolvedValue(issue);
    forgeApi.forgeIssueComments.mockResolvedValue(comments);
    const { container } = wrap(
      <IssueDetail
        repo={REPO}
        scope={null}
        number={21}
        locale="zh-CN"
        onBack={() => {}}
      />,
    );
    expect(await screen.findByText("bold")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    const ok = screen.getByText("ok").closest("a");
    expect(ok?.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("bad").closest("a")).toBeNull();
    expect(await screen.findByText("thanks")).toBeTruthy();
    expect(forgeApi.forgeIssueComments).toHaveBeenCalledWith(REPO, 21, null);
    expect(screen.getByText("bug")).toBeTruthy();
  });
});

describe("PR 详情", () => {
  beforeEach(() => {
    forgeApi.forgePull.mockResolvedValue(forgePullExtSchema.parse(pull));
    forgeApi.forgePullReviewers.mockResolvedValue([]);
    forgeApi.forgePullCommits.mockResolvedValue([]);
    forgeApi.forgePullChecks.mockResolvedValue(checks);
    forgeApi.forgePullComments.mockResolvedValue(comments);
    forgeApi.forgePullFiles.mockResolvedValue([
      {
        path: "a.ts",
        previousPath: null,
        status: "added",
        additions: 5,
        deletions: 0,
        patch: null,
      },
      {
        path: "b.ts",
        previousPath: null,
        status: "removed",
        additions: 0,
        deletions: 2,
        patch: null,
      },
    ]);
  });

  it("概览：base ← head、检查、改动文件卡片、评审结论", async () => {
    wrap(
      <PullDetail
        repo={REPO}
        scope={null}
        number={12}
        locale="zh-CN"
        onBack={() => {}}
      />,
    );
    expect(await screen.findByText("main ← feature/login")).toBeTruthy();
    expect(screen.getAllByText("Closes #21").length).toBeGreaterThan(0);
    expect(await screen.findByText("检查 2 / 4 通过")).toBeTruthy();
    // 旧 core 不给增删行：用改动文件页的合计顶上
    expect(await screen.findByText(/2 个文件/)).toBeTruthy();
    expect(screen.getByText("+5")).toBeTruthy();
    expect(await screen.findByText("ship it")).toBeTruthy();
    expect(
      screen.getByText("通过", { selector: "[data-slot=forge-review-state]" }),
    ).toBeTruthy();
    // 动态时间线在概览里
    expect(await screen.findByText("thanks")).toBeTruthy();
  });

  it("概览：作者、审查者、指派、标签、里程碑、关联与合并状态卡", async () => {
    forgeApi.forgePull.mockResolvedValue(
      forgePullExtSchema.parse({
        ...pull,
        labels: ["core"],
        assignees: ["dave"],
        milestone: "v0.18.0",
        reviewDecision: "changesRequested",
        additions: 842,
        deletions: 97,
        changedFiles: 12,
        commitCount: 3,
        linkedIssues: [947],
        authorAssociation: "member",
        mergeable: "conflicting",
      }),
    );
    forgeApi.forgePullReviewers.mockResolvedValue([
      { login: "owlbay", state: "approved", submittedAtMs: AT },
      { login: "reviewer", state: "changesRequested", submittedAtMs: AT },
    ]);
    wrap(
      <PullDetail
        repo={REPO}
        scope={null}
        number={12}
        locale="zh-CN"
        onBack={() => {}}
      />,
    );
    expect(await screen.findByText("成员")).toBeTruthy();
    expect(await screen.findByText("owlbay")).toBeTruthy();
    expect(screen.getByText("要求修改")).toBeTruthy();
    expect(screen.getByText("dave")).toBeTruthy();
    expect(screen.getByText("v0.18.0")).toBeTruthy();
    expect(screen.getByText("Closes #947")).toBeTruthy();
    expect(screen.getByText("+842")).toBeTruthy();
    expect(screen.getByText("−97")).toBeTruthy();
    expect(screen.getByText(/想把 3 个提交合进/)).toBeTruthy();
    const card = document.querySelector("[data-slot=forge-merge-status]");
    expect(card?.textContent).toContain("需要修改");
    expect(card?.textContent).toContain("1 位审查者要求修改");
    expect(card?.textContent).toContain("1 位已批准");
    expect(card?.textContent).toContain("与 main 有冲突");
  });

  it("提交页：forge.pullCommits 的列表", async () => {
    forgeApi.forgePullCommits.mockResolvedValue([
      {
        sha: "abcdef1234567",
        title: "feat: login",
        author: "alice",
        authoredAtMs: AT,
        url: "https://git.example.test/c/abcdef1",
      },
    ]);
    wrap(
      <PullDetail
        repo={REPO}
        scope={null}
        number={12}
        locale="zh-CN"
        onBack={() => {}}
      />,
    );
    await screen.findByText("main ← feature/login");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /^提交/ }));
    expect(await screen.findByText("feat: login")).toBeTruthy();
    expect(screen.getByText("abcdef1")).toBeTruthy();
  });

  it("旧 core 没有审查者与提交路由：概览照常渲染", async () => {
    forgeApi.forgePullReviewers.mockRejectedValue(new Error("501"));
    forgeApi.forgePullCommits.mockRejectedValue(new Error("501"));
    wrap(
      <PullDetail
        repo={REPO}
        scope={null}
        number={12}
        locale="zh-CN"
        onBack={() => {}}
      />,
    );
    expect(await screen.findByText("main ← feature/login")).toBeTruthy();
    expect(document.querySelector("[data-slot=forge-reviewer]")).toBeNull();
  });

  it("文件页", async () => {
    wrap(
      <PullDetail
        repo={REPO}
        scope={null}
        number={12}
        locale="zh-CN"
        onBack={() => {}}
      />,
    );
    await screen.findByText("main ← feature/login");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /^文件/ }));
    expect(await screen.findByText("a.ts")).toBeTruthy();
  });
});

describe("closedIssues", () => {
  it("识别 Closes / Fixes / Resolves 并去重", () => {
    expect(closedIssues("Closes #1, fixes #2\nResolved #1")).toEqual([1, 2]);
    expect(closedIssues("see #3")).toEqual([]);
  });
});
