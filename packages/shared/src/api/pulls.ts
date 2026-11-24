import { z } from "zod";

/**
 * PR snapshot (contract §delivery): one stored, platform-neutral reading of a
 * pull request — state, review decision, checks, mergeability and the open
 * parent PR it is stacked on. Never carries the PR body or comment text.
 */

export const PULL_REVIEWS = [
  "approved",
  "changesRequested",
  "reviewRequired",
  "notRequired",
  "unknown",
] as const;
export const pullReviewSchema = z.enum(PULL_REVIEWS);
export type PullReview = (typeof PULL_REVIEWS)[number];

export const PULL_ROLLUPS = [
  "pending",
  "success",
  "failure",
  "neutral",
  "none",
] as const;

export const pullChecksSchema = z.discriminatedUnion("read", [
  z.object({
    read: z.literal(true),
    headSha: z.string(),
    rollup: z.enum(PULL_ROLLUPS),
    /** At most three failing check names. */
    failing: z.array(z.string()).max(3),
  }),
  z.object({ read: z.literal(false) }),
]);
export type PullChecks =
  | {
      readonly read: true;
      readonly headSha: string;
      readonly rollup: (typeof PULL_ROLLUPS)[number];
      readonly failing: readonly string[];
    }
  | { readonly read: false };

export const pullParentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("open"),
    number: z.number().int(),
    url: z.string(),
  }),
  z.object({ kind: z.literal("unknown") }),
]);
export type PullParent =
  | { readonly kind: "none" }
  | { readonly kind: "open"; readonly number: number; readonly url: string }
  | { readonly kind: "unknown" };

export const pullSnapshotSchema = z.object({
  /** `<host>/<owner>/<name>`, same spelling as a thread key. */
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  draft: z.boolean(),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  fromFork: z.boolean(),
  review: pullReviewSchema,
  checks: pullChecksSchema,
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  parent: pullParentSchema,
  fetchedAtMs: z.number(),
  /** Computed on read, never stored. */
  stale: z.boolean(),
});
export interface PullSnapshot {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: "open" | "merged" | "closed";
  readonly draft: boolean;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly fromFork: boolean;
  readonly review: PullReview;
  readonly checks: PullChecks;
  readonly mergeable: "mergeable" | "conflicting" | "unknown";
  readonly parent: PullParent;
  readonly fetchedAtMs: number;
  readonly stale: boolean;
}
