import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FAKE_GITEA,
  type FakeGitea,
  type FakePull,
  startFakeGitea,
} from "./fake-gitea.fixture";
import { GiteaForge } from "./gitea";
import { GithubForge, hostGithubAccess } from "./github";
import { GitlabForge } from "./gitlab";
import { mockFetch } from "./mock-fetch.fixture";

const SHA = "a".repeat(40);

describe("GithubForge.pullsByHead", () => {
  it("asks for open pulls with owner:ref and maps them", async () => {
    const mock = mockFetch((request) =>
      request.path === "/repos/acme/app/pulls"
        ? {
            body: [
              {
                number: 4,
                title: "t",
                state: "open",
                head: {
                  ref: "feat/x",
                  sha: SHA,
                  repo: { full_name: "me/app" },
                },
                base: { ref: "main" },
                html_url: "https://github.com/acme/app/pull/4",
              },
            ],
          }
        : undefined,
    );
    const forge = new GithubForge(
      hostGithubAccess("https://api.github.com", async () => "t", {
        fetch: mock.fetch,
        attempts: 1,
      }),
    );
    const found = await forge.pullsByHead(
      { host: "github.com", owner: "acme", name: "app" },
      { owner: "me", ref: "feat/x" },
    );
    expect(found.map((pull) => pull.number)).toEqual([4]);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.query.get("head")).toBe("me:feat/x");
    expect(mock.requests[0]?.query.get("state")).toBe("open");
  });
});

describe("GitlabForge.pullsByHead", () => {
  const REPO = { host: "gitlab.example.test", owner: "acme", name: "app" };
  function setup(projectId: number | "missing") {
    const requests: string[] = [];
    const fetch = (async (input: unknown) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname).replace(
        "/api/v4/projects/",
        "",
      );
      requests.push(path + url.search);
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (path === "acme/app/merge_requests") {
        return json([
          {
            iid: 1,
            title: "own",
            state: "opened",
            source_branch: "f",
            target_branch: "main",
            sha: SHA,
            source_project_id: 10,
            target_project_id: 10,
            web_url: "https://gitlab.example.test/acme/app/-/merge_requests/1",
          },
          {
            iid: 2,
            title: "fork",
            state: "opened",
            source_branch: "f",
            target_branch: "main",
            sha: SHA,
            source_project_id: 20,
            target_project_id: 10,
            web_url: "https://gitlab.example.test/acme/app/-/merge_requests/2",
          },
        ]);
      }
      if (path === "me/app") {
        return projectId === "missing"
          ? json({}, 404)
          : json({ id: projectId });
      }
      return json({}, 599);
    }) as typeof globalThis.fetch;
    return {
      requests,
      forge: new GitlabForge({
        apiBase: "https://gitlab.example.test/api/v4",
        token: async () => "glpat-x",
        fetch,
      }),
    };
  }

  it("same project keeps only non-fork merge requests", async () => {
    const { forge, requests } = setup(20);
    const found = await forge.pullsByHead(REPO, { owner: "acme", ref: "f" });
    expect(found.map((pull) => pull.number)).toEqual([1]);
    expect(requests[0]).toContain("source_branch=f");
    expect(requests[0]).toContain("state=opened");
  });

  it("a fork head is matched by its project id", async () => {
    const { forge } = setup(20);
    const found = await forge.pullsByHead(REPO, { owner: "me", ref: "f" });
    expect(found.map((pull) => pull.number)).toEqual([2]);
  });

  it("an unreadable fork project finds nothing", async () => {
    const { forge } = setup("missing");
    expect(await forge.pullsByHead(REPO, { owner: "me", ref: "f" })).toEqual(
      [],
    );
  });
});

describe("GiteaForge.pullsByHead", () => {
  const REPO = {
    host: "127.0.0.1",
    owner: FAKE_GITEA.owner,
    name: FAKE_GITEA.repo,
  };
  let fake: FakeGitea;
  let forge: GiteaForge;
  function add(extra: Partial<FakePull>): void {
    fake.pulls.push({
      number: 1,
      title: "t",
      body: "",
      state: "open",
      merged: false,
      mergeable: true,
      head: "feature",
      base: "main",
      sha: SHA,
      files: [],
      diff: "",
      ...extra,
    });
  }
  beforeEach(async () => {
    fake = await startFakeGitea();
    forge = new GiteaForge({
      apiBase: fake.apiBase,
      token: async () => FAKE_GITEA.token,
    });
  });
  afterEach(async () => {
    await fake.close();
  });

  it("finds a same-repo head through the exact route", async () => {
    add({});
    const found = await forge.pullsByHead(REPO, {
      owner: FAKE_GITEA.owner,
      ref: "feature",
    });
    expect(found.map((pull) => pull.number)).toEqual([1]);
  });

  it("falls back to the open list and tells forks apart by head repo", async () => {
    add({ number: 1, base: "release" });
    add({ number: 2, base: "release", fork: true });
    const own = await forge.pullsByHead(REPO, {
      owner: FAKE_GITEA.owner,
      ref: "feature",
    });
    expect(own.map((pull) => pull.number)).toEqual([1]);
    const fork = await forge.pullsByHead(REPO, {
      owner: "forker",
      ref: "feature",
    });
    expect(fork.map((pull) => pull.number)).toEqual([2]);
  });

  it("ignores closed pulls and unknown heads", async () => {
    add({ state: "closed" });
    expect(
      await forge.pullsByHead(REPO, {
        owner: FAKE_GITEA.owner,
        ref: "feature",
      }),
    ).toEqual([]);
  });
});
