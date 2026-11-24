import type { PullChecks, PullParent, PullReview } from "@armadra/shared";
import { MAX_FAILING } from "./snapshot";
import type { ForgePullSnapshot } from "./types";

/**
 * GitHub 的 PR 快照（契约 §115）：一次 GraphQL 读状态、评审结论、检查与可合并性；
 * 只有 base 不是默认分支时才再问一次「谁的 head 是这个 base」来找父 PR。
 */

export const SNAPSHOT_DOCUMENT = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pr: pullRequest(number: $number) {
      number url title state isDraft mergeable reviewDecision
      baseRefName headRefName headRefOid isCrossRepository
      latestOpinionatedReviews(first: 20) { nodes { state } }
      commits(last: 1) { nodes { commit { statusCheckRollup {
        state
        contexts(first: 50) { nodes {
          __typename
          ... on CheckRun { name conclusion }
          ... on StatusContext { context state }
        } }
      } } } }
    }
  }
}`;

export const PARENT_DOCUMENT = `query($owner: String!, $name: String!, $base: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $base, states: OPEN, first: 1) {
      nodes { number url isCrossRepository }
    }
  }
}`;

interface ContextNode {
  __typename?: string;
  name?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
}

export interface SnapshotNode {
  number?: number;
  url?: string;
  title?: string;
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  reviewDecision?: string | null;
  baseRefName?: string;
  headRefName?: string;
  headRefOid?: string;
  isCrossRepository?: boolean;
  latestOpinionatedReviews?: {
    nodes?: ({ state?: string } | null)[] | null;
  } | null;
  commits?: {
    nodes?:
      | ({
          commit?: {
            statusCheckRollup?: {
              state?: string;
              contexts?: { nodes?: (ContextNode | null)[] | null } | null;
            } | null;
          } | null;
        } | null)[]
      | null;
  } | null;
}

export interface SnapshotData {
  repository?: {
    defaultBranchRef?: { name?: string } | null;
    pr?: SnapshotNode | null;
  } | null;
}

export function reviewOf(node: SnapshotNode): PullReview {
  switch (node.reviewDecision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changesRequested";
    case "REVIEW_REQUIRED":
      return "reviewRequired";
    default:
  }
  // 没有评审要求时 GitHub 也给 null：此时只有仍有效的「要求修改」算数。
  const nodes = node.latestOpinionatedReviews?.nodes ?? [];
  return nodes.some((review) => review?.state === "CHANGES_REQUESTED")
    ? "changesRequested"
    : "notRequired";
}

const BAD_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

export function checksOfNode(node: SnapshotNode): PullChecks {
  const sha = node.headRefOid ?? "";
  const last = node.commits?.nodes?.[0];
  if (last === undefined || last === null || sha === "") return { read: false };
  const rollup = last.commit?.statusCheckRollup;
  if (rollup === undefined) return { read: false };
  if (rollup === null) {
    return { read: true, headSha: sha, rollup: "none", failing: [] };
  }
  const failing: string[] = [];
  for (const context of rollup.contexts?.nodes ?? []) {
    if (context === null || context === undefined) continue;
    const bad =
      context.__typename === "CheckRun"
        ? BAD_CONCLUSIONS.has(context.conclusion ?? "")
        : context.state === "FAILURE" || context.state === "ERROR";
    const name =
      context.__typename === "CheckRun" ? context.name : context.context;
    if (bad && typeof name === "string" && name !== "") failing.push(name);
  }
  const state = rollup.state;
  const mapped: Extract<PullChecks, { read: true }>["rollup"] =
    state === "SUCCESS"
      ? "success"
      : state === "FAILURE" || state === "ERROR"
        ? "failure"
        : "pending";
  return {
    read: true,
    headSha: sha,
    rollup: mapped,
    failing: failing.slice(0, MAX_FAILING),
  };
}

export function snapshotFromNode(
  node: SnapshotNode,
  parent: PullParent,
): ForgePullSnapshot {
  return {
    number: node.number ?? 0,
    url: node.url ?? "",
    title: node.title ?? "",
    state:
      node.state === "MERGED"
        ? "merged"
        : node.state === "CLOSED"
          ? "closed"
          : "open",
    draft: node.isDraft === true,
    baseRef: node.baseRefName ?? "",
    headRef: node.headRefName ?? "",
    headSha: node.headRefOid ?? "",
    fromFork: node.isCrossRepository === true,
    review: reviewOf(node),
    checks: checksOfNode(node),
    mergeable:
      node.mergeable === "MERGEABLE"
        ? "mergeable"
        : node.mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
    parent,
  };
}

export function parentOf(data: unknown): PullParent {
  const nodes = (
    data as {
      repository?: {
        pullRequests?: {
          nodes?: ({
            number?: number;
            url?: string;
            isCrossRepository?: boolean;
          } | null)[];
        };
      };
    }
  )?.repository?.pullRequests?.nodes;
  if (nodes === undefined) return { kind: "unknown" };
  const found = nodes.find((node) => node !== null && node !== undefined);
  if (found === undefined || found === null) return { kind: "none" };
  return { kind: "open", number: found.number ?? 0, url: found.url ?? "" };
}
