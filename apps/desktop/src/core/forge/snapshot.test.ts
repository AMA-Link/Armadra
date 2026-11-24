import { describe, expect, it } from "vitest";
import { GithubForge, hostGithubAccess } from "./github";
import { mockFetch, type Reply } from "./mock-fetch.fixture";
import { snapshotOf } from "./snapshot";
import type { Forge, ForgeRepo } from "./types";

const REPO: ForgeRepo = { host: "github.com", owner: "acme", name: "app" };

function node(extra: Record<string, unknown> = {}) {
  return {
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "t",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    baseRefName: "main",
    headRefName: "feat/x",
    headRefOid: "a".repeat(40),
    isCrossRepository: false,
    latestOpinionatedReviews: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
          },
        },
      ],
    },
    ...extra,
  };
}

function github(
  pr: unknown,
  options: {
    graphql?: (query: string) => Reply | undefined;
    rest?: Reply;
  } = {},
) {
  const mock = mockFetch((request) => {
    if (request.path === "/graphql") {
      const query = String((request.body as { query: string }).query);
      if (options.graphql !== undefined) {
        const reply = options.graphql(query);
        if (reply !== undefined) return reply;
      }
      if (query.includes("pullRequests(headRefName")) {
        return {
          body: { data: { repository: { pullRequests: { nodes: [] } } } },
        };
      }
      return {
        body: {
          data: { repository: { defaultBranchRef: { name: "main" }, pr } },
        },
      };
    }
    return options.rest;
  });
  return {
    forge: new GithubForge(
      hostGithubAccess("https://api.github.com", async () => "ghp_test", {
        fetch: mock.fetch,
        attempts: 1,
      }),
    ),
    requests: mock.requests,
  };
}

describe("GithubForge.pullSnapshot", () => {
  const reviews: [string, unknown, string][] = [
    ["APPROVED", [], "approved"],
    ["CHANGES_REQUESTED", [], "changesRequested"],
    ["REVIEW_REQUIRED", [], "reviewRequired"],
    [null as unknown as string, [], "notRequired"],
    [
      null as unknown as string,
      [{ state: "CHANGES_REQUESTED" }],
      "changesRequested",
    ],
  ];
  it.each(reviews)(
    "reviewDecision %s -> %s",
    async (decision, nodes, expected) => {
      const { forge } = github(
        node({ reviewDecision: decision, latestOpinionatedReviews: { nodes } }),
      );
      expect((await forge.pullSnapshot(REPO, 7)).review).toBe(expected);
    },
  );

  it("maps checks: success, failure with names, none, pending", async () => {
    const failing = node({
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "build",
                      conclusion: "FAILURE",
                    },
                    {
                      __typename: "CheckRun",
                      name: "lint",
                      conclusion: "SUCCESS",
                    },
                    {
                      __typename: "StatusContext",
                      context: "ci/x",
                      state: "ERROR",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    });
    const a = await github(failing).forge.pullSnapshot(REPO, 7);
    expect(a.checks).toEqual({
      read: true,
      headSha: "a".repeat(40),
      rollup: "failure",
      failing: ["build", "ci/x"],
    });
    const none = node({
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    });
    expect(
      (await github(none).forge.pullSnapshot(REPO, 7)).checks,
    ).toMatchObject({
      read: true,
      rollup: "none",
    });
    const pending = node({
      commits: {
        nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }],
      },
    });
    expect(
      (await github(pending).forge.pullSnapshot(REPO, 7)).checks,
    ).toMatchObject({
      rollup: "pending",
    });
  });

  it("maps state, draft, fork and mergeable", async () => {
    const { forge } = github(
      node({
        state: "MERGED",
        isDraft: true,
        isCrossRepository: true,
        mergeable: "CONFLICTING",
      }),
    );
    expect(await forge.pullSnapshot(REPO, 7)).toMatchObject({
      state: "merged",
      draft: true,
      fromFork: true,
      mergeable: "conflicting",
      parent: { kind: "none" },
    });
  });

  it("finds an open parent only when base is not the default branch", async () => {
    const stacked = node({ baseRefName: "feat/base" });
    const found = github(stacked, {
      graphql: (query) =>
        query.includes("pullRequests(headRefName")
          ? {
              body: {
                data: {
                  repository: {
                    pullRequests: {
                      nodes: [{ number: 5, url: "https://x/5" }],
                    },
                  },
                },
              },
            }
          : undefined,
    });
    expect((await found.forge.pullSnapshot(REPO, 7)).parent).toEqual({
      kind: "open",
      number: 5,
      url: "https://x/5",
    });
    const none = github(stacked);
    expect((await none.forge.pullSnapshot(REPO, 7)).parent).toEqual({
      kind: "none",
    });
    const failed = github(stacked, {
      graphql: (query) =>
        query.includes("pullRequests(headRefName")
          ? { status: 502, body: {} }
          : undefined,
    });
    expect((await failed.forge.pullSnapshot(REPO, 7)).parent).toEqual({
      kind: "unknown",
    });
    const plain = github(node());
    await plain.forge.pullSnapshot(REPO, 7);
    expect(plain.requests.filter((r) => r.path === "/graphql")).toHaveLength(1);
  });

  it("falls back to REST with unknown review and unread checks when GraphQL fails", async () => {
    const { forge } = github(undefined, {
      graphql: () => ({ status: 502, body: {} }),
      rest: {
        body: {
          number: 7,
          title: "t",
          state: "open",
          merged: false,
          draft: false,
          html_url: "https://github.com/acme/app/pull/7",
          head: {
            ref: "feat/x",
            sha: "b".repeat(40),
            repo: { full_name: "acme/app" },
          },
          base: { ref: "main", repo: { full_name: "acme/app" } },
          created_at: "2026-11-01T00:00:00Z",
          updated_at: "2026-11-01T00:00:00Z",
        },
      },
    });
    expect(await forge.pullSnapshot(REPO, 7)).toMatchObject({
      state: "open",
      review: "unknown",
      checks: { read: false },
      parent: { kind: "unknown" },
    });
  });
});

describe("snapshotOf fallback", () => {
  const pull = {
    number: 3,
    title: "t",
    state: "open",
    draft: false,
    baseRef: "main",
    headRef: "h",
    headSha: "c".repeat(40),
    mergeable: "unknown",
    url: "u",
    fromFork: false,
    reviewDecision: null,
  };
  const fake = (reviewers: unknown, checks: unknown): Forge =>
    ({
      getPull: async () => pull,
      checks: async () => {
        if (checks === "fail") throw new Error("x");
        return checks;
      },
      pullReviewers: async () => {
        if (reviewers === "fail") throw new Error("x");
        return reviewers;
      },
    }) as unknown as Forge;

  it("never claims notRequired", async () => {
    const snap = await snapshotOf(
      fake([], { headSha: "c", rollup: "success", checks: [] }),
      REPO,
      3,
    );
    expect(snap.review).toBe("unknown");
    expect(snap.checks).toMatchObject({ read: true, rollup: "success" });
  });
  it("derives review from reviewers and tolerates failures", async () => {
    const approved = await snapshotOf(
      fake([{ state: "approved" }], "fail"),
      REPO,
      3,
    );
    expect(approved.review).toBe("approved");
    expect(approved.checks).toEqual({ read: false });
    const changes = await snapshotOf(
      fake([{ state: "approved" }, { state: "changesRequested" }], "fail"),
      REPO,
      3,
    );
    expect(changes.review).toBe("changesRequested");
    expect((await snapshotOf(fake("fail", "fail"), REPO, 3)).review).toBe(
      "unknown",
    );
  });
  it("prefers the platform's own method", async () => {
    const own = { number: 1 } as never;
    const forge = { pullSnapshot: async () => own } as unknown as Forge;
    expect(await snapshotOf(forge, REPO, 1)).toBe(own);
  });
});
