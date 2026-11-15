/** GitHub 列表的 GraphQL 搜索（契约 §112.1）：查询构造、答复映射、一次请求。 */

import { describe, expect, it } from "vitest";

import { GithubForge, hostGithubAccess } from "./github";
import {
  type PullNode,
  checksFromNode,
  mapSearch,
  offsetCursor,
  planSearch,
  pullFromNode,
  searchDocument,
  searchVariables,
} from "./github-search";
import { mockFetch } from "./mock-fetch.fixture";
import { ForgeError } from "./types";

const REPO = { host: "github.com", owner: "acme", name: "app" };
const SHA = "a".repeat(40);

function pullNode(extra: Partial<PullNode> = {}): PullNode {
  return {
    number: 12,
    title: "fix sync",
    state: "OPEN",
    isDraft: false,
    merged: false,
    url: "https://github.com/acme/app/pull/12",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
    author: { login: "alice" },
    authorAssociation: "FIRST_TIME_CONTRIBUTOR",
    baseRefName: "main",
    headRefName: "fix/sync",
    headRefOid: SHA,
    mergeable: "CONFLICTING",
    isCrossRepository: true,
    autoMergeRequest: { enabledAt: "2026-11-02T00:00:00Z" },
    labels: { nodes: [{ name: "core" }, { name: "bug" }] },
    assignees: { nodes: [{ login: "bob" }] },
    milestone: { title: "v1" },
    comments: { totalCount: 3 },
    reviewDecision: "CHANGES_REQUESTED",
    additions: 10,
    deletions: 4,
    changedFiles: 2,
    closingIssuesReferences: { nodes: [{ number: 5 }, { number: 6 }] },
    commits: {
      totalCount: 3,
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                totalCount: 5,
                checkRunCountsByState: [
                  { state: "SUCCESS", count: 2 },
                  { state: "SKIPPED", count: 1 },
                  { state: "FAILURE", count: 1 },
                ],
                statusContextCountsByState: [{ state: "SUCCESS", count: 1 }],
              },
            },
          },
        },
      ],
    },
    ...extra,
  };
}

describe("planSearch", () => {
  const rich = { query: "label:core -author:bot sync" };

  it("补 repo 与类别，状态按参数，排序缺省更新时间倒序", () => {
    const plan = planSearch("pull", "acme", "app", "open", rich);
    expect(plan.query).toBe(
      "repo:acme/app is:pr label:core -author:bot sync is:open sort:updated-desc",
    );
    expect(plan.openQuery).toBe(
      "repo:acme/app is:pr label:core -author:bot sync is:open",
    );
    expect(plan.closedQuery).toBe(
      "repo:acme/app is:pr label:core -author:bot sync is:closed",
    );
    expect(plan.unsupported).toEqual([]);
  });

  it("词里的 is:closed 压过 state 参数，且计数查询不带状态词", () => {
    const plan = planSearch("issue", "acme", "app", "open", {
      query: "is:closed label:x",
    });
    expect(plan.query).toContain("is:issue label:x is:closed sort:");
    expect(plan.query).not.toContain("is:open");
    expect(plan.openQuery).toBe("repo:acme/app is:issue label:x is:open");
  });

  it("state=all 不加状态；is:merged 原样进主查询", () => {
    expect(planSearch("pull", "acme", "app", "all", { query: "" }).query).toBe(
      "repo:acme/app is:pr sort:updated-desc",
    );
    expect(
      planSearch("pull", "acme", "app", "open", { query: "is:merged" }).query,
    ).toBe("repo:acme/app is:pr is:merged sort:updated-desc");
  });

  it("排序参数与词里的 sort: 都认，参数优先", () => {
    expect(
      planSearch("issue", "a", "b", "all", {
        query: "sort:created-asc",
      }).query,
    ).toContain("sort:created-asc");
    expect(
      planSearch("issue", "a", "b", "all", {
        query: "sort:created-asc",
        sort: "comments",
        direction: "desc",
      }).query,
    ).toContain("sort:comments-desc");
  });

  it("越出仓库范围的限定词被丢掉并回报，不进查询", () => {
    const plan = planSearch("issue", "acme", "app", "open", {
      query: "repo:other/x org:o is:pr bug",
    });
    expect(plan.query).toBe(
      "repo:acme/app is:issue bug is:open sort:updated-desc",
    );
    expect(plan.unsupported).toEqual(["repo:other/x", "org:o", "is:pr"]);
  });
});

describe("请求变量与文档", () => {
  const plan = planSearch("pull", "acme", "app", "open", { query: "" });

  it("第 N 页用跳过前 (N-1)×每页 条的游标；第一页没有游标", () => {
    expect(searchVariables(plan, 1, 20)).toMatchObject({ first: 20 });
    expect(searchVariables(plan, 1, 20)).not.toHaveProperty("after");
    expect(searchVariables(plan, 3, 20).after).toBe(offsetCursor(40));
    expect(Buffer.from(offsetCursor(40), "base64").toString()).toBe(
      "cursor:40",
    );
  });

  it("超过搜索能给的前 1000 条拒绝", () => {
    expect(() => searchVariables(plan, 11, 100)).toThrow(ForgeError);
  });

  it("一条文档含列表与两个计数别名，PR 才带检查与审查字段", () => {
    const pull = searchDocument("pull");
    expect(pull).toContain("list: search(");
    expect(pull).toContain("open: search(");
    expect(pull).toContain("closed: search(");
    expect(pull).toContain("statusCheckRollup");
    expect(pull).toContain("reviewDecision");
    expect(pull).toContain("closingIssuesReferences");
    const issue = searchDocument("issue");
    expect(issue).toContain("closedByPullRequestsReferences");
    expect(issue).not.toContain("statusCheckRollup");
  });
});

describe("答复映射", () => {
  it("PR 节点映射成 forge 形状", () => {
    const pull = pullFromNode(pullNode());
    expect(pull).toMatchObject({
      number: 12,
      state: "open",
      draft: false,
      author: "alice",
      headSha: SHA,
      mergeable: "conflicting",
      fromFork: true,
      autoMerge: true,
      labels: ["core", "bug"],
      assignees: ["bob"],
      milestone: "v1",
      commentCount: 3,
      reviewDecision: "changesRequested",
      additions: 10,
      deletions: 4,
      changedFiles: 2,
      commitCount: 3,
      linkedIssues: [5, 6],
      authorAssociation: "firstTimeContributor",
      checks: { rollup: "failure", passed: 4, total: 5 },
      body: "",
    });
  });

  it("没有检查：none 与 0/0；审查结论缺省 null；已合并不算开着", () => {
    const node = pullNode({
      state: "MERGED",
      merged: true,
      mergedAt: "2026-11-03T00:00:00Z",
      reviewDecision: null,
      authorAssociation: "NONE",
      commits: {
        totalCount: 1,
        nodes: [{ commit: { statusCheckRollup: null } }],
      },
    });
    const pull = pullFromNode(node);
    expect(pull.checks).toEqual({ rollup: "none", passed: 0, total: 0 });
    expect(pull.reviewDecision).toBeNull();
    expect(pull.authorAssociation).toBeNull();
    expect(pull.state).toBe("merged");
    expect(pull.mergeable).toBe("unknown");
    expect(pull.mergedAtMs).toBe(Date.parse("2026-11-03T00:00:00Z"));
    expect(pull.autoMerge).toBe(false);
  });

  it("检查结论的各种状态", () => {
    const of = (state: string) =>
      checksFromNode(
        pullNode({
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: { state, contexts: { totalCount: 2 } },
                },
              },
            ],
          },
        }),
      ).rollup;
    expect(of("SUCCESS")).toBe("success");
    expect(of("ERROR")).toBe("failure");
    expect(of("EXPECTED")).toBe("pending");
    expect(of("PENDING")).toBe("pending");
  });

  it("mapSearch：计数、页数（最多按前 1000 条）、丢掉没编号的节点", () => {
    const result = mapSearch(
      {
        list: { issueCount: 2500, nodes: [pullNode(), null, {}] },
        open: { issueCount: 40 },
        closed: { issueCount: 2460 },
      },
      2,
      50,
      (node) => node.number,
    );
    expect(result).toEqual({
      items: [12],
      totalCount: 2500,
      openCount: 40,
      closedCount: 2460,
      page: 2,
      pageCount: 20,
    });
    expect(() => mapSearch({}, 1, 50, (node) => node)).toThrow(ForgeError);
    expect(() => mapSearch(null, 1, 50, (node) => node)).toThrow(ForgeError);
  });
});

describe("GithubForge 富查询", () => {
  function forgeWith(handler: Parameters<typeof mockFetch>[0]) {
    const mock = mockFetch(handler);
    const access = hostGithubAccess(
      "https://api.github.com",
      async () => "ghp_test_token",
      { fetch: mock.fetch, attempts: 1 },
    );
    return { forge: new GithubForge(access), requests: mock.requests };
  }

  it("一页只发一次 GraphQL 请求，带计数与页码，令牌只在头里", async () => {
    const { forge, requests } = forgeWith(() => ({
      body: {
        data: {
          list: { issueCount: 120, nodes: [pullNode()] },
          open: { issueCount: 100 },
          closed: { issueCount: 20 },
        },
      },
    }));
    const page = await forge.listPulls(REPO, {
      state: "open",
      page: 2,
      limit: 50,
      rich: { query: "label:core" },
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/graphql");
    expect(request?.headers.get("authorization")).toBe("Bearer ghp_test_token");
    const body = request?.body as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.variables.q).toBe(
      "repo:acme/app is:pr label:core is:open sort:updated-desc",
    );
    expect(body.variables.after).toBe(offsetCursor(50));
    expect(JSON.stringify(page)).not.toContain("ghp_test_token");
    expect(page).toMatchObject({
      totalCount: 120,
      openCount: 100,
      closedCount: 20,
      page: 2,
      pageCount: 3,
      nextCursor: "3",
      unsupported: [],
    });
    expect(page.items[0]?.checks).toEqual({
      rollup: "failure",
      passed: 4,
      total: 5,
    });
  });

  it("最后一页没有 nextCursor；issue 同样走 GraphQL", async () => {
    const { forge, requests } = forgeWith(() => ({
      body: {
        data: {
          list: {
            issueCount: 1,
            nodes: [
              {
                number: 3,
                title: "t",
                state: "CLOSED",
                url: "https://github.com/acme/app/issues/3",
                createdAt: "2026-11-01T00:00:00Z",
                updatedAt: "2026-11-02T00:00:00Z",
                closedAt: "2026-11-02T00:00:00Z",
                assignees: { nodes: [{ login: "bob" }] },
                milestone: { title: "v2" },
                closedByPullRequestsReferences: { totalCount: 2 },
              },
            ],
          },
          open: { issueCount: 0 },
          closed: { issueCount: 1 },
        },
      },
    }));
    const page = await forge.listIssues(REPO, {
      state: "closed",
      page: 1,
      limit: 50,
      rich: { query: "" },
    });
    expect(requests).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({
      state: "closed",
      assignees: ["bob"],
      milestone: "v2",
      linkedPulls: 2,
    });
  });

  it("没有富查询时保留原来的 REST 路径，不出新字段的计数", async () => {
    const { forge, requests } = forgeWith((request) =>
      request.path === "/repos/acme/app/issues" ? { body: [] } : undefined,
    );
    const page = await forge.listIssues(REPO, {
      state: "open",
      page: 1,
      limit: 50,
    });
    expect(requests.map((item) => `${item.method} ${item.path}`)).toEqual([
      "GET /repos/acme/app/issues",
    ]);
    expect(page).not.toHaveProperty("totalCount");
  });

  it("GraphQL 报错翻成 forge 的拒绝", async () => {
    const { forge } = forgeWith(() => ({
      body: { errors: [{ type: "FORBIDDEN" }] },
    }));
    await expect(
      forge.listIssues(REPO, {
        state: "open",
        page: 1,
        limit: 10,
        rich: { query: "" },
      }),
    ).rejects.toMatchObject({ kind: "remoteForbidden" });
  });
});

describe("GithubForge 审查者、提交与筛选候选", () => {
  function forgeWith(handler: Parameters<typeof mockFetch>[0]) {
    const mock = mockFetch(handler);
    return new GithubForge(
      hostGithubAccess("https://api.github.com", async () => "ghp_test_token", {
        fetch: mock.fetch,
        attempts: 1,
      }),
    );
  }

  it("审查者：各人最新结论，只评论不盖掉先前的通过，被请求者是 pending", async () => {
    const forge = forgeWith((request) => {
      if (request.path.endsWith("/reviews")) {
        return {
          body: [
            {
              user: { login: "a" },
              state: "CHANGES_REQUESTED",
              submitted_at: "2026-11-01T00:00:00Z",
            },
            {
              user: { login: "a" },
              state: "APPROVED",
              submitted_at: "2026-11-02T00:00:00Z",
            },
            {
              user: { login: "a" },
              state: "COMMENTED",
              submitted_at: "2026-11-03T00:00:00Z",
            },
            {
              user: { login: "b" },
              state: "COMMENTED",
              submitted_at: "2026-11-01T00:00:00Z",
            },
            {
              user: { login: "c" },
              state: "DISMISSED",
              submitted_at: "2026-11-01T00:00:00Z",
            },
            { user: { login: "d" }, state: "PENDING" },
            {
              user: { login: "e" },
              state: "APPROVED",
              submitted_at: "2026-11-01T00:00:00Z",
            },
          ],
        };
      }
      if (request.path.endsWith("/requested_reviewers")) {
        return { body: { users: [{ login: "e" }, { login: "f" }], teams: [] } };
      }
      return undefined;
    });
    const reviewers = await forge.pullReviewers(REPO, 9);
    expect(reviewers).toEqual([
      {
        login: "a",
        state: "approved",
        submittedAtMs: Date.parse("2026-11-02T00:00:00Z"),
      },
      {
        login: "b",
        state: "commented",
        submittedAtMs: Date.parse("2026-11-01T00:00:00Z"),
      },
      {
        login: "c",
        state: "dismissed",
        submittedAtMs: Date.parse("2026-11-01T00:00:00Z"),
      },
      { login: "e", state: "pending", submittedAtMs: null },
      { login: "f", state: "pending", submittedAtMs: null },
    ]);
  });

  it("提交：标题取首行，作者先登录名后提交者名，非法 sha 丢掉", async () => {
    const forge = forgeWith((request) =>
      request.path === "/repos/acme/app/pulls/9/commits"
        ? {
            body: [
              {
                sha: SHA,
                html_url: "https://github.com/acme/app/commit/" + SHA,
                author: { login: "alice" },
                commit: {
                  message: "fix: one\n\nbody",
                  author: { name: "Alice A", date: "2026-11-01T00:00:00Z" },
                },
              },
              {
                sha: "b".repeat(40),
                html_url: "javascript:alert(1)",
                author: null,
                commit: {
                  message: "second",
                  author: { name: "Bob B", date: "2026-11-02T00:00:00Z" },
                },
              },
              { sha: "short", commit: { message: "x" } },
            ],
          }
        : undefined,
    );
    const commits = await forge.pullCommits(REPO, 9);
    expect(commits).toEqual([
      {
        sha: SHA,
        title: "fix: one",
        author: "alice",
        authoredAtMs: Date.parse("2026-11-01T00:00:00Z"),
        url: "https://github.com/acme/app/commit/" + SHA,
      },
      {
        sha: "b".repeat(40),
        title: "second",
        author: "Bob B",
        authoredAtMs: Date.parse("2026-11-02T00:00:00Z"),
        url: "",
      },
    ]);
  });

  it("筛选候选：标签颜色去 #，里程碑开 / 关，可指派的人读不到就空", async () => {
    const forge = forgeWith((request) => {
      if (request.path.endsWith("/labels")) {
        return {
          body: [
            { name: "bug", color: "d73a4a" },
            { name: "x", color: "zz" },
          ],
        };
      }
      if (request.path.endsWith("/milestones")) {
        expect(request.query.get("state")).toBe("all");
        return {
          body: [
            { title: "v1", state: "open" },
            { title: "v0", state: "closed" },
          ],
        };
      }
      return { status: 403, body: {} };
    });
    expect(await forge.facets(REPO)).toEqual({
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "x", color: null },
      ],
      milestones: [
        { title: "v1", open: true },
        { title: "v0", open: false },
      ],
      assignees: [],
    });
  });
});

describe("GithubForge 详情补充", () => {
  const restIssue = {
    number: 3,
    title: "t",
    state: "open",
    user: { login: "alice" },
    labels: [],
    html_url: "https://github.com/acme/app/issues/3",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
  };

  function forgeWith(graphql: () => { status?: number; body?: unknown }) {
    const mock = mockFetch((request) =>
      request.path === "/repos/acme/app/issues/3"
        ? { body: restIssue }
        : request.path === "/graphql"
          ? graphql()
          : undefined,
    );
    return new GithubForge(
      hostGithubAccess("https://api.github.com", async () => "ghp_test", {
        fetch: mock.fetch,
        attempts: 1,
      }),
    );
  }

  it("issue 详情带上 GraphQL 给的指派、里程碑与关联 PR", async () => {
    const forge = forgeWith(() => ({
      body: {
        data: {
          repository: {
            item: {
              number: 3,
              assignees: { nodes: [{ login: "bob" }] },
              milestone: { title: "v2" },
              closedByPullRequestsReferences: { totalCount: 1 },
            },
          },
        },
      },
    }));
    expect(await forge.getIssue(REPO, 3)).toMatchObject({
      author: "alice",
      assignees: ["bob"],
      milestone: "v2",
      linkedPulls: 1,
    });
  });

  it("补充失败不拖累详情：留缺省值", async () => {
    const forge = forgeWith(() => ({ status: 502, body: {} }));
    expect(await forge.getIssue(REPO, 3)).toMatchObject({
      author: "alice",
      assignees: [],
      milestone: null,
      linkedPulls: 0,
    });
  });
});
