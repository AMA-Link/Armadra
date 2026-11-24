import { describe, expect, it } from "vitest";
import { pullSnapshotSchema, type PullSnapshot } from "./pulls.js";

const base: PullSnapshot = {
  repo: "github.com/acme/app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  title: "t",
  state: "open",
  draft: false,
  baseRef: "main",
  headRef: "feat/x",
  headSha: "abc",
  fromFork: false,
  review: "notRequired",
  checks: { read: true, headSha: "abc", rollup: "success", failing: [] },
  mergeable: "mergeable",
  parent: { kind: "none" },
  fetchedAtMs: 1,
  stale: false,
};

describe("pullSnapshotSchema", () => {
  it("accepts every checks and parent variant", () => {
    expect(pullSnapshotSchema.parse(base)).toEqual(base);
    expect(
      pullSnapshotSchema.parse({ ...base, checks: { read: false } }).checks,
    ).toEqual({ read: false });
    const open = { kind: "open", number: 3, url: "u" } as const;
    expect(pullSnapshotSchema.parse({ ...base, parent: open }).parent).toEqual(
      open,
    );
    expect(
      pullSnapshotSchema.parse({ ...base, parent: { kind: "unknown" } }).parent
        .kind,
    ).toBe("unknown");
  });
  it("rejects more than three failing names and unknown reviews", () => {
    const failing = ["a", "b", "c", "d"];
    expect(
      pullSnapshotSchema.safeParse({
        ...base,
        checks: { read: true, headSha: "a", rollup: "failure", failing },
      }).success,
    ).toBe(false);
    expect(
      pullSnapshotSchema.safeParse({ ...base, review: "maybe" }).success,
    ).toBe(false);
  });
});
