/**
 * GitHub 装进 {@link Forge}：同一个 `GithubClient`（条件请求、限流、写不重试）、
 * 同一份凭据与 API 根（`/api/github/*` 配的那一份），只把记录换成 forge 形状。
 *
 * `/api/github/*` 本身一行不改：这里是它旁边的第二个调用方，不是替身。
 */

import { GithubClient, type GithubClientOptions } from "../github/client";
import { create } from "../contract/message";
import { GithubRepositoryRefSchema } from "../github/schema";
import { githubError } from "../github/errors";
import { validName, webHostFor } from "../github/remote";
import * as api from "../github/endpoints";
import { codeOf, GithubError } from "../github/errors";
import { isPullRecord, toIssue, toPull } from "../github/decode";
import type { WireIssue, WirePull } from "../github/decode";
import type { GithubService } from "../github/service";
import {
  GithubCheckConclusion,
  GithubIssueState,
  GithubMergeableState,
  GithubPullState,
  type GithubCheckSummary,
  type GithubIssue,
  type GithubPullFile,
  type GithubPullRequest,
  type GithubRepositoryRef,
} from "../github/types";
import {
  ALL_MERGE_METHODS,
  type CreatePullInput,
  DEFAULT_LIMIT,
  type Forge,
  type ForgeCheckState,
  type ForgeChecks,
  type ForgeCommit,
  type ForgeFacets,
  type ForgeReviewer,
  MAX_COMMITS,
  MAX_FACETS,
  PULL_EXTRAS,
  type ForgeConversation,
  type ForgeConversationItem,
  type ForgeThreadKind,
  type ForgeError,
  type ForgeFile,
  type ForgeFileStatus,
  type ForgeIssue,
  type ForgeIssueState,
  type ForgeMergeOptions,
  type ForgeMerged,
  type ForgePage,
  type ForgePull,
  type ForgeRepo,
  type ForgeRepository,
  type ListOptions,
  type RepositoryListOptions,
  MAX_BODY,
  MAX_CONVERSATION_PAGES,
  MAX_FILES,
  MAX_LIMIT,
  MAX_NUMBER,
  type MergeInput,
  type ForgePullSnapshot,
  ForgeError as ForgeErrorClass,
  forgeError,
  rollupOf,
  validRefName,
  validSha,
  pagePollInterval,
} from "./types";
import {
  type IssueNode,
  type PullNode,
  detailDocument,
  issueFromNode,
  mapSearch,
  planSearch,
  pullFromNode,
  searchDocument,
  searchVariables,
} from "./github-search";
import type { PullParent } from "@armadra/shared";
import {
  PARENT_DOCUMENT,
  SNAPSHOT_DOCUMENT,
  type SnapshotData,
  parentOf,
  snapshotFromNode,
} from "./github-snapshot";
import { hexColor, names, pageSize, text } from "./wire";
import {
  type WireRepository,
  fromWireRepository,
  present,
  repositoryLimit,
} from "./repositories";

function ms(value: bigint): number {
  return Number(value);
}

function msOrNull(value: bigint): number | null {
  return value > 0n ? Number(value) : null;
}

export function fromGithubIssue(issue: GithubIssue): ForgeIssue {
  return {
    number: Number(issue.number),
    title: issue.title,
    body: issue.body,
    state: issue.state === GithubIssueState.CLOSED ? "closed" : "open",
    author: issue.author?.login || null,
    labels: issue.labels.map((label) => label.name),
    commentCount: Number(issue.commentCount),
    url: issue.htmlUrl,
    createdAtMs: ms(issue.createdAtUnixMs),
    updatedAtMs: ms(issue.updatedAtUnixMs),
    closedAtMs: msOrNull(issue.closedAtUnixMs),
    assignees: issue.assignees.map((user) => user.login).filter(Boolean),
    milestone: issue.milestone?.title ? issue.milestone.title : null,
    linkedPulls: 0,
  };
}

/**
 * `detail`：来自单条读取（REST 的详情带增删行与提交数）；列表的 REST 记录不带，
 * 这些字段就留 `null`，免得把「没给」当成 0。
 */
export function fromGithubPull(
  pull: GithubPullRequest,
  detail = false,
): ForgePull {
  const state =
    pull.state === GithubPullState.MERGED
      ? "merged"
      : pull.state === GithubPullState.CLOSED
        ? "closed"
        : "open";
  return {
    ...PULL_EXTRAS,
    labels: pull.labels.map((label) => label.name),
    assignees: [],
    additions: detail ? Number(pull.additions) : null,
    deletions: detail ? Number(pull.deletions) : null,
    changedFiles: detail ? Number(pull.changedFiles) : null,
    commitCount: detail ? Number(pull.commits) : null,
    number: Number(pull.number),
    title: pull.title,
    body: pull.body,
    state,
    draft: pull.draft,
    author: pull.author?.login || null,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    headSha: pull.headSha,
    mergeable:
      pull.mergeable === GithubMergeableState.MERGEABLE
        ? "mergeable"
        : pull.mergeable === GithubMergeableState.CONFLICTING
          ? "conflicting"
          : "unknown",
    url: pull.htmlUrl,
    createdAtMs: ms(pull.createdAtUnixMs),
    updatedAtMs: ms(pull.updatedAtUnixMs),
    mergedAtMs: msOrNull(pull.mergedAtUnixMs),
    // GitHub 的自动合并只在 GraphQL 里；这一面不接。
    autoMerge: false,
    fromFork: pull.fromFork,
  };
}

function fileStatus(value: string): ForgeFileStatus {
  switch (value) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    case "modified":
    case "changed":
      return "modified";
    default:
      return "other";
  }
}

export function fromGithubFile(file: GithubPullFile): ForgeFile {
  return {
    path: file.path,
    previousPath: file.previousPath === "" ? null : file.previousPath,
    status: fileStatus(file.status),
    additions: Number(file.additions),
    deletions: Number(file.deletions),
    patch: file.binary || file.patch === "" ? null : file.patch,
  };
}

function checkState(value: GithubCheckConclusion): ForgeCheckState {
  switch (value) {
    case GithubCheckConclusion.SUCCESS:
      return "success";
    case GithubCheckConclusion.NEUTRAL:
    case GithubCheckConclusion.SKIPPED:
      return "neutral";
    case GithubCheckConclusion.FAILURE:
    case GithubCheckConclusion.CANCELLED:
    case GithubCheckConclusion.TIMED_OUT:
    case GithubCheckConclusion.ACTION_REQUIRED:
    case GithubCheckConclusion.STALE:
      return "failure";
    default:
      return "pending";
  }
}

export function fromGithubChecks(summary: GithubCheckSummary): ForgeChecks {
  const checks = summary.runs.map((run) => ({
    name: run.name,
    state: checkState(run.conclusion),
    url: run.detailsUrl === "" ? null : run.detailsUrl,
  }));
  return { headSha: summary.headSha, rollup: rollupOf(checks), checks };
}

/** GitHub 传输层 / 域层的拒绝 → forge 的种类。 */
export function fromGithubError(error: unknown): ForgeError | unknown {
  if (error instanceof GithubError) {
    switch (error.kind) {
      case "unsupported":
        return forgeError("notConfigured", "NO_CREDENTIAL");
      case "invalid":
        return forgeError("invalid");
      case "permission":
        return forgeError("remoteForbidden");
      case "notFound":
        return forgeError("notFound");
      case "conflict":
        return forgeError("conflict");
      case "rateLimited":
        return forgeError("rateLimited");
      case "unknownOutcome":
        return forgeError("unknownOutcome");
      default:
        return forgeError("unavailable");
    }
  }
  switch (codeOf(error)) {
    case "UNAUTHENTICATED":
      return forgeError("credentialRejected", "TOKEN_REJECTED");
    case "PERMISSION_DENIED":
      return forgeError("remoteForbidden", "FORBIDDEN");
    case "NOT_FOUND":
      return forgeError("notFound", "NOT_FOUND");
    case "CONFLICT":
      return forgeError("conflict", "CONFLICT");
    case "RESOURCE_EXHAUSTED":
      return forgeError("rateLimited", "RATE_LIMITED");
    case "UNKNOWN_OUTCOME":
      return forgeError("unknownOutcome", "UNKNOWN_OUTCOME");
    case "UNAVAILABLE":
      return forgeError("unavailable", "REMOTE_UNAVAILABLE");
    case "INVALID_ARGUMENT":
    case "UNSUPPORTED":
      return forgeError("invalid", "INVALID");
    default:
      return error;
  }
}

function numbered(number: number): bigint {
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_NUMBER) {
    throw forgeError("invalid", "NUMBER_INVALID");
  }
  return BigInt(number);
}

function decodeArray<T>(body: Buffer): T[] {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw forgeError("unavailable", "RESPONSE_MALFORMED");
  }
  if (!Array.isArray(value))
    throw forgeError("unavailable", "RESPONSE_MALFORMED");
  return value as T[];
}

interface WireNote {
  id?: unknown;
  user?: { login?: unknown } | null;
  body?: unknown;
  state?: unknown;
  html_url?: unknown;
  created_at?: unknown;
  submitted_at?: unknown;
}

function noteTime(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 评论 / 评审的一条；缺 id 或时间的丢掉，未提交的评审草稿不算。 */
function toConversationItem(
  value: WireNote,
  prefix: "c" | "r" | "v",
): ForgeConversationItem | undefined {
  const id = typeof value.id === "number" ? value.id : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  const at = noteTime(value.submitted_at ?? value.created_at);
  if (at === 0) return undefined;
  const review = prefix === "v";
  const state =
    typeof value.state === "string" ? value.state.toLowerCase() : "";
  if (review && (state === "pending" || state === "")) return undefined;
  const login = value.user?.login;
  const url = typeof value.html_url === "string" ? value.html_url : "";
  return {
    id: `${prefix}${id}`,
    kind: review ? "review" : "comment",
    author: typeof login === "string" && login !== "" ? login : null,
    body: typeof value.body === "string" ? value.body.slice(0, MAX_BODY) : "",
    state: review ? state : null,
    url: /^https?:\/\//i.test(url) ? url.slice(0, 2048) : "",
    createdAtMs: at,
  };
}

interface WireCommit {
  sha?: unknown;
  html_url?: unknown;
  author?: { login?: unknown } | null;
  commit?: {
    message?: unknown;
    author?: { name?: unknown; date?: unknown } | null;
  } | null;
}

/** GitHub 评审的结论 → 审查者状态；草稿（`PENDING`）与不认识的丢掉。 */
function githubReviewState(value: unknown): ForgeReviewer["state"] | undefined {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changesRequested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    default:
      return undefined;
  }
}

function perPage(limit: number): string {
  return String(limit > 0 && limit <= MAX_LIMIT ? limit : DEFAULT_LIMIT);
}

/**
 * {@link GithubForge} 要用的那一小块：一个配好的 client、核过的仓库引用、时钟，与
 * 「这次请求成没成」的记录。`GithubService`（§5 的那一份凭据）天然满足；按主机
 * 复用本机登录时（契约 §111.6）用 {@link hostGithubAccess} 造一个。
 */
export type GithubAccess = Pick<
  GithubService,
  "client" | "repository" | "now"
> & {
  readonly credentials: Pick<
    GithubService["credentials"],
    "noteSuccess" | "noteFailure"
  >;
};

/**
 * 一个 API 根上的 GitHub 访问，令牌每次现取（本机登录）。引用里的 API 根永远是
 * 这一个，不由请求决定；没有「设置页的失败记录」可写，记录是空操作。
 */
export function hostGithubAccess(
  apiBase: string,
  token: () => Promise<string>,
  options: Omit<GithubClientOptions, "token" | "apiBase"> = {},
  now: () => number = () => Date.now(),
): GithubAccess {
  const client = new GithubClient({ ...options, apiBase, token });
  return {
    client: () => client,
    now,
    repository(ref) {
      if (ref === undefined || !validName(ref.owner) || !validName(ref.name)) {
        throw githubError("invalid");
      }
      return create(GithubRepositoryRefSchema, {
        owner: ref.owner,
        name: ref.name,
        apiBase: client.apiBase(),
        host: webHostFor(client.apiBase()),
      });
    },
    credentials: { noteSuccess: () => undefined, noteFailure: () => undefined },
  };
}

export class GithubForge implements Forge {
  readonly kind = "github" as const;

  constructor(private readonly service: GithubAccess) {}

  /** 配好的 client 与核过的仓库引用；API 根永远来自这台机器的 GitHub 配置。 */
  private target(repo: ForgeRepo): {
    client: GithubClient;
    ref: GithubRepositoryRef;
  } {
    const client = this.service.client();
    const ref = this.service.repository({
      owner: repo.owner,
      name: repo.name,
      apiBase: "",
      host: "",
    });
    return { client, ref };
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      this.service.credentials.noteSuccess();
      return result;
    } catch (error) {
      // 让设置页照旧能说「这个令牌不再工作了」。
      if (!(error instanceof GithubError)) {
        this.service.credentials.noteFailure(error);
      }
      throw fromGithubError(error);
    }
  }

  /** 令牌所属账号能看到的仓库（§29.7）：`GET /user/repos`，最近更新的在前。 */
  repositories(
    host: string,
    options: RepositoryListOptions,
  ): Promise<ForgePage<ForgeRepository>> {
    return this.run(async () => {
      const client = this.service.client();
      const query: Record<string, string> = {
        per_page: String(repositoryLimit(options.limit)),
        sort: "updated",
        affiliation: "owner,collaborator,organization_member",
      };
      if (options.page > 1) query.page = String(options.page);
      const response = await client.get("/user/repos", query);
      return {
        items: present(
          decodeArray<WireRepository>(response.body).map((value) =>
            fromWireRepository(host, "github", value),
          ),
        ),
        nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
      };
    });
  }

  /** 富查询：GraphQL 搜索一次请求拿一页与两个计数（契约 §112.1）。 */
  private async search<T>(
    kind: "issue" | "pull",
    repo: ForgeRepo,
    options: ListOptions & { rich: NonNullable<ListOptions["rich"]> },
    map: (node: IssueNode | PullNode) => T,
  ): Promise<ForgePage<T>> {
    const { client, ref } = this.target(repo);
    const limit = pageSize(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const plan = planSearch(
      kind,
      ref.owner,
      ref.name,
      options.state,
      options.rich,
    );
    const data = await client.graphql(
      searchDocument(kind),
      searchVariables(plan, options.page, limit),
    );
    const result = mapSearch(data, options.page, limit, map);
    return {
      items: result.items,
      nextCursor:
        result.page < result.pageCount ? String(result.page + 1) : null,
      totalCount: result.totalCount,
      openCount: result.openCount,
      closedCount: result.closedCount,
      page: result.page,
      pageCount: result.pageCount,
      unsupported: plan.unsupported,
    };
  }

  /** 单条详情的 GraphQL 补充（指派、里程碑、审查结论、检查、关联…）；失败不拖累详情。 */
  private async extras(
    kind: "issue" | "pull",
    repo: ForgeRepo,
    number: number,
  ): Promise<IssueNode | PullNode | undefined> {
    try {
      const { client, ref } = this.target(repo);
      const data = (await client.graphql(detailDocument(kind), {
        owner: ref.owner,
        name: ref.name,
        number,
      })) as { repository?: { item?: IssueNode | PullNode | null } | null };
      return data?.repository?.item ?? undefined;
    } catch {
      return undefined;
    }
  }

  listIssues(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgeIssue>> {
    return this.run(async () => {
      if (options.rich !== undefined) {
        return this.search(
          "issue",
          repo,
          { ...options, rich: options.rich },
          issueFromNode,
        );
      }
      const { client, ref } = this.target(repo);
      const query: Record<string, string> = {
        state: options.state,
        per_page: perPage(options.limit),
        sort: "updated",
        direction: "desc",
      };
      if (options.page > 1) query.page = String(options.page);
      const response = await client.get(
        `/repos/${ref.owner}/${ref.name}/issues`,
        query,
      );
      const values = decodeArray<WireIssue>(response.body);
      const atMs = this.service.now();
      return {
        items: values
          .filter((value) => !isPullRecord(value))
          .map((value) => fromGithubIssue(toIssue(value, ref, atMs))),
        nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
        ...pagePollInterval(response),
      };
    });
  }

  getIssue(repo: ForgeRepo, number: number): Promise<ForgeIssue> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const result = await api.issue(
        client,
        ref,
        numbered(number),
        this.service.now(),
      );
      const issue = fromGithubIssue(result.issue);
      const extra = await this.extras("issue", repo, number);
      if (extra === undefined) return issue;
      const more = issueFromNode(extra);
      return {
        ...issue,
        assignees: more.assignees,
        milestone: more.milestone,
        linkedPulls: more.linkedPulls,
      };
    });
  }

  setIssueState(
    repo: ForgeRepo,
    number: number,
    state: ForgeIssueState,
  ): Promise<ForgeIssue> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const index = numbered(number);
      // 先读：PR 的编号经 issues 端点也改得动，那不是这个动词的意思。
      await api.issue(client, ref, index, this.service.now());
      const issue = await api.patchIssue(
        client,
        ref,
        index,
        { state },
        this.service.now(),
      );
      return fromGithubIssue(issue);
    });
  }

  listPulls(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgePull>> {
    return this.run(async () => {
      if (options.rich !== undefined) {
        return this.search(
          "pull",
          repo,
          { ...options, rich: options.rich },
          (node) => pullFromNode(node as PullNode),
        );
      }
      const { client, ref } = this.target(repo);
      const query: Record<string, string> = {
        state: options.state,
        per_page: perPage(options.limit),
        sort: "updated",
        direction: "desc",
      };
      if (options.page > 1) query.page = String(options.page);
      const response = await client.get(
        `/repos/${ref.owner}/${ref.name}/pulls`,
        query,
      );
      const values = decodeArray<WirePull>(response.body);
      const atMs = this.service.now();
      return {
        items: values.map((value) =>
          fromGithubPull(toPull(value, ref, [], atMs)),
        ),
        nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
        ...pagePollInterval(response),
      };
    });
  }

  getPull(repo: ForgeRepo, number: number): Promise<ForgePull> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const result = await api.pull(
        client,
        ref,
        numbered(number),
        [],
        this.service.now(),
      );
      const pull = fromGithubPull(result.pull, true);
      const extra = await this.extras("pull", repo, number);
      if (extra === undefined) return pull;
      const more = pullFromNode(extra as PullNode);
      return {
        ...pull,
        assignees: more.assignees,
        milestone: more.milestone,
        commentCount: more.commentCount,
        reviewDecision: more.reviewDecision,
        checks: more.checks,
        linkedIssues: more.linkedIssues,
        authorAssociation: more.authorAssociation,
      };
    });
  }

  /**
   * 快照（契约 §115）。GraphQL 读不到时退回 REST 的 PR：状态照给，评审、检查与
   * 父 PR 记为「没读到」，不假装成「无需评审」。
   */
  pullSnapshot(repo: ForgeRepo, number: number): Promise<ForgePullSnapshot> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      try {
        const data = (await client.graphql(SNAPSHOT_DOCUMENT, {
          owner: ref.owner,
          name: ref.name,
          number,
        })) as SnapshotData;
        const node = data?.repository?.pr;
        if (node === undefined || node === null) throw forgeError("notFound");
        const base = node.baseRefName ?? "";
        const fallback = data?.repository?.defaultBranchRef?.name;
        let parent: PullParent = { kind: "unknown" };
        if (node.state !== "OPEN" || base === "") {
          parent = { kind: "none" };
        } else if (fallback !== undefined && fallback !== "") {
          if (base === fallback) {
            parent = { kind: "none" };
          } else {
            try {
              parent = parentOf(
                await client.graphql(PARENT_DOCUMENT, {
                  owner: ref.owner,
                  name: ref.name,
                  base,
                }),
              );
            } catch {
              parent = { kind: "unknown" };
            }
          }
        }
        return snapshotFromNode(node, parent);
      } catch (error) {
        if (error instanceof ForgeErrorClass && error.kind === "notFound")
          throw error;
        const result = await api.pull(
          client,
          ref,
          numbered(number),
          [],
          this.service.now(),
        );
        const pull = fromGithubPull(result.pull, true);
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
          review: "unknown",
          checks: { read: false },
          mergeable: pull.mergeable,
          parent: { kind: "unknown" },
        };
      }
    });
  }

  createPull(repo: ForgeRepo, input: CreatePullInput): Promise<ForgePull> {
    return this.run(async () => {
      if (!validRefName(input.head) || !validRefName(input.base)) {
        throw forgeError("invalid", "REF_INVALID");
      }
      const { client, ref } = this.target(repo);
      const pull = await api.createPull(
        client,
        ref,
        {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: input.draft,
        },
        [],
        this.service.now(),
      );
      return fromGithubPull(pull, true);
    });
  }

  pullFiles(repo: ForgeRepo, number: number): Promise<readonly ForgeFile[]> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const files = await api.pullFiles(
        client,
        ref,
        numbered(number),
        MAX_FILES,
      );
      return files.map(fromGithubFile);
    });
  }

  checks(repo: ForgeRepo, number: number): Promise<ForgeChecks> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const now = this.service.now();
      const { pull } = await api.pull(client, ref, numbered(number), [], now);
      if (!validSha(pull.headSha)) {
        return { headSha: "", rollup: "none" as const, checks: [] };
      }
      return fromGithubChecks(await api.checks(client, ref, pull.headSha, now));
    });
  }

  conversation(
    repo: ForgeRepo,
    number: number,
    kind: ForgeThreadKind = "pull",
  ): Promise<ForgeConversation> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const index = numbered(number);
      let intervalSec = 0;
      const read = async (
        suffix: string,
        prefix: "c" | "r" | "v",
      ): Promise<ForgeConversationItem[]> => {
        const items: ForgeConversationItem[] = [];
        let page = 1;
        for (let pages = 0; pages < MAX_CONVERSATION_PAGES; pages += 1) {
          const query: Record<string, string> = { per_page: "100" };
          if (page > 1) query.page = String(page);
          const response = await client.get(
            `/repos/${ref.owner}/${ref.name}/${suffix}`,
            query,
          );
          intervalSec = Math.max(intervalSec, response.pollIntervalSec ?? 0);
          for (const value of decodeArray<WireNote>(response.body)) {
            const item = toConversationItem(value, prefix);
            if (item !== undefined) items.push(item);
          }
          if (response.nextPage <= page) break;
          page = response.nextPage;
        }
        return items;
      };
      const items = [
        ...(await read(`issues/${index}/comments`, "c")),
        // issue 没有行内评论与评审。
        ...(kind === "issue"
          ? []
          : [
              ...(await read(`pulls/${index}/comments`, "r")),
              ...(await read(`pulls/${index}/reviews`, "v")),
            ]),
      ].sort((a, b) => a.createdAtMs - b.createdAtMs);
      return {
        items,
        pollIntervalMs: intervalSec > 0 ? intervalSec * 1000 : null,
      };
    });
  }

  /**
   * 审查者：各人最新的一次评审（草稿不算；只留评论的不盖掉先前的通过 / 要求修改），
   * 加上还在等的被请求者（`pending`，盖过旧结论：重新请求就是又在等）。
   */
  pullReviewers(
    repo: ForgeRepo,
    number: number,
  ): Promise<readonly ForgeReviewer[]> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const index = numbered(number);
      const byLogin = new Map<string, ForgeReviewer>();
      let page = 1;
      for (let pages = 0; pages < MAX_CONVERSATION_PAGES; pages += 1) {
        const query: Record<string, string> = { per_page: "100" };
        if (page > 1) query.page = String(page);
        const response = await client.get(
          `/repos/${ref.owner}/${ref.name}/pulls/${index}/reviews`,
          query,
        );
        for (const value of decodeArray<WireNote>(response.body)) {
          const login = value.user?.login;
          const state = githubReviewState(value.state);
          const at = noteTime(value.submitted_at);
          if (typeof login !== "string" || login === "" || state === undefined)
            continue;
          const before = byLogin.get(login);
          if (
            state === "commented" &&
            before !== undefined &&
            before.state !== "commented"
          ) {
            continue;
          }
          byLogin.set(login, {
            login,
            state,
            submittedAtMs: at === 0 ? null : at,
          });
        }
        if (response.nextPage <= page) break;
        page = response.nextPage;
      }
      const requested = await client.get(
        `/repos/${ref.owner}/${ref.name}/pulls/${index}/requested_reviewers`,
      );
      const users = (
        JSON.parse(requested.body.toString("utf8")) as {
          users?: { login?: unknown }[];
        }
      ).users;
      for (const login of names(users, (user) =>
        text((user as { login?: unknown }).login, 128),
      )) {
        byLogin.set(login, { login, state: "pending", submittedAtMs: null });
      }
      return [...byLogin.values()];
    });
  }

  pullCommits(
    repo: ForgeRepo,
    number: number,
  ): Promise<readonly ForgeCommit[]> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const index = numbered(number);
      const commits: ForgeCommit[] = [];
      let page = 1;
      for (
        let pages = 0;
        pages < 3 && commits.length < MAX_COMMITS;
        pages += 1
      ) {
        const query: Record<string, string> = { per_page: "100" };
        if (page > 1) query.page = String(page);
        const response = await client.get(
          `/repos/${ref.owner}/${ref.name}/pulls/${index}/commits`,
          query,
        );
        for (const value of decodeArray<WireCommit>(response.body)) {
          const sha = typeof value.sha === "string" ? value.sha : "";
          if (!validSha(sha)) continue;
          const message =
            typeof value.commit?.message === "string"
              ? value.commit.message
              : "";
          const login = value.author?.login;
          const name = value.commit?.author?.name;
          const author =
            typeof login === "string" && login !== ""
              ? login
              : typeof name === "string" && name !== ""
                ? name.slice(0, 256)
                : null;
          const url =
            typeof value.html_url === "string" &&
            /^https?:\/\//i.test(value.html_url)
              ? value.html_url.slice(0, 2048)
              : "";
          commits.push({
            sha,
            title: (message.split("\n")[0] ?? "").slice(0, 512),
            author,
            authoredAtMs: noteTime(value.commit?.author?.date),
            url,
          });
        }
        if (response.nextPage <= page) break;
        page = response.nextPage;
      }
      return commits.slice(0, MAX_COMMITS);
    });
  }

  facets(repo: ForgeRepo): Promise<ForgeFacets> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const read = async (
        suffix: string,
        query: Record<string, string>,
      ): Promise<unknown[]> => {
        const items: unknown[] = [];
        let page = 1;
        for (
          let pages = 0;
          pages < 2 && items.length < MAX_FACETS;
          pages += 1
        ) {
          const response = await client.get(
            `/repos/${ref.owner}/${ref.name}/${suffix}`,
            {
              ...query,
              per_page: "100",
              ...(page > 1 ? { page: String(page) } : {}),
            },
          );
          items.push(...decodeArray<unknown>(response.body));
          if (response.nextPage <= page) break;
          page = response.nextPage;
        }
        return items.slice(0, MAX_FACETS);
      };
      const [labels, milestones, assignees] = await Promise.all([
        read("labels", {}),
        read("milestones", { state: "all" }),
        // 能指派的人只是下拉的候选；没权限读就空着。
        read("assignees", {}).catch(() => [] as unknown[]),
      ]);
      return {
        labels: labels
          .map((item) => item as { name?: unknown; color?: unknown })
          .filter((item) => typeof item.name === "string" && item.name !== "")
          .map((item) => ({
            name: text(item.name, 128),
            color: hexColor(item.color),
          })),
        milestones: milestones
          .map((item) => item as { title?: unknown; state?: unknown })
          .filter((item) => typeof item.title === "string" && item.title !== "")
          .map((item) => ({
            title: text(item.title, 256),
            open: item.state !== "closed",
          })),
        assignees: names(assignees, (user) =>
          text((user as { login?: unknown })?.login, 128),
        ),
      };
    });
  }

  merge(
    repo: ForgeRepo,
    number: number,
    input: MergeInput,
  ): Promise<ForgeMerged> {
    return this.run(async () => {
      if (!validSha(input.headSha)) throw forgeError("invalid", "SHA_INVALID");
      const { client, ref } = this.target(repo);
      // GitHub 自己核 `sha`：head 动过就 409，不会合进评审者没看到的东西。
      const sha = await api.merge(
        client,
        ref,
        numbered(number),
        input.headSha,
        input.method,
        "",
        "",
      );
      return { merged: true as const, sha };
    });
  }

  async mergeOptions(_repo: ForgeRepo): Promise<ForgeMergeOptions> {
    return { methods: ALL_MERGE_METHODS, autoMerge: false, mergeTrain: false };
  }
}
