import type { PullReview } from "@armadra/shared";
import type { ForgeMergeable, ForgePull } from "./types";

/** Gitea 快照的纯判定（契约 §115.2）。 */

interface ReviewLike {
  readonly user?: { readonly login?: string } | null;
  readonly state?: string;
  readonly dismissed?: boolean;
  readonly official?: boolean;
}

interface BranchLike {
  readonly protected?: boolean;
  readonly required_approvals?: number;
}

/**
 * 评审结论。`reviews` 读不到是 `undefined`。官方、未撤销的最新「要求修改」优先；
 * 没有 `branch`（还没读 base 分支）且没有要求修改时答 `"pending"`，让调用方去读。
 */
export function reviewVerdict(
  reviews: readonly ReviewLike[] | undefined,
  branch: BranchLike | undefined,
): PullReview | "pending" {
  if (reviews === undefined) return "unknown";
  const latest = new Map<string, string>();
  for (const value of reviews) {
    const who = value.user?.login;
    if (who === undefined || who === "") continue;
    if (value.dismissed === true || value.official === false) continue;
    if (value.state === "APPROVED" || value.state === "REQUEST_CHANGES") {
      latest.set(who, value.state);
    }
  }
  const states = [...latest.values()];
  if (states.includes("REQUEST_CHANGES")) return "changesRequested";
  if (branch === undefined) return "pending";
  if (branch.protected === false) return "notRequired";
  const required = branch.required_approvals;
  if (typeof required !== "number") return "unknown";
  if (required === 0) return "notRequired";
  return states.filter((state) => state === "APPROVED").length >= required
    ? "approved"
    : "reviewRequired";
}

/**
 * Gitea 的 `mergeable: false` 分不出冲突与「还在算」：同一个 head 连续两次读到
 * 才记 `conflicting`，第一次记 `unknown`。按 API 根、仓库与编号记在进程里，Forge
 * 实例被重建也不丢。`pull` 为 `undefined`（已不是开着的）时清掉记录。
 */
const FALSE_ONCE = new Map<string, string>();
const MAX_FALSE_ONCE = 2000;

export function settleMergeable(
  key: string,
  pull: Pick<ForgePull, "mergeable" | "headSha"> | undefined,
): ForgeMergeable {
  if (pull === undefined || pull.mergeable !== "conflicting") {
    FALSE_ONCE.delete(key);
    return pull?.mergeable ?? "unknown";
  }
  if (FALSE_ONCE.get(key) === pull.headSha) return "conflicting";
  if (FALSE_ONCE.size >= MAX_FALSE_ONCE) FALSE_ONCE.clear();
  FALSE_ONCE.set(key, pull.headSha);
  return "unknown";
}
