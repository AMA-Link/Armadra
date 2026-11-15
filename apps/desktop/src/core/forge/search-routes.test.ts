/**
 * 搜索 / 筛选入参、计数答复、审查者 / 提交 / 候选三条路由与候选缓存（契约 §112）。
 * 平台实现换成记录调用的替身，不访问网络。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { forgeIssuePageSchema, forgePullSchema } from "@armadra/shared";

import { githubFixture } from "../github/fixture";
import { Router, emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import { FORGE_ROUTES, installRoutes } from "./routes";
import { FACETS_TTL_MS, ForgeService } from "./service";
import { ForgeStore } from "./store";
import type { Forge, ListOptions } from "./types";

const closing: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});

const REPO = "/api/forge/repos/git.test/acme/app";

async function harness() {
  const github = await githubFixture();
  closing.push(() => github.close());
  let clock = 1_800_000_000_000;
  const service = new ForgeService({
    store: new ForgeStore(github.db.database),
    secrets: () => ({
      kind: "file",
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
    }),
    now: () => clock,
  });
  const listed: { kind: string; options: ListOptions }[] = [];
  const facets = vi.fn(async () => ({
    labels: [{ name: "bug", color: "d73a4a" }],
    milestones: [{ title: "v1", open: true }],
    assignees: ["bob"],
  }));
  const forge = {
    kind: "gitea",
    listIssues: async (_repo: unknown, options: ListOptions) => {
      listed.push({ kind: "issues", options });
      return {
        items: [
          {
            number: 1,
            title: "t",
            body: "SECRET",
            state: "open",
            author: null,
            labels: [],
            commentCount: 0,
            url: "",
            createdAtMs: 1,
            updatedAtMs: 1,
            closedAtMs: null,
            assignees: [],
            milestone: null,
            linkedPulls: 0,
          },
        ],
        nextCursor: null,
        totalCount: 1,
        openCount: 1,
        closedCount: 0,
        page: options.page,
        pageCount: 1,
        unsupported: ["review:approved"],
      };
    },
    listPulls: async (_repo: unknown, options: ListOptions) => {
      listed.push({ kind: "pulls", options });
      return { items: [], nextCursor: null };
    },
    pullReviewers: async () => [
      { login: "a", state: "approved", submittedAtMs: 5 },
    ],
    pullCommits: async () => [
      {
        sha: "a".repeat(40),
        title: "t",
        author: null,
        authoredAtMs: 1,
        url: "",
      },
    ],
    facets,
  } as unknown as Forge;
  vi.spyOn(service, "forgeForReady").mockResolvedValue(forge);
  const router = new Router();
  installRoutes({ router } as unknown as CoreServer, service);
  const call = async (path: string, query: Record<string, string> = {}) => {
    const request = {
      ...emptyRequest("GET", path),
      query: new URLSearchParams(query),
    };
    return (await router.dispatch("GET", path, request)) as {
      status: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试里按需探查 JSON 响应体
      body: any;
    };
  };
  return {
    call,
    listed,
    facets,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("列表入参", () => {
  it("给了 q / sort / direction / page 才走富查询，页码压过 cursor，正文仍被清空", async () => {
    const h = await harness();
    const answer = await h.call(`${REPO}/issues`, {
      q: "is:closed label:core",
      sort: "comments",
      direction: "asc",
      page: "4",
      cursor: "9",
      limit: "20",
    });
    expect(answer.status).toBe(200);
    expect(h.listed[0]?.options).toEqual({
      state: "open",
      page: 4,
      limit: 20,
      rich: {
        query: "is:closed label:core",
        sort: "comments",
        direction: "asc",
      },
    });
    expect(answer.body.items[0].body).toBe("");
    expect(answer.body).toMatchObject({
      totalCount: 1,
      openCount: 1,
      closedCount: 0,
      page: 4,
      pageCount: 1,
      unsupported: ["review:approved"],
    });
    expect(forgeIssuePageSchema.parse(answer.body).totalCount).toBe(1);
  });

  it("什么都不给走旧路径：没有 rich，cursor 照旧当页码", async () => {
    const h = await harness();
    await h.call(`${REPO}/pulls`, { state: "all", cursor: "3" });
    expect(h.listed[0]?.options).toEqual({ state: "all", page: 3, limit: 0 });
  });

  it("只给 page 也算（q 缺省空串）", async () => {
    const h = await harness();
    await h.call(`${REPO}/pulls`, { page: "1" });
    expect(h.listed[0]?.options.rich).toEqual({ query: "" });
  });

  it.each([
    [{ sort: "popular" }],
    [{ direction: "up" }],
    [{ page: "0" }],
    [{ page: "x" }],
    [{ page: "1001" }],
    [{ q: "a".repeat(513) }],
    [{ q: "bad\u0007" }],
  ])("不合法的 %j 答 bad_request", async (query) => {
    const h = await harness();
    const answer = await h.call(`${REPO}/issues`, query);
    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe("bad_request");
    expect(h.listed).toEqual([]);
  });
});

describe("条目新字段的向后兼容", () => {
  it("旧 core 的 issue / PR 没有新字段时 schema 补缺省", () => {
    const pull = forgePullSchema.parse({
      number: 1,
      title: "t",
      body: "",
      state: "open",
      draft: false,
      author: null,
      baseRef: "main",
      headRef: "x",
      headSha: "",
      mergeable: "unknown",
      url: "",
      createdAtMs: 1,
      updatedAtMs: 1,
      mergedAtMs: null,
    });
    expect(pull).toMatchObject({
      labels: [],
      assignees: [],
      milestone: null,
      commentCount: 0,
      reviewDecision: null,
      checks: null,
      additions: null,
      deletions: null,
      changedFiles: null,
      commitCount: null,
      linkedIssues: [],
      authorAssociation: null,
    });
    const page = forgeIssuePageSchema.parse({ items: [], nextCursor: null });
    expect(page.totalCount).toBeUndefined();
  });
});

describe("审查者、提交与候选路由", () => {
  it("答 { reviewers } / { commits } / 候选", async () => {
    const h = await harness();
    expect(await h.call(`${REPO}/pulls/7/reviewers`)).toEqual({
      status: 200,
      body: {
        reviewers: [{ login: "a", state: "approved", submittedAtMs: 5 }],
      },
    });
    const commits = await h.call(`${REPO}/pulls/7/commits`);
    expect(commits.body.commits).toHaveLength(1);
    const facets = await h.call(`${REPO}/facets`);
    expect(facets.body).toEqual({
      labels: [{ name: "bug", color: "d73a4a" }],
      milestones: [{ title: "v1", open: true }],
      assignees: ["bob"],
    });
  });

  it("编号不对答 bad_request", async () => {
    const h = await harness();
    expect((await h.call(`${REPO}/pulls/0/reviewers`)).status).toBe(400);
    expect((await h.call(`${REPO}/pulls/x/commits`)).status).toBe(400);
  });

  it("路由登记了三条，都是 GET", () => {
    expect(FORGE_ROUTES.pullReviewers).toBe(
      `${"/api/forge/repos/{host}/{owner}/{name}"}/pulls/{number}/reviewers`,
    );
    expect(FORGE_ROUTES.pullCommits).toContain("/commits");
    expect(FORGE_ROUTES.facets).toContain("/facets");
  });

  it("候选按仓库短缓存：期内不再问平台，过期重取，别的仓库各取各的", async () => {
    const h = await harness();
    await h.call(`${REPO}/facets`);
    await h.call(`${REPO}/facets`);
    expect(h.facets).toHaveBeenCalledTimes(1);
    await h.call("/api/forge/repos/git.test/acme/other/facets");
    expect(h.facets).toHaveBeenCalledTimes(2);
    h.advance(FACETS_TTL_MS + 1);
    await h.call(`${REPO}/facets`);
    expect(h.facets).toHaveBeenCalledTimes(3);
  });
});
