/** GitLab 的搜索、筛选、计数与审查 / 提交 / 候选（契约 §112）：全部用内存 fetch。 */

import { describe, expect, it } from "vitest";

import { GitlabForge, gitlabFilter } from "./gitlab";
import { mockFetch, type Handler } from "./mock-fetch.fixture";

const REPO = { host: "gl.test", owner: "grp/sub", name: "app" };
const SHA = "a".repeat(40);
const API = "/api/v4/projects/grp%2Fsub%2Fapp";

function forgeWith(handler: Handler) {
  const mock = mockFetch(handler);
  return {
    forge: new GitlabForge({
      apiBase: "http://127.0.0.1:8080/api/v4",
      token: async () => "tok",
      fetch: mock.fetch,
    }),
    requests: mock.requests,
  };
}

const rich = (query: string, state: "open" | "closed" | "all" = "open") => ({
  state,
  page: 1,
  limit: 20,
  rich: { query },
});

function wireMr(iid: number, state = "opened") {
  return {
    iid,
    title: `mr ${iid}`,
    state,
    author: { username: "alice" },
    labels: ["core"],
    assignees: [{ username: "bob" }],
    reviewers: [{ username: "cy" }],
    milestone: { title: "v1" },
    user_notes_count: 4,
    changes_count: "1000+",
    source_branch: "feat",
    target_branch: "main",
    sha: SHA,
    web_url: `http://gl/mr/${iid}`,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
  };
}

describe("gitlabFilter", () => {
  it("issue：限定词拆成参数，取反与 no: 对应 GitLab 写法，其余进 unsupported", () => {
    const filter = gitlabFilter("issues", {
      state: "open",
      page: 1,
      limit: 20,
      rich: {
        query:
          "label:a label:b -label:c author:ann -author:bot assignee:bob milestone:v1 review:approved reviewer:x find me",
        sort: "created",
        direction: "asc",
      },
    });
    expect(filter.state).toBe("open");
    expect(filter.params).toEqual({
      labels: "a,b",
      "not[labels]": "c",
      author_username: "ann",
      "not[author_username]": "bot",
      assignee_username: "bob",
      milestone: "v1",
      search: "find me",
    });
    expect([filter.orderBy, filter.sort]).toEqual(["created_at", "asc"]);
    expect(filter.unsupported).toEqual(["reviewer:x", "review:approved"]);
  });

  it("no:label|milestone|assignee 与 MR 的草稿、分支、审查者", () => {
    const issue = gitlabFilter(
      "issues",
      rich("no:label no:milestone no:assignee"),
    );
    expect(issue.params).toEqual({
      labels: "None",
      milestone: "None",
      assignee_id: "None",
    });
    const mr = gitlabFilter(
      "merge_requests",
      rich("is:draft base:main head:feat reviewer:cy assignee:bob no:review"),
    );
    expect(mr.params).toEqual({
      draft: "yes",
      target_branch: "main",
      source_branch: "feat",
      reviewer_username: "cy",
    });
    // MR 列表没有按指派人名筛选；`no:review` 没有对应。
    expect(mr.unsupported).toEqual(["assignee:bob", "no:review"]);
  });

  it("is:merged：MR 用 merged，issue 当已关闭并回报；按评论排序回报并改按更新时间", () => {
    expect(gitlabFilter("merge_requests", rich("is:merged")).state).toBe(
      "merged",
    );
    const issue = gitlabFilter("issues", rich("is:merged"));
    expect(issue.state).toBe("closed");
    expect(issue.unsupported).toEqual(["is:merged"]);
    const comments = gitlabFilter("issues", {
      state: "open",
      page: 1,
      limit: 20,
      rich: { query: "", sort: "comments", direction: "desc" },
    });
    expect(comments.orderBy).toBe("updated_at");
    expect(comments.unsupported).toEqual(["sort:comments-desc"]);
  });
});

describe("issues 富查询", () => {
  it("总数 / 计数来自 X-Total；已知状态那边不多发请求；linkedPulls 来自 merge_requests_count", async () => {
    const { forge, requests } = forgeWith((request) => {
      if (request.path !== `${API}/issues`) return undefined;
      const state = request.query.get("state");
      return {
        body:
          request.query.get("per_page") === "1"
            ? []
            : [
                {
                  iid: 3,
                  title: "t",
                  state: "opened",
                  assignees: [{ username: "bob" }],
                  milestone: { title: "v1" },
                  merge_requests_count: 2,
                  labels: [],
                },
              ],
        headers: {
          "x-total": state === "closed" ? "5" : "25",
          "x-next-page": "2",
        },
      };
    });
    const page = await forge.listIssues(REPO, rich("label:bug"));
    expect(page.items[0]).toMatchObject({
      number: 3,
      assignees: ["bob"],
      milestone: "v1",
      linkedPulls: 2,
    });
    expect(page).toMatchObject({
      totalCount: 25,
      openCount: 25,
      closedCount: 5,
      pageCount: 2,
      page: 1,
      nextCursor: "2",
      unsupported: [],
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query.get("state")).toBe("opened");
    expect(requests[0]?.query.get("labels")).toBe("bug");
    expect(requests[0]?.query.get("order_by")).toBe("updated_at");
    expect(requests[1]?.query.get("state")).toBe("closed");
    expect(requests[1]?.query.get("per_page")).toBe("1");
  });
});

describe("merge requests 富查询", () => {
  it("已关闭按 all 取、滤掉开着的；已关闭数 = 全部 − 开启；逐条取 CI（并发 ≤ 4）", async () => {
    let live = 0;
    let peak = 0;
    const { forge, requests } = forgeWith((request) => {
      if (request.path === `${API}/merge_requests`) {
        const state = request.query.get("state");
        if (request.query.get("per_page") === "1") {
          return {
            body: [],
            headers: { "x-total": state === "opened" ? "3" : "30" },
          };
        }
        return {
          body: [
            wireMr(1, "merged"),
            wireMr(2, "opened"),
            wireMr(3, "closed"),
            ...[4, 5, 6, 7].map((iid) => wireMr(iid, "merged")),
          ],
          headers: { "x-total": "30" },
        };
      }
      if (request.path.endsWith("/statuses")) {
        live += 1;
        peak = Math.max(peak, live);
        live -= 1;
        return {
          body: [
            { id: 1, name: "build", status: "failed" },
            { id: 2, name: "build", status: "success" },
            { id: 3, name: "lint", status: "success" },
            { id: 4, name: "e2e", status: "running" },
          ],
        };
      }
      return undefined;
    });
    const page = await forge.listPulls(REPO, rich("", "closed"));
    const main = requests[0];
    expect(main?.query.get("state")).toBe("all");
    expect(page.items.map((item) => item.number)).toEqual([1, 3, 4, 5, 6, 7]);
    expect(page.items[0]).toMatchObject({
      labels: ["core"],
      assignees: ["bob"],
      milestone: "v1",
      commentCount: 4,
      changedFiles: 1000,
      checks: { rollup: "pending", passed: 2, total: 3 },
    });
    expect(page).toMatchObject({
      openCount: 3,
      closedCount: 27,
      totalCount: 27,
      pageCount: 2,
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(
      requests.filter((item) => item.path.endsWith("/statuses")),
    ).toHaveLength(6);
  });

  it("单页 CI 取不到只让那一行的 checks 为 null", async () => {
    const { forge } = forgeWith((request) => {
      if (request.path === `${API}/merge_requests`) {
        return { body: [wireMr(1)], headers: { "x-total": "1" } };
      }
      return { status: 500, body: {} };
    });
    const page = await forge.listPulls(REPO, rich(""));
    expect(page.items[0]?.checks).toBeNull();
  });

  it("没有富查询：旧路径，新字段取缺省", async () => {
    const { forge, requests } = forgeWith(() => ({ body: [wireMr(1)] }));
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
    });
  });
});

describe("审查者、提交与候选", () => {
  it("审查者：approvals 里的是 approved，其余被请求者 pending；没有 approvals 接口时只给被请求者", async () => {
    const withApprovals = forgeWith((request) => {
      if (request.path === `${API}/merge_requests/4`) {
        return { body: wireMr(4) };
      }
      if (request.path.endsWith("/approvals")) {
        return {
          body: {
            approved_by: [
              { user: { username: "cy" } },
              { user: { username: "dee" } },
            ],
          },
        };
      }
      return undefined;
    });
    expect(await withApprovals.forge.pullReviewers(REPO, 4)).toEqual([
      { login: "cy", state: "approved", submittedAtMs: null },
      { login: "dee", state: "approved", submittedAtMs: null },
    ]);
    const without = forgeWith((request) =>
      request.path === `${API}/merge_requests/4`
        ? { body: wireMr(4) }
        : { status: 404, body: {} },
    );
    expect(await without.forge.pullReviewers(REPO, 4)).toEqual([
      { login: "cy", state: "pending", submittedAtMs: null },
    ]);
  });

  it("提交从早到晚；候选的标签颜色去 #，成员读不到就空", async () => {
    const { forge } = forgeWith((request) => {
      if (request.path.endsWith("/commits")) {
        return {
          body: [
            {
              id: "b".repeat(40),
              title: "newer",
              author_name: "A",
              authored_date: "2026-11-02T00:00:00Z",
              web_url: "http://gl/c/2",
            },
            {
              id: SHA,
              title: "older",
              author_name: "B",
              authored_date: "2026-11-01T00:00:00Z",
              web_url: "http://gl/c/1",
            },
          ],
        };
      }
      if (request.path.endsWith("/labels")) {
        return { body: [{ name: "bug", color: "#d73a4a" }] };
      }
      if (request.path.endsWith("/milestones")) {
        return {
          body: [
            { title: "v1", state: "active" },
            { title: "v0", state: "closed" },
          ],
        };
      }
      return { status: 403, body: {} };
    });
    expect(
      (await forge.pullCommits(REPO, 4)).map((commit) => commit.title),
    ).toEqual(["older", "newer"]);
    expect(await forge.facets(REPO)).toEqual({
      labels: [{ name: "bug", color: "d73a4a" }],
      milestones: [
        { title: "v1", open: true },
        { title: "v0", open: false },
      ],
      assignees: [],
    });
  });
});
