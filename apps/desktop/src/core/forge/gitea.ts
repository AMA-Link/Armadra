/**
 * Gitea / Forgejo（两者同一套 `/api/v1`）。
 *
 *   * 认证 `Authorization: token <令牌>`；令牌要 `read:repository`（读）与
 *     `write:repository` / `write:issue`（写）。
 *   * pull request 同名；检查用 commit statuses（Gitea Actions 也写这一张）。
 *   * 差异：文件表来自 `/pulls/{n}/files`，每个文件的补丁从 `/pulls/{n}.diff`
 *     按文件切出来（文件表本身不带补丁）。
 *   * 草稿：Gitea 按标题前缀 `WIP:` 认草稿，建草稿 PR 就加这个前缀。
 *   * 合并方式按仓库的 `allow_merge_commits` / `allow_squash_merge` /
 *     `allow_rebase` 细分（{@link giteaMergeMethods}）。
 *   * 检查通过后合并：`POST …/merge` 带 `merge_when_checks_succeed`，排上了
 *     答 201，检查已经过了就当场合并答 200；撤销是 `DELETE …/merge`。PR 上没有
 *     「已排上」字段，详情从时间线最后一条排程 / 撤销事件读。
 */

import type { PullChecks, PullParent, PullReview } from "@armadra/shared";
import { checksOf as checksOfSummary } from "./snapshot";
import {
  type CreatePullInput,
  DEFAULT_LIMIT,
  type Forge,
  type ForgeCheck,
  type ForgeCheckState,
  type ForgeBranchDeletion,
  type ForgeChecks,
  type ForgePullSnapshot,
  type ForgeCommit,
  type ForgeFacets,
  type ForgeReviewer,
  type ListSort,
  MAX_COMMITS,
  MAX_FACETS,
  PULL_EXTRAS,
  summarizeChecks,
  type ForgeConversation,
  type ForgeConversationItem,
  type ForgeThreadKind,
  MAX_CONVERSATION_PAGES,
  ForgeError,
  type ForgeFile,
  type ForgeFileStatus,
  type ForgeIssue,
  type ForgeIssueState,
  type ForgeAutoMerge,
  type ForgeMergeMethod,
  type ForgeMergeOptions,
  type ForgeMerged,
  type ForgePage,
  type ForgePull,
  type ForgeRepo,
  type ForgeRepository,
  type ListOptions,
  type RepositoryListOptions,
  MAX_BODY,
  MAX_FILES,
  MAX_LIMIT,
  MAX_TITLE,
  type MergeInput,
  forgeError,
  rollupOf,
  timeMs,
  validRefName,
  validSha,
  pagePollInterval,
} from "./types";
import {
  ForgeTransport,
  type Query,
  type TokenSource,
  decodeJson,
  normalizeBase,
} from "./transport";
import { validName } from "../github/remote";
import {
  count,
  hexColor,
  names,
  numbered,
  pageSize,
  pool,
  text,
  webUrl,
} from "./wire";
import {
  QueryParts,
  effectiveSort,
  parseQuery,
  stateOf,
  withoutState,
} from "./query";
import {
  type WireRepository,
  fromWireRepository,
  present,
  repositoryLimit,
} from "./repositories";

const API_SUFFIX = "/api/v1";
/** 逐条补检查、取 PR 的并发上限。 */
const CONCURRENCY = 4;

/**
 * 用户给的地址 → API 根。给站点根（`https://git.example.com`）或 API 根
 * （`…/api/v1`）都行；不收的地址答 `undefined`。
 */
export function giteaApiBase(value: string): string | undefined {
  const base = normalizeBase(value);
  if (base === undefined) return undefined;
  return base.endsWith(API_SUFFIX) ? base : `${base}${API_SUFFIX}`;
}

/** API 根 → 站点根，拼仓库的网页地址用。 */
export function giteaWebRoot(apiBase: string): string {
  return apiBase.endsWith(API_SUFFIX)
    ? apiBase.slice(0, -API_SUFFIX.length)
    : apiBase;
}

interface WireUser {
  login?: string;
}
interface WireLabel {
  name?: string;
}
interface WireIssue {
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  user?: WireUser | null;
  labels?: WireLabel[] | null;
  assignees?: WireUser[] | null;
  milestone?: { title?: string } | null;
  comments?: number;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  pull_request?: unknown;
}
interface WireBranch {
  ref?: string;
  sha?: string;
  repo_id?: number;
}
/** `GET /repos/{o}/{r}/branches/{b}`。 */
interface WireRepoBranch {
  required_approvals?: number;
  name?: string;
  commit?: { id?: string } | null;
  protected?: boolean;
}
interface WirePull {
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  draft?: boolean;
  user?: WireUser | null;
  base?: WireBranch | null;
  head?: WireBranch | null;
  mergeable?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  labels?: WireLabel[] | null;
  assignees?: WireUser[] | null;
  requested_reviewers?: WireUser[] | null;
  milestone?: { title?: string } | null;
  comments?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}
/** `GET /repos/{o}/{r}` 里管合并方式的几项；老版本缺字段时按允许。 */
interface WireRepo {
  default_branch?: string;
  allow_merge_commits?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase?: boolean;
}
/** `GET /repos/{o}/{r}/issues/{n}/timeline` 的一条；只看类型。 */
interface WireTimelineEvent {
  type?: string;
}
interface WireFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
}
interface WireStatus {
  context?: string;
  status?: string;
  state?: string;
  target_url?: string;
}

function login(user: WireUser | null | undefined): string | null {
  return typeof user?.login === "string" && user.login !== ""
    ? user.login
    : null;
}

function toIssue(value: WireIssue): ForgeIssue {
  return {
    number: count(value.number),
    title: text(value.title, MAX_TITLE * 4),
    body: text(value.body, MAX_BODY * 4),
    state: value.state === "closed" ? "closed" : "open",
    author: login(value.user),
    labels: (value.labels ?? [])
      .map((label) => text(label?.name, 128))
      .filter((name) => name !== "")
      .slice(0, 100),
    commentCount: count(value.comments),
    url: webUrl(value.html_url),
    createdAtMs: timeMs(value.created_at) ?? 0,
    updatedAtMs: timeMs(value.updated_at) ?? 0,
    closedAtMs: value.state === "closed" ? timeMs(value.closed_at) : null,
    assignees: logins(value.assignees),
    milestone: milestoneTitle(value.milestone),
    linkedPulls: 0,
  };
}

function logins(values: WireUser[] | null | undefined): string[] {
  return names(values, (user) => text((user as WireUser)?.login, 128));
}

function milestoneTitle(value: { title?: string } | null | undefined) {
  const title = text(value?.title, 256);
  return title === "" ? null : title;
}

function labelNames(values: WireLabel[] | null | undefined): string[] {
  return (values ?? [])
    .map((label) => text(label?.name, 128))
    .filter((name) => name !== "")
    .slice(0, 100);
}

function toPull(value: WirePull): ForgePull {
  const merged = value.merged === true;
  const state = merged
    ? "merged"
    : value.state === "closed"
      ? "closed"
      : "open";
  const title = text(value.title, MAX_TITLE * 4);
  const hasStat = typeof value.additions === "number";
  return {
    ...PULL_EXTRAS,
    labels: labelNames(value.labels),
    assignees: logins(value.assignees),
    milestone: milestoneTitle(value.milestone),
    commentCount: count(value.comments),
    additions: hasStat ? count(value.additions) : null,
    deletions: hasStat ? count(value.deletions) : null,
    changedFiles:
      typeof value.changed_files === "number"
        ? count(value.changed_files)
        : null,
    number: count(value.number),
    title,
    body: text(value.body, MAX_BODY * 4),
    state,
    draft: value.draft === true || /^\s*\[?WIP\]?:?\s/i.test(title),
    author: login(value.user),
    baseRef: text(value.base?.ref, 255),
    headRef: text(value.head?.ref, 255),
    headSha: validSha(value.head?.sha ?? "") ? (value.head?.sha as string) : "",
    // Gitea 在算合并性时也答 false；已合并 / 已关的不再算。
    mergeable:
      state !== "open"
        ? "unknown"
        : value.mergeable === true
          ? "mergeable"
          : "conflicting",
    url: webUrl(value.html_url),
    createdAtMs: timeMs(value.created_at) ?? 0,
    updatedAtMs: timeMs(value.updated_at) ?? 0,
    mergedAtMs: merged ? timeMs(value.merged_at) : null,
    autoMerge: false,
    fromFork: forked(value.head?.repo_id, value.base?.repo_id),
  };
}

/**
 * 仓库允许的合并方式。Gitea 的 `rebase` 对应 `allow_rebase`；`rebase-merge`、
 * `fast-forward-only` 不在三种之内，不给。字段缺省（老版本）按允许。
 */
export function giteaMergeMethods(repo: WireRepo): ForgeMergeMethod[] {
  const methods: ForgeMergeMethod[] = [];
  if (repo.allow_merge_commits !== false) methods.push("merge");
  if (repo.allow_squash_merge !== false) methods.push("squash");
  if (repo.allow_rebase !== false) methods.push("rebase");
  return methods;
}

/** 时间线里的排程 / 撤销事件（Gitea 的评论类型名）。 */
const SCHEDULED = "pull_scheduled_merge";
const UNSCHEDULED = "pull_cancel_scheduled_merge";
/** 时间线最多翻这么多页（每页 50 条）；更长的按看到的为准。 */
const TIMELINE_PAGES = 10;

/** 两边仓库 id 都在且不同才算 fork；缺字段（老版本）按同仓库。 */
export function forked(head: unknown, base: unknown): boolean {
  return (
    typeof head === "number" &&
    typeof base === "number" &&
    head > 0 &&
    base > 0 &&
    head !== base
  );
}

/** 分支名进路径：逐段编码，斜杠留着（Gitea 的分支路由吃整条剩余路径）。 */
function branchPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

function fileStatus(value: string | undefined): ForgeFileStatus {
  switch (value) {
    case "added":
      return "added";
    case "deleted":
      return "removed";
    case "renamed":
      return "renamed";
    case "changed":
    case "modified":
      return "modified";
    default:
      return "other";
  }
}

function checkState(value: string | undefined): ForgeCheckState {
  switch (value) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "warning":
      return "neutral";
    default:
      return "pending";
  }
}

/**
 * 把一份统一差异按文件切开，键是新路径（删除的文件是旧路径）。补丁从第一个
 * `@@` 开始，与 GitHub 的 `patch` 字段同一个起点；二进制文件没有 `@@`，不在表里。
 */
export function splitDiff(diff: string): Map<string, string> {
  const patches = new Map<string, string>();
  const blocks = diff.split(/^(?=diff --git )/m);
  for (const block of blocks) {
    if (!block.startsWith("diff --git ")) continue;
    const lines = block.split("\n");
    let path = "";
    for (const line of lines) {
      if (line.startsWith("@@")) break;
      if (line.startsWith("+++ b/")) path = line.slice(6);
      else if (line.startsWith("rename to ")) path = path || line.slice(10);
      else if (line.startsWith("--- a/") && path === "") path = line.slice(6);
    }
    if (path === "") {
      // 没有 `---` / `+++` 的块（纯改名、二进制）：头里 a/ 与 b/ 等长时取 b/。
      const header = (lines[0] ?? "").slice("diff --git ".length);
      const half = (header.length - 1) / 2;
      if (Number.isInteger(half) && header.startsWith("a/")) {
        path = header.slice(half + 1).replace(/^b\//, "");
      }
    }
    const hunk = block.indexOf("\n@@");
    if (path === "" || hunk < 0) continue;
    patches.set(path, block.slice(hunk + 1).replace(/\n$/, ""));
  }
  return patches;
}

interface WireReview {
  user?: WireUser | null;
  state?: string;
  dismissed?: boolean;
  official?: boolean;
  submitted_at?: string;
}
interface WireCommit {
  sha?: string;
  html_url?: string;
  author?: WireUser | null;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string } | null;
  } | null;
}

/** Gitea 的评审结论 → 审查者状态；草稿与不认识的丢掉。 */
function giteaReviewerState(
  value: string | undefined,
): ForgeReviewer["state"] | undefined {
  switch ((value ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REQUEST_CHANGES":
      return "changesRequested";
    case "COMMENT":
      return "commented";
    default:
      return undefined;
  }
}

interface WireNote {
  id?: number;
  user?: WireUser | null;
  body?: string;
  state?: string;
  html_url?: string;
  created_at?: string;
  submitted_at?: string;
}

/** Gitea 的评审结论 → 统一写法；草稿（`PENDING`）与不认识的丢掉。 */
function reviewState(value: string | undefined): string | undefined {
  switch ((value ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REQUEST_CHANGES":
      return "changes_requested";
    case "COMMENT":
      return "commented";
    default:
      return undefined;
  }
}

function toConversationItem(
  value: WireNote,
  prefix: "c" | "v",
): ForgeConversationItem | undefined {
  const id = count(value.id);
  const at = timeMs(value.submitted_at ?? value.created_at);
  if (id === 0 || at === null) return undefined;
  const review = prefix === "v";
  const state = review ? reviewState(value.state) : null;
  if (state === undefined) return undefined;
  const login = text(value.user?.login, 256);
  return {
    id: `${prefix}${id}`,
    kind: review ? "review" : "comment",
    author: login === "" ? null : login,
    body: text(value.body, MAX_BODY),
    state,
    url: webUrl(value.html_url),
    createdAtMs: at,
  };
}

function repoPath(repo: ForgeRepo, suffix = ""): string {
  if (!validName(repo.owner) || !validName(repo.name)) {
    throw forgeError("invalid", "REPOSITORY_INVALID");
  }
  return `/repos/${repo.owner}/${repo.name}${suffix}`;
}

function listQuery(options: ListOptions, kind: "issues" | "pulls") {
  const limit =
    options.limit > 0 && options.limit <= MAX_LIMIT
      ? options.limit
      : DEFAULT_LIMIT;
  const query: Record<string, string> = {
    state: options.state,
    limit: String(limit),
  };
  if (options.page > 1) query.page = String(options.page);
  if (kind === "issues") query.type = "issues";
  else query.sort = "recentupdate";
  return query;
}

/** 一次富查询拆出来的列表参数（契约 §112.1）。 */
export interface GiteaFilter {
  /** 对应 `/issues` 的参数（含 `type`）。 */
  readonly issueParams: Record<string, string>;
  /** `/pulls` 要的名字：标签与里程碑在那里按 id，调用方再解析。 */
  readonly labels: string[];
  readonly milestone: string;
  readonly author: string;
  /** `/pulls` 本身答不了的（指派、全文、提到）：改走 `/issues?type=pulls` 再逐条取 PR。 */
  readonly needsSearch: boolean;
  readonly state: "open" | "closed" | "all";
  readonly sort: ListSort;
  readonly direction: "asc" | "desc";
  readonly unsupported: string[];
}

/** 排序：`/pulls` 的 `sort` 取值（Gitea 没有单独的方向参数）。 */
export function giteaPullSort(
  sort: ListSort,
  direction: "asc" | "desc",
): string {
  if (sort === "comments")
    return direction === "desc" ? "mostcomment" : "leastcomment";
  if (sort === "created") return direction === "desc" ? "latest" : "oldest";
  return direction === "desc" ? "recentupdate" : "leastupdate";
}

/**
 * 限定词串 → Gitea 的列表参数。能对上的：`is:open|closed`、`label:`、`milestone:`、
 * `author:`、`assignee:`、`mentions:`、词里的全文；取反、`no:`、审查、状态、分支等
 * 这边没有对应，原样进 `unsupported`。`is:merged` 当已关闭用（Gitea 的已合并也是
 * 已关闭），并回报，因为取回的会含没合并的。
 */
export function giteaFilter(
  kind: "issues" | "pulls",
  options: ListOptions,
): GiteaFilter {
  const rich = options.rich;
  const parsed = parseQuery(rich?.query ?? "");
  const given = stateOf(parsed);
  const sorted = effectiveSort(
    withoutState(parsed),
    rich?.sort,
    rich?.direction,
  );
  const parts = new QueryParts(sorted.parsed);
  const unsupported: string[] = [];
  let state = given ?? options.state;
  if (state === "merged") {
    unsupported.push("is:merged");
    state = "closed";
  }
  const issueParams: Record<string, string> = {
    type: kind === "issues" ? "issues" : "pulls",
  };
  const labels = parts.take("label").map((item) => item.value);
  if (labels.length > 0) issueParams.labels = labels.join(",");
  const milestone = parts.take("milestone")[0]?.value ?? "";
  if (milestone !== "") issueParams.milestones = milestone;
  const author = parts.take("author")[0]?.value ?? "";
  if (author !== "") issueParams.created_by = author;
  const assignee = parts.take("assignee")[0]?.value ?? "";
  if (assignee !== "") issueParams.assigned_by = assignee;
  const mentions = parts.take("mentions")[0]?.value ?? "";
  if (mentions !== "") issueParams.mentioned_by = mentions;
  if (parts.text !== "") issueParams.q = parts.text;
  unsupported.push(...parts.rest());
  if (
    (kind === "issues" && sorted.direction === "asc") ||
    (kind === "issues" && sorted.sort === "comments")
  ) {
    // 议题列表接口没有排序参数，只会按创建时间倒序给（更新时间倒序也近似）。
    unsupported.push(`sort:${sorted.sort}-${sorted.direction}`);
  }
  return {
    issueParams,
    labels,
    milestone,
    author,
    needsSearch: assignee !== "" || mentions !== "" || parts.text !== "",
    state: state as GiteaFilter["state"],
    sort: sorted.sort,
    direction: sorted.direction,
    unsupported,
  };
}

/**
 * Gitea 的 `mergeable: false` 分不出冲突与「还在算」：同一个 head 连续两次读到
 * false 才算冲突，第一次记 `unknown`。按 API 根、仓库与编号记在进程里，Forge
 * 实例被重建也不丢。
 */
const FALSE_ONCE = new Map<string, string>();
const MAX_FALSE_ONCE = 2000;

export interface GiteaOptions {
  readonly apiBase: string;
  readonly token: TokenSource;
  readonly fetch?: typeof globalThis.fetch;
}

export class GiteaForge implements Forge {
  readonly kind = "gitea" as const;
  private readonly http: ForgeTransport;
  private readonly apiBase: string;
  private readonly defaults = new Map<
    string,
    { readonly branch: string; readonly at: number }
  >();

  constructor(options: GiteaOptions) {
    this.apiBase = options.apiBase;
    this.http = new ForgeTransport({
      base: options.apiBase,
      token: options.token,
      authorize: (token) => ({ authorization: `token ${token}` }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /** 令牌属于谁。配置时核验一次，免得存下一个远端不认的令牌。 */
  async viewer(): Promise<string> {
    const response = await this.http.get("/user");
    const value = decodeJson<WireUser>(response);
    const name = login(value);
    if (name === null) throw forgeError("unavailable", "RESPONSE_MALFORMED");
    return name;
  }

  /** 令牌所属账号能看到的仓库（§29.7）：`GET /user/repos`，最近更新的在前。 */
  async repositories(
    host: string,
    options: RepositoryListOptions,
  ): Promise<ForgePage<ForgeRepository>> {
    const query: Record<string, string> = {
      limit: String(repositoryLimit(options.limit)),
    };
    if (options.page > 1) query.page = String(options.page);
    const response = await this.http.get("/user/repos", query);
    const values = decodeJson<WireRepository[]>(response);
    if (!Array.isArray(values)) {
      throw forgeError("unavailable", "RESPONSE_MALFORMED");
    }
    return {
      items: present(
        values.map((value) => fromWireRepository(host, "gitea", value)),
      ),
      nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
    };
  }

  /** 一页之外的元信息；总数没给就都留 `null`。 */
  private pageMeta(
    response: { totalCount?: number; nextPage: number },
    page: number,
    limit: number,
  ) {
    const total = response.totalCount ?? null;
    return {
      nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
      totalCount: total,
      page,
      pageCount: total === null ? null : Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** 同一个筛选下只数条数：`limit=1` 取总数响应头；数不出来答 `null`。 */
  private async tally(path: string, params: Query): Promise<number | null> {
    try {
      const response = await this.http.get(path, { ...params, limit: "1" });
      return response.totalCount ?? null;
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "unavailable") {
        return null;
      }
      throw error;
    }
  }

  /** 开启 / 已关闭的数：已知状态那一边直接用主请求的总数，另一边补一次请求。 */
  private async stateCounts(
    path: string,
    params: Query,
    state: "open" | "closed" | "all",
    total: number | null,
  ): Promise<{ openCount: number | null; closedCount: number | null }> {
    const [openCount, closedCount] = await Promise.all([
      state === "open" ? total : this.tally(path, { ...params, state: "open" }),
      state === "closed"
        ? total
        : this.tally(path, { ...params, state: "closed" }),
    ]);
    return { openCount, closedCount };
  }

  /** 把分页读到底（有上限）：筛选候选与名字 → id 的解析都用它。 */
  private async readAll<T>(
    path: string,
    query: Query = {},
    pages = 4,
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (let read = 0; read < pages && items.length < MAX_FACETS; read += 1) {
      const response = await this.http.get(path, {
        ...query,
        limit: "50",
        ...(page > 1 ? { page: String(page) } : {}),
      });
      const values = decodeJson<T[] | null>(response) ?? [];
      if (!Array.isArray(values)) {
        throw forgeError("unavailable", "RESPONSE_MALFORMED");
      }
      items.push(...values);
      if (response.nextPage <= page) break;
      page = response.nextPage;
    }
    return items.slice(0, MAX_FACETS);
  }

  async listIssues(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgeIssue>> {
    if (options.rich !== undefined) return this.richIssues(repo, options);
    const response = await this.http.get(
      repoPath(repo, "/issues"),
      listQuery(options, "issues"),
    );
    const values = decodeJson<WireIssue[]>(response);
    if (!Array.isArray(values)) {
      throw forgeError("unavailable", "RESPONSE_MALFORMED");
    }
    return {
      items: values.filter((value) => value.pull_request == null).map(toIssue),
      nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
      ...pagePollInterval(response),
    };
  }

  private async richIssues(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgeIssue>> {
    const filter = giteaFilter("issues", options);
    const limit = pageSize(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const path = repoPath(repo, "/issues");
    const response = await this.http.get(path, {
      ...filter.issueParams,
      state: filter.state,
      limit: String(limit),
      ...(options.page > 1 ? { page: String(options.page) } : {}),
    });
    const values = decodeJson<WireIssue[]>(response);
    if (!Array.isArray(values)) {
      throw forgeError("unavailable", "RESPONSE_MALFORMED");
    }
    const meta = this.pageMeta(response, options.page, limit);
    return {
      items: values.filter((value) => value.pull_request == null).map(toIssue),
      ...meta,
      ...(await this.stateCounts(
        path,
        filter.issueParams,
        filter.state,
        meta.totalCount,
      )),
      unsupported: filter.unsupported,
      ...pagePollInterval(response),
    };
  }

  async getIssue(repo: ForgeRepo, number: number): Promise<ForgeIssue> {
    const response = await this.http.get(
      repoPath(repo, `/issues/${numbered(number)}`),
    );
    const value = decodeJson<WireIssue>(response);
    // 同一个编号空间里的 PR 不是 issue：关掉它的含义完全不同。
    if (value.pull_request != null) throw forgeError("notFound", "IS_PULL");
    return toIssue(value);
  }

  async setIssueState(
    repo: ForgeRepo,
    number: number,
    state: ForgeIssueState,
  ): Promise<ForgeIssue> {
    // 先读一次：PR 的编号经 issues 端点也改得动，那不是这个动词的意思。
    await this.getIssue(repo, number);
    const response = await this.http.write(
      "PATCH",
      repoPath(repo, `/issues/${numbered(number)}`),
      { state },
    );
    return toIssue(decodeJson<WireIssue>(response));
  }

  async listPulls(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgePull>> {
    if (options.rich !== undefined) return this.richPulls(repo, options);
    const response = await this.http.get(
      repoPath(repo, "/pulls"),
      listQuery(options, "pulls"),
    );
    const values = decodeJson<WirePull[]>(response);
    if (!Array.isArray(values)) {
      throw forgeError("unavailable", "RESPONSE_MALFORMED");
    }
    return {
      items: values.map(toPull),
      nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
      ...pagePollInterval(response),
    };
  }

  /** `/pulls` 里标签与里程碑按 id：名字先解析；有一个对不上就是没有匹配。 */
  private async resolveIds(
    repo: ForgeRepo,
    filter: GiteaFilter,
  ): Promise<{ labels: string[]; milestone: string } | undefined> {
    const labels: string[] = [];
    if (filter.labels.length > 0) {
      const known = await this.readAll<{ id?: number; name?: string }>(
        repoPath(repo, "/labels"),
      );
      for (const name of filter.labels) {
        const found = known.find((label) => label.name === name);
        if (found === undefined || count(found.id) === 0) return undefined;
        labels.push(String(found.id));
      }
    }
    let milestone = "";
    if (filter.milestone !== "") {
      const known = await this.readAll<{ id?: number; title?: string }>(
        repoPath(repo, "/milestones"),
        { state: "all" },
      );
      const found = known.find((item) => item.title === filter.milestone);
      if (found === undefined || count(found.id) === 0) return undefined;
      milestone = String(found.id);
    }
    return { labels, milestone };
  }

  private async richPulls(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgePull>> {
    const filter = giteaFilter("pulls", options);
    const limit = pageSize(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const paging: Query = {
      limit: String(limit),
      ...(options.page > 1 ? { page: String(options.page) } : {}),
    };
    let pulls: ForgePull[];
    let meta: ReturnType<GiteaForge["pageMeta"]>;
    let counts: { openCount: number | null; closedCount: number | null };
    let poll: { pollIntervalMs?: number };
    const search = filter.needsSearch || filter.author !== "";
    if (search) {
      // 指派、全文、提到、作者只有 `/issues?type=pulls` 答得了：先取编号，再逐条取 PR。
      const path = repoPath(repo, "/issues");
      const response = await this.http.get(path, {
        ...filter.issueParams,
        state: filter.state,
        ...paging,
      });
      const values = decodeJson<WireIssue[]>(response);
      if (!Array.isArray(values)) {
        throw forgeError("unavailable", "RESPONSE_MALFORMED");
      }
      const fetched = await pool(values, CONCURRENCY, async (value) => {
        try {
          return await this.pullOnly(repo, count(value.number));
        } catch {
          return undefined;
        }
      });
      pulls = fetched.filter((pull): pull is ForgePull => pull !== undefined);
      meta = this.pageMeta(response, options.page, limit);
      counts = await this.stateCounts(
        path,
        filter.issueParams,
        filter.state,
        meta.totalCount,
      );
      poll = pagePollInterval(response);
    } else {
      const ids = await this.resolveIds(repo, filter);
      if (ids === undefined) {
        return {
          items: [],
          nextCursor: null,
          totalCount: 0,
          openCount: 0,
          closedCount: 0,
          page: options.page,
          pageCount: 1,
          unsupported: filter.unsupported,
        };
      }
      const path = repoPath(repo, "/pulls");
      const params: Query = {
        ...(ids.labels.length > 0 ? { labels: ids.labels } : {}),
        ...(ids.milestone === "" ? {} : { milestone: ids.milestone }),
      };
      const response = await this.http.get(path, {
        ...params,
        state: filter.state,
        sort: giteaPullSort(filter.sort, filter.direction),
        ...paging,
      });
      const values = decodeJson<WirePull[]>(response);
      if (!Array.isArray(values)) {
        throw forgeError("unavailable", "RESPONSE_MALFORMED");
      }
      pulls = values.map(toPull);
      meta = this.pageMeta(response, options.page, limit);
      counts = await this.stateCounts(
        path,
        params,
        filter.state,
        meta.totalCount,
      );
      poll = pagePollInterval(response);
    }
    // 检查只为这一页逐条取，并发有上限；取不到的留 `null`。
    const items = await pool(pulls, CONCURRENCY, async (pull) => {
      if (pull.headSha === "") return pull;
      try {
        return {
          ...pull,
          checks: summarizeChecks(await this.statusList(repo, pull.headSha)),
        };
      } catch {
        return pull;
      }
    });
    return {
      items,
      ...meta,
      ...counts,
      unsupported: filter.unsupported,
      ...poll,
    };
  }

  /** 详情：开着的 PR 再从时间线读「检查通过后合并」排上了没有。 */
  async getPull(repo: ForgeRepo, number: number): Promise<ForgePull> {
    const pull = await this.pullOnly(repo, number);
    if (pull.state !== "open") return pull;
    return { ...pull, autoMerge: await this.scheduled(repo, number) };
  }

  private async pullOnly(repo: ForgeRepo, number: number): Promise<ForgePull> {
    const response = await this.http.get(
      repoPath(repo, `/pulls/${numbered(number)}`),
    );
    return toPull(decodeJson<WirePull>(response));
  }

  /**
   * 最后一条排程 / 撤销事件是不是排程。读不到时间线（老版本、权限）答
   * `false`：这只是详情上的一个标记，不能让详情整个失败。
   */
  private async scheduled(repo: ForgeRepo, number: number): Promise<boolean> {
    let last = false;
    try {
      let page = 1;
      for (let read = 0; read < TIMELINE_PAGES; read += 1) {
        const response = await this.http.get(
          repoPath(repo, `/issues/${numbered(number)}/timeline`),
          { page: String(page), limit: "50" },
        );
        const events = decodeJson<WireTimelineEvent[]>(response);
        if (!Array.isArray(events)) return false;
        for (const event of events) {
          if (event?.type === SCHEDULED) last = true;
          else if (event?.type === UNSCHEDULED) last = false;
        }
        if (response.nextPage <= page) break;
        page = response.nextPage;
      }
    } catch {
      return false;
    }
    return last;
  }

  private async repository(repo: ForgeRepo): Promise<WireRepo> {
    return decodeJson<WireRepo>(await this.http.get(repoPath(repo)));
  }

  async createPull(
    repo: ForgeRepo,
    input: CreatePullInput,
  ): Promise<ForgePull> {
    if (!validRefName(input.head) || !validRefName(input.base)) {
      throw forgeError("invalid", "REF_INVALID");
    }
    const title = input.draft ? `WIP: ${input.title}` : input.title;
    const response = await this.http.write("POST", repoPath(repo, "/pulls"), {
      title,
      body: input.body,
      head: input.head,
      base: input.base,
    });
    return toPull(decodeJson<WirePull>(response));
  }

  async pullFiles(
    repo: ForgeRepo,
    number: number,
  ): Promise<readonly ForgeFile[]> {
    const index = numbered(number);
    const response = await this.http.get(
      repoPath(repo, `/pulls/${index}/files`),
      {
        limit: String(MAX_FILES),
      },
    );
    const values = decodeJson<WireFile[]>(response);
    if (!Array.isArray(values)) {
      throw forgeError("unavailable", "RESPONSE_MALFORMED");
    }
    const diff = await this.http.get(
      repoPath(repo, `/pulls/${index}.diff`),
      undefined,
      "text/plain",
    );
    const patches = splitDiff(diff.body.toString("utf8"));
    return values.slice(0, MAX_FILES).map((value) => {
      const path = text(value.filename, 4096);
      const previous = text(value.previous_filename, 4096);
      return {
        path,
        previousPath: previous === "" || previous === path ? null : previous,
        status: fileStatus(value.status),
        additions: count(value.additions),
        deletions: count(value.deletions),
        patch: patches.get(path) ?? null,
      };
    });
  }

  /** 一个提交上的状态，同一个 context 的多次上报只留最新那条（远端按时间倒序给）。 */
  private async statusList(
    repo: ForgeRepo,
    sha: string,
  ): Promise<ForgeCheck[]> {
    const response = await this.http.get(
      repoPath(repo, `/commits/${sha}/status`),
    );
    const combined = decodeJson<{ statuses?: WireStatus[] | null }>(response);
    const seen = new Set<string>();
    const checks: ForgeCheck[] = [];
    for (const status of combined.statuses ?? []) {
      const name = text(status.context, 256);
      if (name === "" || seen.has(name)) continue;
      seen.add(name);
      const url = webUrl(status.target_url);
      checks.push({
        name,
        state: checkState(status.status ?? status.state),
        url: url === "" ? null : url,
      });
    }
    return checks;
  }

  async checks(repo: ForgeRepo, number: number): Promise<ForgeChecks> {
    const pull = await this.pullOnly(repo, number);
    if (pull.headSha === "") {
      return { headSha: "", rollup: "none", checks: [] };
    }
    const checks = await this.statusList(repo, pull.headSha);
    return { headSha: pull.headSha, rollup: rollupOf(checks), checks };
  }

  /** 仓库的默认分支，按仓库缓存一小时。 */
  private async defaultBranch(repo: ForgeRepo): Promise<string> {
    const key = `${repo.owner}/${repo.name}`;
    const hit = this.defaults.get(key);
    if (hit !== undefined && Date.now() - hit.at < 3_600_000) return hit.branch;
    const value = decodeJson<WireRepo>(await this.http.get(repoPath(repo)));
    const branch = text(value.default_branch, 255);
    if (branch === "") throw forgeError("unavailable", "RESPONSE_MALFORMED");
    this.defaults.set(key, { branch, at: Date.now() });
    return branch;
  }

  /**
   * 谁的 head 是这个 PR 的 base 且还开着。先按 base+head 精确取（1.18 起），取不到
   * 再翻 open 列表（最多 2 页 100 条）；翻完没找到但列表没到底，答 `unknown`。
   */
  private async parentOf(repo: ForgeRepo, base: string): Promise<PullParent> {
    const found = (value: WirePull): PullParent => ({
      kind: "open",
      number: count(value.number),
      url: webUrl(value.html_url),
    });
    const defaultBranch = await this.defaultBranch(repo);
    if (base === defaultBranch) return { kind: "none" };
    try {
      const exact = decodeJson<WirePull>(
        await this.http.get(
          repoPath(
            repo,
            `/pulls/${branchPath(defaultBranch)}/${branchPath(base)}`,
          ),
        ),
      );
      if (exact.state === "open" && exact.merged !== true) return found(exact);
    } catch (error) {
      if (!(error instanceof ForgeError) || error.kind !== "notFound") {
        throw error;
      }
    }
    for (let page = 1; page <= 2; page += 1) {
      const response = await this.http.get(repoPath(repo, "/pulls"), {
        state: "open",
        limit: "50",
        ...(page > 1 ? { page: String(page) } : {}),
      });
      const values = decodeJson<WirePull[] | null>(response) ?? [];
      if (!Array.isArray(values)) {
        throw forgeError("unavailable", "RESPONSE_MALFORMED");
      }
      const match = values.find(
        (value) =>
          value.head?.ref === base &&
          !forked(value.head?.repo_id, value.base?.repo_id),
      );
      if (match !== undefined) return found(match);
      if (response.nextPage <= page) return { kind: "none" };
    }
    return { kind: "unknown" };
  }

  /**
   * 评审结论：官方的「要求修改」优先；否则看 base 分支的保护规则：未保护或
   * `required_approvals` 为 0 是无需评审，官方批准数够了是已批准，不够是还需评审；
   * 字段缺失（老版本）或读不到是 `unknown`。
   */
  private async reviewOf(
    repo: ForgeRepo,
    number: number,
    base: string,
  ): Promise<PullReview> {
    let latest: Map<string, string> | undefined;
    try {
      const reviews = await this.readAll<WireReview>(
        repoPath(repo, `/pulls/${numbered(number)}/reviews`),
      );
      latest = new Map();
      for (const value of reviews) {
        const who = text(value.user?.login, 128);
        if (
          who === "" ||
          value.dismissed === true ||
          value.official === false
        ) {
          continue;
        }
        if (value.state === "APPROVED" || value.state === "REQUEST_CHANGES") {
          latest.set(who, value.state);
        }
      }
    } catch {
      latest = undefined;
    }
    const states = [...(latest?.values() ?? [])];
    if (states.includes("REQUEST_CHANGES")) return "changesRequested";
    if (latest === undefined) return "unknown";
    try {
      const branch = decodeJson<WireRepoBranch>(
        await this.http.get(repoPath(repo, `/branches/${branchPath(base)}`)),
      );
      if (branch.protected === false) return "notRequired";
      const required = branch.required_approvals;
      if (typeof required !== "number") return "unknown";
      if (required === 0) return "notRequired";
      return states.filter((state) => state === "APPROVED").length >= required
        ? "approved"
        : "reviewRequired";
    } catch {
      return "unknown";
    }
  }

  /** 快照（契约 §115）。 */
  async pullSnapshot(
    repo: ForgeRepo,
    number: number,
  ): Promise<ForgePullSnapshot> {
    const pull = await this.pullOnly(repo, number);
    const open = pull.state === "open";
    const key = `${this.apiBase}|${repo.owner}/${repo.name}#${number}`;
    let mergeable = pull.mergeable;
    if (open && mergeable === "conflicting") {
      if (FALSE_ONCE.get(key) === pull.headSha) {
        mergeable = "conflicting";
      } else {
        if (FALSE_ONCE.size >= MAX_FALSE_ONCE) FALSE_ONCE.clear();
        FALSE_ONCE.set(key, pull.headSha);
        mergeable = "unknown";
      }
    } else {
      FALSE_ONCE.delete(key);
    }
    let checks: PullChecks = { read: false };
    if (open) {
      try {
        if (pull.headSha === "") {
          checks = { read: true, headSha: "", rollup: "none", failing: [] };
        } else {
          const list = await this.statusList(repo, pull.headSha);
          checks = checksOfSummary({
            headSha: pull.headSha,
            rollup: rollupOf(list),
            checks: list,
          });
        }
      } catch {
        checks = { read: false };
      }
    }
    let parent: PullParent = { kind: "none" };
    if (open) {
      try {
        parent = await this.parentOf(repo, pull.baseRef);
      } catch {
        parent = { kind: "unknown" };
      }
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
      review: open
        ? await this.reviewOf(repo, number, pull.baseRef)
        : "unknown",
      checks,
      mergeable,
      parent,
    };
  }

  async conversation(
    repo: ForgeRepo,
    number: number,
    kind: ForgeThreadKind = "pull",
  ): Promise<ForgeConversation> {
    const index = numbered(number);
    let intervalSec = 0;
    const read = async (
      suffix: string,
      prefix: "c" | "v",
    ): Promise<ForgeConversationItem[]> => {
      const items: ForgeConversationItem[] = [];
      let page = 1;
      for (let pages = 0; pages < MAX_CONVERSATION_PAGES; pages += 1) {
        const query: Record<string, string> = { limit: "50" };
        if (page > 1) query.page = String(page);
        const response = await this.http.get(repoPath(repo, suffix), query);
        intervalSec = Math.max(intervalSec, response.pollIntervalSec ?? 0);
        const values = decodeJson<WireNote[] | null>(response) ?? [];
        if (!Array.isArray(values)) {
          throw forgeError("unavailable", "RESPONSE_MALFORMED");
        }
        for (const value of values) {
          const item = toConversationItem(value, prefix);
          if (item !== undefined) items.push(item);
        }
        if (response.nextPage <= page) break;
        page = response.nextPage;
      }
      return items;
    };
    const items = [
      ...(await read(`/issues/${index}/comments`, "c")),
      // issue 没有评审。
      ...(kind === "issue" ? [] : await read(`/pulls/${index}/reviews`, "v")),
    ].sort((a, b) => a.createdAtMs - b.createdAtMs);
    return {
      items,
      pollIntervalMs: intervalSec > 0 ? intervalSec * 1000 : null,
    };
  }

  async pullReviewers(
    repo: ForgeRepo,
    number: number,
  ): Promise<readonly ForgeReviewer[]> {
    const index = numbered(number);
    const byLogin = new Map<string, ForgeReviewer>();
    const reviews = await this.readAll<WireReview>(
      repoPath(repo, `/pulls/${index}/reviews`),
    );
    for (const value of reviews) {
      const login = text(value.user?.login, 128);
      const state =
        value.dismissed === true
          ? "dismissed"
          : giteaReviewerState(value.state);
      if (login === "" || state === undefined) continue;
      const before = byLogin.get(login);
      if (
        state === "commented" &&
        before !== undefined &&
        before.state !== "commented"
      ) {
        continue;
      }
      const at = timeMs(value.submitted_at);
      byLogin.set(login, { login, state, submittedAtMs: at });
    }
    const raw = decodeJson<WirePull>(
      await this.http.get(repoPath(repo, `/pulls/${index}`)),
    );
    for (const login of logins(raw.requested_reviewers)) {
      byLogin.set(login, { login, state: "pending", submittedAtMs: null });
    }
    return [...byLogin.values()];
  }

  async pullCommits(
    repo: ForgeRepo,
    number: number,
  ): Promise<readonly ForgeCommit[]> {
    const values = await this.readAll<WireCommit>(
      repoPath(repo, `/pulls/${numbered(number)}/commits`),
      {},
      Math.ceil(MAX_COMMITS / 50),
    );
    const commits: ForgeCommit[] = [];
    for (const value of values) {
      const sha = text(value.sha, 64);
      if (!validSha(sha)) continue;
      const author = text(value.author?.login, 128);
      const name = text(value.commit?.author?.name, 256);
      commits.push({
        sha,
        title:
          text(value.commit?.message, 4096).split("\n")[0]?.slice(0, 512) ?? "",
        author: author !== "" ? author : name !== "" ? name : null,
        authoredAtMs: timeMs(value.commit?.author?.date) ?? 0,
        url: webUrl(value.html_url),
      });
    }
    return commits.slice(0, MAX_COMMITS);
  }

  async facets(repo: ForgeRepo): Promise<ForgeFacets> {
    const [labels, milestones, assignees] = await Promise.all([
      this.readAll<WireLabel & { color?: string }>(repoPath(repo, "/labels")),
      this.readAll<{ title?: string; state?: string }>(
        repoPath(repo, "/milestones"),
        { state: "all" },
      ),
      // 能指派的人只是候选；读不到就空着。
      this.readAll<WireUser>(repoPath(repo, "/assignees")).catch(
        () => [] as WireUser[],
      ),
    ]);
    return {
      labels: labels
        .filter((label) => text(label?.name, 128) !== "")
        .map((label) => ({
          name: text(label.name, 128),
          color: hexColor(label.color),
        })),
      milestones: milestones
        .filter((item) => text(item?.title, 256) !== "")
        .map((item) => ({
          title: text(item.title, 256),
          open: item.state !== "closed",
        })),
      assignees: logins(assignees),
    };
  }

  async merge(
    repo: ForgeRepo,
    number: number,
    input: MergeInput,
  ): Promise<ForgeMerged> {
    await this.reviewed(repo, number, input);
    await this.http.write(
      "POST",
      repoPath(repo, `/pulls/${numbered(number)}/merge`),
      {
        Do: input.method,
        head_commit_id: input.headSha,
      },
    );
    return { merged: true, sha: await this.mergeCommit(repo, number) };
  }

  /** 合并前的核对：PR 开着，head 还是评审者看到的那个。 */
  private async reviewed(
    repo: ForgeRepo,
    number: number,
    input: MergeInput,
  ): Promise<void> {
    if (!validSha(input.headSha)) throw forgeError("invalid", "SHA_INVALID");
    const before = await this.pullOnly(repo, number);
    if (before.state === "merged")
      throw forgeError("conflict", "ALREADY_MERGED");
    if (before.state !== "open") throw forgeError("conflict", "NOT_OPEN");
    if (before.headSha !== input.headSha) {
      throw forgeError("conflict", "HEAD_CHANGED");
    }
  }

  /** 合并的答复没有正文；合并提交从 PR 上读。读不到不改变「已合并」这个事实。 */
  private async mergeCommit(
    repo: ForgeRepo,
    number: number,
  ): Promise<string | null> {
    try {
      const response = await this.http.get(
        repoPath(repo, `/pulls/${numbered(number)}`),
      );
      const sha = decodeJson<WirePull>(response).merge_commit_sha ?? "";
      return validSha(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /**
   * 检查通过后合并。与 {@link merge} 一样先核 head、不重试；方式必须是仓库
   * 现在允许的。远端答 201 是排上了；答 200 是检查已经过了、当场合并。
   */
  async autoMerge(
    repo: ForgeRepo,
    number: number,
    input: MergeInput,
  ): Promise<ForgeAutoMerge> {
    if (!validSha(input.headSha)) throw forgeError("invalid", "SHA_INVALID");
    const allowed = giteaMergeMethods(await this.repository(repo));
    if (!allowed.includes(input.method)) {
      throw forgeError("invalid", "MERGE_METHOD_UNSUPPORTED");
    }
    await this.reviewed(repo, number, input);
    const response = await this.http.write(
      "POST",
      repoPath(repo, `/pulls/${numbered(number)}/merge`),
      {
        Do: input.method,
        head_commit_id: input.headSha,
        merge_when_checks_succeed: true,
      },
    );
    if (response.status === 201)
      return { merged: false, sha: null, train: false };
    return {
      merged: true,
      sha: await this.mergeCommit(repo, number),
      train: false,
    };
  }

  /** 撤掉还没发生的检查通过后合并；远端说没排上（404）答 `NOT_SCHEDULED`。 */
  async cancelAutoMerge(repo: ForgeRepo, number: number): Promise<void> {
    const before = await this.pullOnly(repo, number);
    if (before.state !== "open") throw forgeError("conflict", "NOT_SCHEDULED");
    try {
      await this.http.write(
        "DELETE",
        repoPath(repo, `/pulls/${numbered(number)}/merge`),
      );
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "notFound") {
        throw forgeError("conflict", "NOT_SCHEDULED");
      }
      throw error;
    }
  }

  async deleteBranch(
    repo: ForgeRepo,
    number: number,
    headSha: string,
  ): Promise<ForgeBranchDeletion> {
    if (!validSha(headSha)) throw forgeError("invalid", "SHA_INVALID");
    const pull = await this.pullOnly(repo, number);
    if (pull.state !== "merged") return refused("NOT_MERGED");
    if (pull.fromFork) return refused("FORK_BRANCH");
    if (!validRefName(pull.headRef) || pull.headRef === pull.baseRef) {
      return refused("BRANCH_PROTECTED");
    }
    const path = repoPath(repo, `/branches/${branchPath(pull.headRef)}`);
    let branch: WireRepoBranch;
    try {
      branch = decodeJson<WireRepoBranch>(await this.http.get(path));
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "notFound") {
        return refused("ALREADY_DELETED");
      }
      throw error;
    }
    if (branch.protected === true) return refused("BRANCH_PROTECTED");
    if (branch.commit?.id !== headSha) return refused("BRANCH_MOVED");
    await this.http.write("DELETE", path);
    return { deleted: true, reasonCode: "" };
  }

  /** 按仓库的 `allow_*` 细分；检查通过后合并 Gitea 1.17 起都有。 */
  async mergeOptions(repo: ForgeRepo): Promise<ForgeMergeOptions> {
    return {
      methods: giteaMergeMethods(await this.repository(repo)),
      autoMerge: true,
      mergeTrain: false,
    };
  }
}

function refused(reasonCode: string): ForgeBranchDeletion {
  return { deleted: false, reasonCode };
}
