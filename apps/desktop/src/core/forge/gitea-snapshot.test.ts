import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FAKE_GITEA,
  type FakeGitea,
  type FakePull,
  startFakeGitea,
} from "./fake-gitea.fixture";
import { GiteaForge } from "./gitea";

const REPO = {
  host: "127.0.0.1",
  owner: FAKE_GITEA.owner,
  name: FAKE_GITEA.repo,
};
const SHA = "a".repeat(40);

let fake: FakeGitea;
let forge: GiteaForge;

function pull(extra: Partial<FakePull> = {}): FakePull {
  const value: FakePull = {
    number: 5,
    title: "feature",
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
  };
  fake.pulls.push(value);
  return value;
}

beforeEach(async () => {
  fake = await startFakeGitea();
  fake.branches.set("main", {
    sha: "0".repeat(40),
    protected: true,
    requiredApprovals: 1,
  });
  forge = new GiteaForge({
    apiBase: fake.apiBase,
    token: async () => FAKE_GITEA.token,
  });
});
afterEach(async () => {
  await fake.close();
});

describe("GiteaForge.pullSnapshot review", () => {
  it("unprotected base or zero required approvals is notRequired", async () => {
    pull();
    fake.branches.set("main", { sha: "0".repeat(40), protected: false });
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("notRequired");
    fake.branches.set("main", {
      sha: "0".repeat(40),
      protected: true,
      requiredApprovals: 0,
    });
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("notRequired");
  });

  it("counts official approvals against the requirement", async () => {
    pull();
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("reviewRequired");
    fake.addReview(5, "carol", "COMMENT");
    fake.addReview(5, "dave", "APPROVED", { official: false });
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("reviewRequired");
    fake.addReview(5, "erin", "APPROVED");
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("approved");
  });

  it("an official REQUEST_CHANGES wins until the reviewer approves or it is dismissed", async () => {
    pull();
    fake.addReview(5, "erin", "REQUEST_CHANGES");
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("changesRequested");
    fake.addReview(5, "erin", "APPROVED");
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("approved");
    fake.addReview(5, "frank", "REQUEST_CHANGES", { dismissed: true });
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("approved");
  });

  it("unprotected base still reports changesRequested", async () => {
    pull();
    fake.branches.set("main", { sha: "0".repeat(40), protected: false });
    fake.addReview(5, "erin", "REQUEST_CHANGES");
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("changesRequested");
  });

  it("protected branch without required_approvals (older server) or unreadable branch is unknown", async () => {
    pull();
    fake.branches.set("main", { sha: "0".repeat(40), protected: true });
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("unknown");
    fake.branches.delete("main");
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("unknown");
  });

  it("unreadable reviews are unknown", async () => {
    pull();
    fake.failNext("GET", /\/reviews/, 403);
    expect((await forge.pullSnapshot(REPO, 5)).review).toBe("unknown");
  });
});

describe("GiteaForge.pullSnapshot checks and mergeable", () => {
  it("maps statuses and reads none as read", async () => {
    pull();
    expect((await forge.pullSnapshot(REPO, 5)).checks).toEqual({
      read: true,
      headSha: SHA,
      rollup: "none",
      failing: [],
    });
    fake.setStatus(SHA, "ci/build", "failure");
    fake.setStatus(SHA, "ci/lint", "success");
    expect((await forge.pullSnapshot(REPO, 5)).checks).toEqual({
      read: true,
      headSha: SHA,
      rollup: "failure",
      failing: ["ci/build"],
    });
    fake.setStatus(SHA, "ci/build", "pending");
    expect((await forge.pullSnapshot(REPO, 5)).checks).toMatchObject({
      rollup: "pending",
    });
  });

  it("status failure is read:false", async () => {
    pull();
    fake.failNext("GET", /\/status$/, 403);
    expect((await forge.pullSnapshot(REPO, 5)).checks).toEqual({ read: false });
  });

  it("mergeable false needs two consecutive reads on the same head", async () => {
    const p = pull({ mergeable: false });
    expect((await forge.pullSnapshot(REPO, 5)).mergeable).toBe("unknown");
    expect((await forge.pullSnapshot(REPO, 5)).mergeable).toBe("conflicting");
    p.mergeable = true;
    expect((await forge.pullSnapshot(REPO, 5)).mergeable).toBe("mergeable");
    p.mergeable = false;
    expect((await forge.pullSnapshot(REPO, 5)).mergeable).toBe("unknown");
    p.sha = "b".repeat(40);
    expect((await forge.pullSnapshot(REPO, 5)).mergeable).toBe("unknown");
  });
});

describe("GiteaForge.pullSnapshot parent", () => {
  it("is none on the default branch without extra reads", async () => {
    pull();
    expect((await forge.pullSnapshot(REPO, 5)).parent).toEqual({
      kind: "none",
    });
  });

  it("finds an open parent through the exact route", async () => {
    pull({ number: 4, head: "feat/base", base: "main", sha: "c".repeat(40) });
    pull({ number: 5, head: "feat/top", base: "feat/base" });
    const snap = await forge.pullSnapshot(REPO, 5);
    expect(snap.parent).toMatchObject({ kind: "open", number: 4 });
    expect(
      fake.requests.some(
        (r) =>
          r.path.includes("/pulls/main/feat%2Fbase") ||
          r.path.includes("/pulls/main/feat/base"),
      ),
    ).toBe(true);
  });

  it("falls back to scanning open pulls when the exact route is missing", async () => {
    // Parent targets another branch, so the exact route cannot find it.
    pull({
      number: 4,
      head: "feat/base",
      base: "release",
      sha: "c".repeat(40),
    });
    pull({ number: 5, head: "feat/top", base: "feat/base" });
    expect((await forge.pullSnapshot(REPO, 5)).parent).toMatchObject({
      kind: "open",
      number: 4,
    });
  });

  it("is none when no open pull has that head, and unknown when listing fails", async () => {
    pull({ number: 5, head: "feat/top", base: "feat/base" });
    expect((await forge.pullSnapshot(REPO, 5)).parent).toEqual({
      kind: "none",
    });
    fake.failNext("GET", /\/pulls$/, 403);
    expect((await forge.pullSnapshot(REPO, 5)).parent).toEqual({
      kind: "unknown",
    });
  });

  it("a merged pull skips every secondary read", async () => {
    pull({ state: "closed", merged: true });
    fake.requests.length = 0;
    expect(await forge.pullSnapshot(REPO, 5)).toMatchObject({
      state: "merged",
      review: "unknown",
      checks: { read: false },
      parent: { kind: "none" },
    });
    expect(fake.requests).toHaveLength(1);
  });
});
