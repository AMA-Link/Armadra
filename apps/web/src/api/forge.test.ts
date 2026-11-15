import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  autoMergeForgePull,
  configTarget,
  deleteForgeBranch,
  deleteForgeConfig,
  forgeAccounts,
  forgeConfigs,
  forgeFailure,
  forgeFacets,
  forgeIssues,
  forgePullCommits,
  forgePullReviewers,
  forgePulls,
  mergeForgePull,
  forgeRepositories,
  putForgeConfig,
  resolveForge,
} from "./forge";
import { RuntimeRequestError } from "./request";
import { setCurrentSourceResolver } from "./source";

/**
 * 托管平台面（契约 §29、§41.2）：配置键怎么拆成 procedure 的入参，调用发
 * `POST /api/rpc/forge/<动词>`、体是 `{ json: … }`，答案过页面自己的 schema。
 */

const REPO = { host: "git.example.test", owner: "acme", name: "app" };
const SHA = "a".repeat(40);

type Call = { url: string; init: RequestInit };
let calls: Call[];

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        init: init ?? {},
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const ok = (json: unknown) => respond(200, { json });
const procedure = (index = 0) => calls[index]?.url.split("/api/rpc/")[1];
const sent = (index = 0) =>
  (JSON.parse(String(calls[index]?.init.body ?? "null")) as { json: unknown })
    .json;

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCurrentSourceResolver(null);
});

describe("配置键（契约 §29.3、§29.6）", () => {
  it("主机、两段仓库、多级子组的仓库", () => {
    expect(configTarget("gitlab.example.test")).toEqual({
      host: "gitlab.example.test",
    });
    expect(configTarget("git.example.test/acme/app")).toEqual({
      host: "git.example.test",
      owner: "acme",
      name: "app",
    });
    expect(configTarget("gitlab.example.test/platform/web/app")).toEqual({
      host: "gitlab.example.test",
      owner: "platform/web",
      name: "app",
    });
  });
});

describe("forge：经 RPC", () => {
  it("存配置：主机级与仓库级各是一条 procedure，令牌只在入参里", async () => {
    const config = {
      repoKey: "gitlab.example.test",
      forge: "gitlab",
      apiBase: "https://gitlab.example.test",
      credential: true,
      accountLogin: "bot",
      revision: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    ok(config);
    const saved = await putForgeConfig("gitlab.example.test", {
      forge: "gitlab",
      apiBase: "https://gitlab.example.test",
      token: "glpat-test",
      expectedRevision: 0,
    });
    expect(procedure()).toBe("forge/putHostConfig");
    expect(sent()).toEqual({
      host: "gitlab.example.test",
      forge: "gitlab",
      apiBase: "https://gitlab.example.test",
      token: "glpat-test",
      expectedRevision: 0,
    });
    // 答案里没有令牌。
    expect(JSON.stringify(saved)).not.toContain("glpat-test");

    calls = [];
    ok({ ...config, repoKey: "gitlab.example.test/platform/web/app" });
    await putForgeConfig("gitlab.example.test/platform/web/app", {
      forge: "gitlab",
      apiBase: "https://gitlab.example.test",
      expectedRevision: 1,
    });
    expect(procedure()).toBe("forge/putRepoConfig");
    expect(sent()).toMatchObject({
      host: "gitlab.example.test",
      owner: "platform/web",
      name: "app",
      expectedRevision: 1,
    });
  });

  it("列仓库（§29.7）：账号表，再按主机翻页，每行带克隆地址", async () => {
    ok({
      accounts: [{ host: "github.com", forge: "github", accountLogin: "octo" }],
    });
    expect(await forgeAccounts()).toEqual([
      { host: "github.com", forge: "github", accountLogin: "octo" },
    ]);
    expect(procedure()).toBe("forge/accounts");

    calls = [];
    const row = {
      host: "github.com",
      owner: "octo",
      name: "app",
      forge: "github",
      description: "",
      private: true,
      fork: false,
      archived: false,
      defaultBranch: "main",
      cloneUrl: "https://github.com/octo/app.git",
      sshUrl: "git@github.com:octo/app.git",
      webUrl: "https://github.com/octo/app",
      updatedAtMs: 1,
    };
    ok({ items: [row], nextCursor: "2" });
    const page = await forgeRepositories("github.com");
    expect(procedure()).toBe("forge/repositories");
    expect(sent()).toEqual({ host: "github.com" });
    expect(page).toEqual({ items: [row], nextCursor: "2" });

    calls = [];
    ok({ items: [], nextCursor: null });
    await forgeRepositories("github.com", "2", 50);
    expect(sent()).toEqual({ host: "github.com", cursor: "2", limit: 50 });
  });

  it("删配置带版本；列配置与识别", async () => {
    ok({ removed: true });
    await deleteForgeConfig("git.example.test/acme/app", 3);
    expect(procedure()).toBe("forge/removeRepoConfig");
    expect(sent()).toEqual({ ...REPO, expectedRevision: 3 });

    calls = [];
    ok({ removed: true });
    await deleteForgeConfig("git.example.test", 2);
    expect(procedure()).toBe("forge/removeHostConfig");
    expect(sent()).toEqual({ host: "git.example.test", expectedRevision: 2 });

    calls = [];
    ok({ configs: [] });
    expect(await forgeConfigs()).toEqual([]);
    expect(procedure()).toBe("forge/configs");

    calls = [];
    ok({
      repository: REPO,
      forge: "gitea",
      source: "config",
      configKey: "git.example.test",
      apiBase: "https://git.example.test/api/v1",
      webUrl: "https://git.example.test",
      credential: true,
      accountLogin: "bot",
    });
    const detected = await resolveForge("https://git.example.test/acme/app");
    expect(detected.forge).toBe("gitea");
    expect(procedure()).toBe("forge/resolve");
    expect(sent()).toEqual({ remoteUrl: "https://git.example.test/acme/app" });
  });

  it("列表带状态与游标，编号与合并方式按线上形状发", async () => {
    ok({ items: [], nextCursor: null });
    await forgeIssues(REPO, "all", "2");
    expect(procedure()).toBe("forge/issues");
    expect(sent()).toEqual({ ...REPO, state: "all", cursor: "2" });

    calls = [];
    ok({ merged: true, sha: SHA });
    await mergeForgePull(REPO, 7, { method: "squash", headSha: SHA });
    expect(procedure()).toBe("forge/merge");
    expect(sent()).toEqual({
      ...REPO,
      number: 7,
      method: "squash",
      headSha: SHA,
    });

    calls = [];
    ok({ merged: false, sha: null, train: true });
    await autoMergeForgePull(REPO, 7, { method: "merge", headSha: SHA });
    expect(procedure()).toBe("forge/autoMerge");

    calls = [];
    ok({ deleted: false, reasonCode: "BRANCH_MOVED" });
    expect(await deleteForgeBranch(REPO, 7, SHA)).toEqual({
      deleted: false,
      reasonCode: "BRANCH_MOVED",
    });
    expect(procedure()).toBe("forge/deleteBranch");
    expect(sent()).toEqual({ ...REPO, number: 7, headSha: SHA });
  });

  it("拒绝按码分档；没装托管平台域的 core 答 501", async () => {
    respond(409, { code: "forge_not_configured", message: "x" });
    const refused = await forgeIssues(REPO, "open").catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(RuntimeRequestError);
    expect(forgeFailure(refused)).toBe("notConfigured");

    respond(501, { code: "not_implemented", message: "x" });
    const missing = await forgeIssues(REPO, "open").catch(
      (error: unknown) => error,
    );
    expect(forgeFailure(missing)).toBe("unsupported");
  });

  it("搜索、排序与页码随列表入参发；空串不发，第 1 页的 page 也发（core 靠它走富查询拿计数）", async () => {
    ok({ items: [], nextCursor: null });
    await forgeIssues(REPO, "open", null, null, {
      q: "  label:core sync ",
      sort: "comments",
      direction: "asc",
      page: 3,
    });
    expect(sent()).toEqual({
      ...REPO,
      state: "open",
      q: "label:core sync",
      sort: "comments",
      direction: "asc",
      page: 3,
    });
    calls = [];
    ok({ items: [], nextCursor: null });
    await forgePulls(REPO, "open", null, null, { q: " ", page: 1 });
    expect(sent()).toEqual({ ...REPO, state: "open", page: 1 });
  });

  it("旧 core 不给新字段：列表与计数带缺省，新 core 给了照收", async () => {
    const base = {
      number: 1,
      title: "t",
      body: "",
      state: "open",
      draft: false,
      author: "a",
      baseRef: "main",
      headRef: "x",
      headSha: SHA,
      mergeable: "unknown",
      url: "",
      createdAtMs: 1,
      updatedAtMs: 1,
      mergedAtMs: null,
    };
    ok({ items: [base], nextCursor: null });
    const old = await forgePulls(REPO, "open");
    expect(old.totalCount).toBeNull();
    expect(old.pageCount).toBeNull();
    expect(old.unsupported).toEqual([]);
    expect(old.items[0]).toMatchObject({
      labels: [],
      assignees: [],
      commentCount: 0,
      reviewDecision: null,
      checks: null,
      linkedIssues: [],
    });
    ok({
      items: [
        {
          ...base,
          reviewDecision: "changesRequested",
          checks: { rollup: "failure", passed: 5, total: 7 },
          commentCount: 2,
        },
      ],
      nextCursor: null,
      totalCount: 458,
      openCount: 23,
      closedCount: 435,
      page: 2,
      pageCount: 16,
      unsupported: ["review:approved"],
    });
    const fresh = await forgePulls(REPO, "open");
    expect(fresh).toMatchObject({
      openCount: 23,
      page: 2,
      pageCount: 16,
      unsupported: ["review:approved"],
    });
    expect(fresh.items[0]?.checks).toEqual({
      rollup: "failure",
      passed: 5,
      total: 7,
    });
  });

  it("审查者、提交与筛选候选各一条路由", async () => {
    ok({ reviewers: [{ login: "o", state: "approved", submittedAtMs: null }] });
    expect(await forgePullReviewers(REPO, 4)).toHaveLength(1);
    expect(procedure()).toBe("forge/pullReviewers");
    expect(sent()).toEqual({ ...REPO, number: 4 });
    calls = [];
    ok({ commits: [] });
    await forgePullCommits(REPO, 4);
    expect(procedure()).toBe("forge/pullCommits");
    calls = [];
    ok({});
    expect(await forgeFacets(REPO, "ws-1")).toEqual({
      labels: [],
      milestones: [],
      assignees: [],
    });
    expect(procedure()).toBe("forge/facets");
    expect(sent()).toEqual({ ...REPO, workspaceId: "ws-1" });
  });
});
