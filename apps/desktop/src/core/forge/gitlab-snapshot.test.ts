import { describe, expect, it } from "vitest";
import { GitlabForge } from "./gitlab";

const SHA = "3f2a9c1d7e5b4a6f8c0d2e4f6a8b0c1d2e3f4a5b";
const REPO = { host: "gitlab.example.test", owner: "acme", name: "app" };

interface Setup {
  mr?: Record<string, unknown>;
  approvals?: unknown | number;
  statuses?: unknown | number;
  project?: unknown | number;
  parents?: unknown | number;
}

function forge(setup: Setup) {
  const requests: string[] = [];
  const reply = (value: unknown) =>
    typeof value === "number"
      ? new Response("{}", { status: value })
      : new Response(JSON.stringify(value), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  const fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname).replace(
      "/api/v4/projects/acme/app",
      "",
    );
    requests.push(path + url.search);
    if (path === "/merge_requests/7") {
      return reply({
        iid: 7,
        title: "t",
        state: "opened",
        sha: SHA,
        source_branch: "feat/x",
        target_branch: "main",
        web_url: "https://gitlab.example.test/acme/app/-/merge_requests/7",
        detailed_merge_status: "mergeable",
        source_project_id: 1,
        target_project_id: 1,
        ...setup.mr,
      });
    }
    if (path === "/merge_requests/7/approvals")
      return reply(setup.approvals ?? 404);
    if (path === `/repository/commits/${SHA}/statuses`) {
      return reply(setup.statuses ?? []);
    }
    if (path === "") return reply(setup.project ?? { default_branch: "main" });
    if (path === "/merge_requests") return reply(setup.parents ?? []);
    return new Response("{}", { status: 599 });
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

describe("GitlabForge.pullSnapshot review", () => {
  const cases: [string, Setup, string][] = [
    [
      "requested_changes",
      { mr: { detailed_merge_status: "requested_changes" } },
      "changesRequested",
    ],
    [
      "approved",
      {
        approvals: {
          approvals_left: 0,
          approvals_required: 1,
          approved_by: [{ user: {} }],
        },
      },
      "approved",
    ],
    [
      "none required",
      {
        approvals: {
          approvals_left: 0,
          approvals_required: 0,
          approved_by: [],
        },
      },
      "notRequired",
    ],
    [
      "left > 0",
      {
        approvals: {
          approvals_left: 1,
          approvals_required: 1,
          approved_by: [],
        },
      },
      "reviewRequired",
    ],
    [
      "not_approved without approvals",
      { mr: { detailed_merge_status: "not_approved" } },
      "reviewRequired",
    ],
    ["approvals 404", {}, "unknown"],
    ["approvals 403", { approvals: 403 }, "unknown"],
    ["fields missing", { approvals: {} }, "unknown"],
  ];
  it.each(cases)("%s", async (_name, setup, expected) => {
    expect((await forge(setup).forge.pullSnapshot(REPO, 7)).review).toBe(
      expected,
    );
  });
});

describe("GitlabForge.pullSnapshot checks, mergeable, parent", () => {
  it("maps statuses, names failing ones, and reads none as read", async () => {
    const failing = await forge({
      statuses: [
        { id: 1, name: "build", status: "failed" },
        { id: 2, name: "lint", status: "success" },
      ],
    }).forge.pullSnapshot(REPO, 7);
    expect(failing.checks).toEqual({
      read: true,
      headSha: SHA,
      rollup: "failure",
      failing: ["build"],
    });
    expect((await forge({}).forge.pullSnapshot(REPO, 7)).checks).toMatchObject({
      read: true,
      rollup: "none",
    });
    const pending = await forge({
      statuses: [{ id: 1, name: "b", status: "running" }],
    }).forge.pullSnapshot(REPO, 7);
    expect(pending.checks).toMatchObject({ rollup: "pending" });
  });

  it("reports read:false when statuses fail", async () => {
    expect(
      (await forge({ statuses: 500 }).forge.pullSnapshot(REPO, 7)).checks,
    ).toEqual({ read: false });
  });

  it.each([
    ["mergeable", { detailed_merge_status: "mergeable" }, "mergeable"],
    ["conflict", { detailed_merge_status: "conflict" }, "conflicting"],
    ["checking", { detailed_merge_status: "checking" }, "unknown"],
  ])("mergeable %s", async (_n, mr, expected) => {
    expect((await forge({ mr }).forge.pullSnapshot(REPO, 7)).mergeable).toBe(
      expected,
    );
  });

  it("asks for a parent only when base is not the default branch", async () => {
    const plain = forge({});
    expect((await plain.forge.pullSnapshot(REPO, 7)).parent).toEqual({
      kind: "none",
    });
    expect(plain.requests.some((r) => r.startsWith("/merge_requests?"))).toBe(
      false,
    );
    const stacked = forge({
      mr: { target_branch: "feat/base" },
      parents: [{ iid: 5, web_url: "https://x/5" }],
    });
    expect((await stacked.forge.pullSnapshot(REPO, 7)).parent).toEqual({
      kind: "open",
      number: 5,
      url: "https://x/5",
    });
    expect(
      stacked.requests.find((r) => r.startsWith("/merge_requests?")),
    ).toContain("source_branch=feat%2Fbase");
    expect(
      (
        await forge({ mr: { target_branch: "feat/base" } }).forge.pullSnapshot(
          REPO,
          7,
        )
      ).parent,
    ).toEqual({ kind: "none" });
    expect(
      (
        await forge({
          mr: { target_branch: "feat/base" },
          parents: 500,
        }).forge.pullSnapshot(REPO, 7)
      ).parent,
    ).toEqual({ kind: "unknown" });
  });

  it("caches the default branch per repository", async () => {
    const f = forge({ mr: { target_branch: "feat/base" } });
    await f.forge.pullSnapshot(REPO, 7);
    await f.forge.pullSnapshot(REPO, 7);
    expect(f.requests.filter((r) => r === "")).toHaveLength(1);
  });

  it("skips reads for a merged MR", async () => {
    const f = forge({
      mr: { state: "merged", merged_at: "2026-11-01T00:00:00Z" },
    });
    expect(await f.forge.pullSnapshot(REPO, 7)).toMatchObject({
      state: "merged",
      parent: { kind: "none" },
      checks: { read: false },
    });
    expect(f.requests).toEqual(["/merge_requests/7"]);
  });
});
