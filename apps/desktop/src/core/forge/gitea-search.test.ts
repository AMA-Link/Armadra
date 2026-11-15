/** Gitea 的搜索、筛选、计数与审查 / 提交 / 候选（契约 §112）：全部用内存 fetch。 */

import { describe, expect, it } from "vitest";

import { GiteaForge, giteaFilter, giteaPullSort } from "./gitea";
import { mockFetch, type Handler } from "./mock-fetch.fixture";

const REPO = { host: "git.test", owner: "acme", name: "app" };
const SHA = "a".repeat(40);
const BASE = "http://127.0.0.1:3000/api/v1";

function forgeWith(handler: Handler) {
  const mock = mockFetch(handler);
  return {
    forge: new GiteaForge({
      apiBase: BASE,
      token: async () => "tok",
      fetch: mock.fetch,
    }),
    requests: mock.requests,
  };
}

const rich = (query: string) => ({
  state: "open" as const,
  page: 1,
  limit: 20,
  rich: { query },
});

function wirePull(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `pr ${number}`,
    state: "open",
    user: { login: "alice" },
    base: { ref: "main" },
    head: { ref: "feat", sha: SHA },
    labels: [{ name: "core" }],
    assignees: [{ login: "bob" }],
    milestone: { title: "v1" },
    comments: 2,
    additions: 5,
    deletions: 1,
    changed_files: 2,
    html_url: `http://git/pr/${number}`,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    ...extra,
  };
}

describe("giteaFilter", () => {
  it("限定词拆成列表参数，状态词压过 state，取反与审查进 unsupported", () => {
    const filter = giteaFilter("issues", {
      state: "open",
      page: 1,
      limit: 20,
      rich: {
        query:
          'is:closed label:bug label:"good first issue" milestone:v1 author:ann assignee:bob mentions:cy -label:x review:approved hello world',
        sort: "created",
        direction: "desc",
      },
    });
    expect(filter.state).toBe("closed");
    expect(filter.issueParams).toEqual({
      type: "issues",
      labels: "bug,good first issue",
      milestones: "v1",
      created_by: "ann",
      assigned_by: "bob",
      mentioned_by: "cy",
      q: "hello world",
    });
    expect(filter.unsupported).toEqual(["-label:x", "review:approved"]);
  });

  it("is:merged 当已关闭用并回报；issue 的非创建时间排序回报", () => {
    const merged = giteaFilter("pulls", rich("is:merged"));
    expect(merged.state).toBe("closed");
    expect(merged.unsupported).toEqual(["is:merged"]);
    const sorted = giteaFilter("issues", {
      state: "open",
      page: 1,
      limit: 20,
      rich: { query: "", sort: "comments", direction: "asc" },
    });
    expect(sorted.unsupported).toEqual(["sort:comments-asc"]);
  });

  it("需要全文 / 指派 / 作者的 PR 查询改走 issues 端点", () => {
    expect(giteaFilter("pulls", rich("label:a")).needsSearch).toBe(false);
    expect(giteaFilter("pulls", rich("hello")).needsSearch).toBe(true);
    expect(giteaFilter("pulls", rich("assignee:a")).needsSearch).toBe(true);
  });

  it("PR 排序取值", () => {
    expect(giteaPullSort("updated", "desc")).toBe("recentupdate");
    expect(giteaPullSort("updated", "asc")).toBe("leastupdate");
    expect(giteaPullSort("created", "asc")).toBe("oldest");
    expect(giteaPullSort("comments", "desc")).toBe("mostcomment");
  });
});

describe("issues 富查询", () => {
  it("参数、总数头、开启 / 已关闭计数；已知状态那边不多发请求", async () => {
    const { forge, requests } = forgeWith((request) => {
      if (request.path !== "/api/v1/repos/acme/app/issues") return undefined;
      const state = request.query.get("state");
      const total = request.query.get("limit") === "1" ? "9" : "42";
      return {
        body:
          request.query.get("limit") === "1"
            ? []
            : [
                {
                  number: 4,
                  title: "t",
                  state: "open",
                  assignees: [{ login: "bob" }],
                  milestone: { title: "v1" },
                  labels: [],
                },
                { number: 5, title: "pr", pull_request: {} },
              ],
        headers: {
          "x-total-count": state === "closed" ? "9" : total,
          link: '<http://x/?page=2>; rel="next"',
        },
      };
    });
    const page = await forge.listIssues(REPO, {
      state: "open",
      page: 1,
      limit: 20,
      rich: { query: "label:bug author:ann" },
    });
    expect(page.items.map((item) => item.number)).toEqual([4]);
    expect(page.items[0]).toMatchObject({
      assignees: ["bob"],
      milestone: "v1",
      linkedPulls: 0,
    });
    expect(page).toMatchObject({
      totalCount: 42,
      openCount: 42,
      closedCount: 9,
      page: 1,
      pageCount: 3,
      nextCursor: "2",
      unsupported: [],
    });
    // 主请求 + 已关闭计数，一共两次。
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query.get("labels")).toBe("bug");
    expect(requests[0]?.query.get("created_by")).toBe("ann");
    expect(requests[0]?.query.get("type")).toBe("issues");
    expect(requests[1]?.query.get("state")).toBe("closed");
    expect(requests[1]?.query.get("limit")).toBe("1");
    expect(requests[1]?.query.get("labels")).toBe("bug");
  });

  it("页码给了就翻页；总数头缺失时计数是 null", async () => {
    const { forge } = forgeWith(() => ({ body: [] }));
    const page = await forge.listIssues(REPO, {
      state: "all",
      page: 3,
      limit: 20,
      rich: { query: "" },
    });
    expect(page).toMatchObject({
      totalCount: null,
      openCount: null,
      closedCount: null,
      page: 3,
      pageCount: null,
    });
  });
});

describe("pulls 富查询", () => {
  it("标签与里程碑名字解析成 id，逐条取 CI（并发不超过 4）", async () => {
    let live = 0;
    let peak = 0;
    const { forge, requests } = forgeWith((request) => {
      const path = request.path.replace("/api/v1/repos/acme/app", "");
      if (path === "/labels") return { body: [{ id: 7, name: "core" }] };
      if (path === "/milestones") return { body: [{ id: 3, title: "v1" }] };
      if (path === "/pulls") {
        return {
          body: Array.from({ length: 9 }, (_, i) => wirePull(i + 1)),
          headers: { "x-total-count": "9" },
        };
      }
      if (path.endsWith("/status")) {
        live += 1;
        peak = Math.max(peak, live);
        live -= 1;
        return {
          body: {
            statuses: [
              { context: "build", status: "success" },
              { context: "lint", status: "failure" },
              { context: "build", status: "failure" },
            ],
          },
        };
      }
      return undefined;
    });
    const page = await forge.listPulls(REPO, rich("label:core milestone:v1"));
    const main = requests.find((item) => item.path.endsWith("/pulls"));
    expect(main?.query.getAll("labels")).toEqual(["7"]);
    expect(main?.query.get("milestone")).toBe("3");
    expect(main?.query.get("sort")).toBe("recentupdate");
    expect(page.items).toHaveLength(9);
    expect(page.items[0]).toMatchObject({
      labels: ["core"],
      assignees: ["bob"],
      milestone: "v1",
      commentCount: 2,
      additions: 5,
      deletions: 1,
      changedFiles: 2,
      checks: { rollup: "failure", passed: 1, total: 2 },
    });
    expect(page.totalCount).toBe(9);
    expect(peak).toBeLessThanOrEqual(4);
    expect(
      requests.filter((item) => item.path.endsWith("/status")),
    ).toHaveLength(9);
  });

  it("名字对不上就是没有匹配，不发列表请求", async () => {
    const { forge, requests } = forgeWith((request) =>
      request.path.endsWith("/labels") ? { body: [] } : undefined,
    );
    const page = await forge.listPulls(REPO, rich("label:nope"));
    expect(page).toMatchObject({
      items: [],
      totalCount: 0,
      openCount: 0,
      closedCount: 0,
    });
    expect(requests.some((item) => item.path.endsWith("/pulls"))).toBe(false);
  });

  it("全文搜索走 issues?type=pulls，再逐条取 PR；取不到的那条跳过", async () => {
    const { forge, requests } = forgeWith((request) => {
      const path = request.path.replace("/api/v1/repos/acme/app", "");
      if (path === "/issues") {
        return {
          body: [{ number: 1 }, { number: 2 }],
          headers: { "x-total-count": "2" },
        };
      }
      if (path === "/pulls/1") return { body: wirePull(1) };
      if (path === "/pulls/2") return { status: 404, body: {} };
      if (path.endsWith("/status")) return { body: { statuses: [] } };
      return undefined;
    });
    const page = await forge.listPulls(REPO, rich("hello"));
    expect(requests[0]?.query.get("type")).toBe("pulls");
    expect(requests[0]?.query.get("q")).toBe("hello");
    expect(page.items.map((item) => item.number)).toEqual([1]);
    expect(page.items[0]?.checks).toEqual({
      rollup: "none",
      passed: 0,
      total: 0,
    });
    expect(page.totalCount).toBe(2);
  });

  it("没有富查询：旧路径，条目取缺省的新字段", async () => {
    const { forge, requests } = forgeWith(() => ({
      body: [wirePull(1, { additions: undefined })],
    }));
    const page = await forge.listPulls(REPO, {
      state: "open",
      page: 1,
      limit: 20,
    });
    expect(requests).toHaveLength(1);
    expect(page).not.toHaveProperty("totalCount");
    expect(page.items[0]).toMatchObject({
      reviewDecision: null,
      checks: null,
      additions: null,
      linkedIssues: [],
      authorAssociation: null,
    });
  });
});

describe("审查者、提交与候选", () => {
  it("审查者：草稿丢掉、撤销记 dismissed、被请求者 pending", async () => {
    const { forge } = forgeWith((request) => {
      const path = request.path.replace("/api/v1/repos/acme/app", "");
      if (path === "/pulls/4/reviews") {
        return {
          body: [
            {
              user: { login: "a" },
              state: "REQUEST_CHANGES",
              submitted_at: "2026-11-01T00:00:00Z",
            },
            {
              user: { login: "a" },
              state: "COMMENT",
              submitted_at: "2026-11-02T00:00:00Z",
            },
            {
              user: { login: "b" },
              state: "APPROVED",
              dismissed: true,
              submitted_at: "2026-11-01T00:00:00Z",
            },
            { user: { login: "c" }, state: "PENDING" },
          ],
        };
      }
      if (path === "/pulls/4") {
        return { body: wirePull(4, { requested_reviewers: [{ login: "d" }] }) };
      }
      return undefined;
    });
    expect(await forge.pullReviewers(REPO, 4)).toEqual([
      {
        login: "a",
        state: "changesRequested",
        submittedAtMs: Date.parse("2026-11-01T00:00:00Z"),
      },
      {
        login: "b",
        state: "dismissed",
        submittedAtMs: Date.parse("2026-11-01T00:00:00Z"),
      },
      { login: "d", state: "pending", submittedAtMs: null },
    ]);
  });

  it("提交与候选", async () => {
    const { forge } = forgeWith((request) => {
      const path = request.path.replace("/api/v1/repos/acme/app", "");
      if (path === "/pulls/4/commits") {
        return {
          body: [
            {
              sha: SHA,
              html_url: "http://git/c/1",
              author: { login: "alice" },
              commit: {
                message: "one\n\nmore",
                author: { name: "A", date: "2026-11-01T00:00:00Z" },
              },
            },
          ],
        };
      }
      if (path === "/labels")
        return { body: [{ name: "bug", color: "d73a4a" }] };
      if (path === "/milestones")
        return { body: [{ title: "v1", state: "closed" }] };
      if (path === "/assignees") return { body: [{ login: "bob" }] };
      return undefined;
    });
    expect(await forge.pullCommits(REPO, 4)).toEqual([
      {
        sha: SHA,
        title: "one",
        author: "alice",
        authoredAtMs: Date.parse("2026-11-01T00:00:00Z"),
        url: "http://git/c/1",
      },
    ]);
    expect(await forge.facets(REPO)).toEqual({
      labels: [{ name: "bug", color: "d73a4a" }],
      milestones: [{ title: "v1", open: false }],
      assignees: ["bob"],
    });
  });
});
