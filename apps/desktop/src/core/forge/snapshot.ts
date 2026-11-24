import type { PullChecks, PullReview } from "@armadra/shared";
import type {
  Forge,
  ForgeRepo,
  ForgePullSnapshot,
  ForgeReviewer,
  ForgeChecks,
  ForgePull,
} from "./types";

/** 快照里最多留几个失败的检查名。 */
export const MAX_FAILING = 3;

/** 检查读数 → 快照的检查字段；`headSha` 为空算没读到有用的东西。 */
export function checksOf(summary: ForgeChecks): PullChecks {
  return {
    read: true,
    headSha: summary.headSha,
    rollup: summary.rollup,
    failing: summary.checks
      .filter((check) => check.state === "failure")
      .map((check) => check.name)
      .slice(0, MAX_FAILING),
  };
}

/**
 * 没有平台自己的 `pullSnapshot` 时的评审结论：官方没给「无需评审」的凭据，所以
 * 只会是 `approved`、`changesRequested`、`unknown`。
 */
export function reviewFrom(
  decision: ForgePull["reviewDecision"],
  reviewers: readonly ForgeReviewer[] | null,
): PullReview {
  if (decision !== null) return decision;
  if (reviewers === null) return "unknown";
  if (reviewers.some((reviewer) => reviewer.state === "changesRequested")) {
    return "changesRequested";
  }
  if (reviewers.some((reviewer) => reviewer.state === "approved")) {
    return "approved";
  }
  return "unknown";
}

/** 读一个 PR 的快照：平台有 `pullSnapshot` 就用它，否则用三个旧读取拼。 */
export async function snapshotOf(
  remote: Forge,
  repo: ForgeRepo,
  number: number,
): Promise<ForgePullSnapshot> {
  if (remote.pullSnapshot !== undefined) {
    return remote.pullSnapshot(repo, number);
  }
  const pull = await remote.getPull(repo, number);
  let checks: PullChecks = { read: false };
  if (pull.state === "open") {
    try {
      checks = checksOf(await remote.checks(repo, number));
    } catch {
      checks = { read: false };
    }
  }
  let reviewers: readonly ForgeReviewer[] | null = null;
  try {
    reviewers = await remote.pullReviewers(repo, number);
  } catch {
    reviewers = null;
  }
  return {
    number: pull.number,
    url: pull.url,
    title: pull.title,
    state: pull.state,
    draft: pull.draft,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    headSha: pull.headSha,
    fromFork: pull.fromFork,
    review: reviewFrom(pull.reviewDecision, reviewers),
    checks,
    mergeable: pull.mergeable,
    parent: { kind: "unknown" },
  };
}
