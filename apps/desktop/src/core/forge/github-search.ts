/**
 * GitHub 列表的 GraphQL 搜索（契约 §112.1）：一次请求拿一页条目的检查汇总、审查
 * 结论、评论、指派、里程碑、标签、增删行与关联，两个状态的计数用别名合在同一请求里。
 *
 * 这里只造查询、把答复映射成 forge 形状；发请求在 `github.ts`。
 */

import {
  type ForgeChecksSummary,
  type ForgeIssue,
  type ForgePull,
  type ForgeReviewDecision,
  type ForgeRollup,
  PULL_EXTRAS,
  type ListRich,
  forgeError,
  timeMs,
  validSha,
} from "./types";
import {
  parseQuery,
  serialize,
  stateOf,
  withoutScope,
  withoutState,
  effectiveSort,
} from "./query";

/** GitHub 搜索最多给前 1000 条。 */
export const SEARCH_WINDOW = 1000;

const ISSUE_FIELDS = `
fragment IssueFields on Issue {
  number title state url createdAt updatedAt closedAt
  author { login }
  labels(first: 20) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  milestone { title }
  comments { totalCount }
  closedByPullRequestsReferences(first: 1, includeClosedPrs: true) { totalCount }
}`;

const PULL_FIELDS = `
fragment PullFields on PullRequest {
  number title state isDraft merged url createdAt updatedAt closedAt mergedAt
  author { login }
  authorAssociation
  baseRefName headRefName headRefOid mergeable isCrossRepository
  autoMergeRequest { enabledAt }
  labels(first: 20) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  milestone { title }
  comments { totalCount }
  reviewDecision
  additions deletions changedFiles
  closingIssuesReferences(first: 20) { nodes { number } }
  commits(last: 1) {
    totalCount
    nodes { commit { statusCheckRollup {
      state
      contexts(first: 1) {
        totalCount
        checkRunCountsByState { state count }
        statusContextCountsByState { state count }
      }
    } } }
  }
}`;

export type SearchKind = "issue" | "pull";

export interface SearchPlan {
  readonly query: string;
  readonly openQuery: string;
  readonly closedQuery: string;
  /** 被忽略的限定词（越出仓库范围的那几个）。 */
  readonly unsupported: string[];
}

/**
 * 用户的限定词串 → 三条搜索串：列表本身、同一查询的开启数、已关闭数（去掉状态词，
 * 已关闭含已合并）。`repo:` 与 `is:issue|pr` 由这里加，用户写的越界词丢掉。
 */
export function planSearch(
  kind: SearchKind,
  owner: string,
  name: string,
  state: "open" | "closed" | "all",
  rich: ListRich,
): SearchPlan {
  const scoped = withoutScope(parseQuery(rich.query));
  const given = stateOf(scoped.parsed);
  const sorted = effectiveSort(
    withoutState(scoped.parsed),
    rich.sort,
    rich.direction,
  );
  const rest = serialize(sorted.parsed);
  const base = [
    `repo:${owner}/${name}`,
    kind === "issue" ? "is:issue" : "is:pr",
    ...(rest === "" ? [] : [rest]),
  ].join(" ");
  const effective = given ?? state;
  const stateClause = effective === "all" ? "" : ` is:${effective}`;
  return {
    query: `${base}${stateClause} sort:${sorted.sort}-${sorted.direction}`,
    openQuery: `${base} is:open`,
    closedQuery: `${base} is:closed`,
    unsupported: scoped.dropped,
  };
}

/** GitHub 的条目游标是 `cursor:<序号>` 的 base64：跳到第 N 页就是跳过前 (N-1)×每页 条。 */
export function offsetCursor(skip: number): string {
  return Buffer.from(`cursor:${skip}`, "utf8").toString("base64");
}

export function searchDocument(kind: SearchKind): string {
  const fragment = kind === "issue" ? "...IssueFields" : "...PullFields";
  return `query($q: String!, $oq: String!, $cq: String!, $first: Int!, $after: String) {
  list: search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    nodes { ${fragment} }
  }
  open: search(query: $oq, type: ISSUE, first: 0) { issueCount }
  closed: search(query: $cq, type: ISSUE, first: 0) { issueCount }
}
${kind === "issue" ? ISSUE_FIELDS : PULL_FIELDS}`;
}

/** 单条详情：同一份字段，换成按编号取。 */
export function detailDocument(kind: SearchKind): string {
  const node = kind === "issue" ? "issue" : "pullRequest";
  const fragment = kind === "issue" ? "...IssueFields" : "...PullFields";
  return `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    item: ${node}(number: $number) { ${fragment} }
  }
}
${kind === "issue" ? ISSUE_FIELDS : PULL_FIELDS}`;
}

export function searchVariables(
  plan: SearchPlan,
  page: number,
  limit: number,
): Record<string, unknown> {
  if (page * limit > SEARCH_WINDOW) {
    throw forgeError("invalid", "PAGE_TOO_DEEP");
  }
  return {
    q: plan.query,
    oq: plan.openQuery,
    cq: plan.closedQuery,
    first: limit,
    ...(page > 1 ? { after: offsetCursor((page - 1) * limit) } : {}),
  };
}

interface Connection<T> {
  nodes?: (T | null)[] | null;
  totalCount?: number;
}
interface Counted {
  state?: string;
  count?: number;
}
export interface IssueNode {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  author?: { login?: string } | null;
  labels?: Connection<{ name?: string }>;
  assignees?: Connection<{ login?: string }>;
  milestone?: { title?: string } | null;
  comments?: { totalCount?: number };
  closedByPullRequestsReferences?: { totalCount?: number } | null;
}
export interface PullNode extends IssueNode {
  isDraft?: boolean;
  merged?: boolean;
  mergedAt?: string | null;
  authorAssociation?: string | null;
  baseRefName?: string;
  headRefName?: string;
  headRefOid?: string;
  mergeable?: string;
  isCrossRepository?: boolean;
  autoMergeRequest?: { enabledAt?: string } | null;
  reviewDecision?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  closingIssuesReferences?: Connection<{ number?: number }>;
  commits?: {
    totalCount?: number;
    nodes?:
      | ({
          commit?: {
            statusCheckRollup?: {
              state?: string;
              contexts?: {
                totalCount?: number;
                checkRunCountsByState?: Counted[] | null;
                statusContextCountsByState?: Counted[] | null;
              } | null;
            } | null;
          } | null;
        } | null)[]
      | null;
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function strings<T>(
  connection: Connection<T> | undefined,
  pick: (node: T) => unknown,
): string[] {
  const out: string[] = [];
  for (const node of connection?.nodes ?? []) {
    if (node === null || node === undefined) continue;
    const value = pick(node);
    if (typeof value === "string" && value !== "")
      out.push(value.slice(0, 128));
  }
  return out;
}

function url(value: unknown): string {
  return typeof value === "string" && /^https?:\/\//i.test(value)
    ? value.slice(0, 2048)
    : "";
}

export function issueFromNode(node: IssueNode): ForgeIssue {
  const closed = node.state === "CLOSED";
  const milestone = node.milestone?.title;
  return {
    number: num(node.number),
    title: (node.title ?? "").slice(0, 1024),
    body: "",
    state: closed ? "closed" : "open",
    author: node.author?.login ? node.author.login : null,
    labels: strings(node.labels, (label) => label.name),
    commentCount: num(node.comments?.totalCount),
    url: url(node.url),
    createdAtMs: timeMs(node.createdAt) ?? 0,
    updatedAtMs: timeMs(node.updatedAt) ?? 0,
    closedAtMs: closed ? timeMs(node.closedAt) : null,
    assignees: strings(node.assignees, (user) => user.login),
    milestone: milestone ? milestone : null,
    linkedPulls: num(node.closedByPullRequestsReferences?.totalCount),
  };
}

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function rollupOfState(value: string | undefined): ForgeRollup {
  switch (value) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

export function checksFromNode(node: PullNode): ForgeChecksSummary {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (rollup === null || rollup === undefined) {
    return { rollup: "none", passed: 0, total: 0 };
  }
  const contexts = rollup.contexts;
  let passed = 0;
  for (const group of [
    contexts?.checkRunCountsByState,
    contexts?.statusContextCountsByState,
  ]) {
    for (const item of group ?? []) {
      if (PASSED.has(item.state ?? "")) passed += num(item.count);
    }
  }
  return {
    rollup: rollupOfState(rollup.state),
    passed,
    total: num(contexts?.totalCount),
  };
}

function decision(
  value: string | null | undefined,
): ForgeReviewDecision | null {
  switch (value) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changesRequested";
    case "REVIEW_REQUIRED":
      return "reviewRequired";
    default:
      return null;
  }
}

/** `FIRST_TIME_CONTRIBUTOR` → `firstTimeContributor`；`NONE` 与缺省是 `null`。 */
export function association(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "" || value === "NONE") {
    return null;
  }
  return value
    .toLowerCase()
    .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function pullFromNode(node: PullNode): ForgePull {
  const issue = issueFromNode(node);
  const state =
    node.state === "MERGED" || node.merged === true
      ? "merged"
      : node.state === "CLOSED"
        ? "closed"
        : "open";
  const sha = node.headRefOid ?? "";
  const linked: number[] = [];
  for (const item of node.closingIssuesReferences?.nodes ?? []) {
    const value = num(item?.number);
    if (value > 0) linked.push(value);
  }
  return {
    ...PULL_EXTRAS,
    number: issue.number,
    title: issue.title,
    body: "",
    state,
    draft: node.isDraft === true,
    author: issue.author,
    baseRef: (node.baseRefName ?? "").slice(0, 255),
    headRef: (node.headRefName ?? "").slice(0, 255),
    headSha: validSha(sha) ? sha : "",
    mergeable:
      state !== "open"
        ? "unknown"
        : node.mergeable === "MERGEABLE"
          ? "mergeable"
          : node.mergeable === "CONFLICTING"
            ? "conflicting"
            : "unknown",
    url: issue.url,
    createdAtMs: issue.createdAtMs,
    updatedAtMs: issue.updatedAtMs,
    mergedAtMs: state === "merged" ? timeMs(node.mergedAt) : null,
    autoMerge: state === "open" && node.autoMergeRequest != null,
    fromFork: node.isCrossRepository === true,
    labels: issue.labels,
    assignees: issue.assignees,
    milestone: issue.milestone,
    commentCount: issue.commentCount,
    reviewDecision: decision(node.reviewDecision),
    checks: checksFromNode(node),
    additions: num(node.additions),
    deletions: num(node.deletions),
    changedFiles: num(node.changedFiles),
    commitCount: num(node.commits?.totalCount),
    linkedIssues: linked,
    authorAssociation: association(node.authorAssociation),
  };
}

export interface SearchData {
  list?: {
    issueCount?: number;
    nodes?: (IssueNode | PullNode | null)[] | null;
  };
  open?: { issueCount?: number };
  closed?: { issueCount?: number };
}

export interface SearchResult<T> {
  readonly items: T[];
  readonly totalCount: number;
  readonly openCount: number;
  readonly closedCount: number;
  readonly page: number;
  readonly pageCount: number;
}

export function mapSearch<T>(
  data: unknown,
  page: number,
  limit: number,
  map: (node: IssueNode | PullNode) => T,
): SearchResult<T> {
  if (data === null || typeof data !== "object") {
    throw forgeError("unavailable", "RESPONSE_MALFORMED");
  }
  const body = data as SearchData;
  if (body.list === undefined || body.list === null) {
    throw forgeError("unavailable", "RESPONSE_MALFORMED");
  }
  const total = num(body.list.issueCount);
  const reachable = Math.min(total, SEARCH_WINDOW);
  return {
    items: (body.list.nodes ?? [])
      .filter((node): node is IssueNode | PullNode => node != null)
      // 搜索偶尔混进别的类型的空对象：没有编号的不算。
      .filter((node) => num(node.number) > 0)
      .map(map),
    totalCount: total,
    openCount: num(body.open?.issueCount),
    closedCount: num(body.closed?.issueCount),
    page,
    pageCount: Math.max(1, Math.ceil(reachable / limit)),
  };
}
