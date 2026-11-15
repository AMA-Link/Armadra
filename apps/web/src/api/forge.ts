import {
  type ConfigurableForge,
  type ForgeAccount,
  type ForgeRepository,
  type ForgeRepositoryPage,
  forgeAccountListSchema,
  forgeRepositoryPageSchema,
  type ForgeConfig,
  type ForgeDetection,
  type ForgeIssue,
  type ForgePull,
  type ForgeRepo,
  forgeChecksSchema,
  forgeConfigListSchema,
  forgeConfigSchema,
  forgeDetectionSchema,
  forgeFilesSchema,
  forgeKindSchema,
  forgeAutoMergeSchema,
  forgeBranchDeletionSchema,
  forgeIssueSchema,
  forgeMergeOptionsSchema,
  forgeMergedSchema,
  forgePullSchema,
} from "@armadra/shared";
import { z } from "zod";

import { currentClient } from "./client";
import { RuntimeConnectionError, RuntimeRequestError } from "./request";

/**
 * 托管平台面（契约 §29）：Gitea / Forgejo 与 GitLab 的 issue、PR（GitLab 的
 * merge request）、配置。GitHub 仓库仍走 `api/github.ts`（§5）——这里只用
 * `resolve` 认出它是 GitHub，然后把面板交还给那一面。
 *
 * 令牌只在 `putForgeConfig` 里出去一次；任何答复都不带它。
 *
 * 调用经 RPC 客户端（`client.forge.*`，契约 §41.2），发往当前源；答案仍过页面自己
 * 的 schema。
 */

export type {
  ConfigurableForge,
  ForgeAccount,
  ForgeRepository,
  ForgeRepositoryPage,
  ForgeConfig,
  ForgeDetection,
  ForgeIssue,
  ForgePull,
  ForgeRepo,
};
export type ForgeChecks = z.infer<typeof forgeChecksSchema>;
export type ForgeFile = z.infer<typeof forgeFilesSchema>["files"][number];
export type ForgeListState = "open" | "closed" | "all";
export type ForgeMergeMethod = "merge" | "squash" | "rebase";

/** 页面认得的拒绝。认不出的落在 `failed`，不软化成别的。 */
export type ForgeFailure =
  | "notConfigured"
  | "credentialRejected"
  | "forbidden"
  | "scope"
  | "notFound"
  | "conflict"
  | "rateLimited"
  | "unknownOutcome"
  | "rebaseStarted"
  | "invalid"
  | "unavailable"
  | "unsupported"
  | "network"
  | "failed";

export function forgeFailure(error: unknown): ForgeFailure {
  if (error instanceof RuntimeConnectionError) return "network";
  if (!(error instanceof RuntimeRequestError)) return "failed";
  switch (error.code) {
    case "forge_not_configured":
      return "notConfigured";
    case "forge_credential_rejected":
      return "credentialRejected";
    case "forge_forbidden":
    case "forbidden":
      return "forbidden";
    case "forge_scope":
      return "scope";
    case "not_found":
      return "notFound";
    case "conflict":
      return "conflict";
    case "rate_limited":
      return "rateLimited";
    case "unknown_outcome":
      return "unknownOutcome";
    case "rebase_started":
      return "rebaseStarted";
    case "bad_request":
      return "invalid";
    case "forge_unavailable":
      return "unavailable";
    default:
      // 没装托管平台域的 core（库没过统一迁移）答 501 / 404。
      return error.status === 501 || error.status === 404
        ? "unsupported"
        : "failed";
  }
}

/** i18n 键：`forge.failure.<种类>`。 */
export function forgeFailureKey(error: unknown): string {
  return `forge.failure.${forgeFailure(error)}`;
}

/**
 * 配置行的键：`<host>` 或 `<host>/<owner>/<name>` → 一对 procedure 的入参。owner
 * 可以是多级子组（`<host>/group/sub/name`）：首段是主机、末段是名字，中间整条
 * 作 owner（线上编码成路径的一段，契约 §41.2）。
 */
export function configTarget(
  repoKey: string,
): { host: string } | { host: string; owner: string; name: string } {
  const parts = repoKey.split("/");
  if (parts.length < 3) return { host: parts.join("/") };
  return {
    host: parts[0] ?? "",
    owner: parts.slice(1, -1).join("/"),
    name: parts[parts.length - 1] ?? "",
  };
}

/** 当前源的 `forge.*`（契约 §41.2）；换了源，后面的调用就发往新的源。 */
const rpc = () => currentClient().forge;

/**
 * 托管配置的范围（契约 §75）：某个工作空间自己的那份，`null` 是整台机器。读与
 * 识别带上它时先用工作空间的配置，没有再用整机的。
 */
export type ForgeScope = string | null;

function scoped(workspaceId: ForgeScope | undefined): {
  workspaceId?: string;
} {
  return workspaceId ? { workspaceId } : {};
}

/** 一个 git 远端地址 → 识别结果。地址在请求体里：它可能带凭据。 */
export async function resolveForge(
  remoteUrl: string,
  workspaceId: ForgeScope = null,
): Promise<ForgeDetection> {
  return forgeDetectionSchema.parse(
    await rpc().resolve({ remoteUrl, ...scoped(workspaceId) }),
  );
}

/** 一个已知仓库（外部连接里记着的那个）→ 识别结果。 */
export async function detectForge(
  repo: ForgeRepo,
  workspaceId: ForgeScope = null,
): Promise<ForgeDetection> {
  return forgeDetectionSchema.parse(
    await rpc().detect({ ...repo, ...scoped(workspaceId) }),
  );
}

/**
 * 能列仓库的账号（契约 §29.7）：配了凭据的 GitHub 与带令牌的主机级 Gitea /
 * GitLab 配置。新建工作空间先用它列出可选的来源。
 */
export async function forgeAccounts(): Promise<ForgeAccount[]> {
  return forgeAccountListSchema.parse(await rpc().accounts({})).accounts;
}

/**
 * 一个账号能看到的仓库，一页（契约 §29.7）：每行带 `cloneUrl`（http(s)）与
 * `sshUrl`（可能为 `""`），最近更新的在前。`cursor` 是上一页的 `nextCursor`。
 */
export async function forgeRepositories(
  host: string,
  cursor: string | null = null,
  limit?: number,
): Promise<ForgeRepositoryPage> {
  return forgeRepositoryPageSchema.parse(
    await rpc().repositories({
      host,
      ...(cursor ? { cursor } : {}),
      ...(limit === undefined ? {} : { limit }),
    }),
  );
}

/** 一个范围的配置行：整台机器，或某个工作空间自己的（§75）。 */
export async function forgeConfigs(
  workspaceId: ForgeScope = null,
): Promise<ForgeConfig[]> {
  return forgeConfigListSchema.parse(await rpc().configs(scoped(workspaceId)))
    .configs;
}

export async function putForgeConfig(
  repoKey: string,
  input: {
    forge: ConfigurableForge;
    apiBase: string;
    token?: string;
    expectedRevision: number;
  },
  workspaceId: ForgeScope = null,
): Promise<ForgeConfig> {
  const target = { ...configTarget(repoKey), ...scoped(workspaceId) };
  return forgeConfigSchema.parse(
    "owner" in target
      ? await rpc().putRepoConfig({ ...target, ...input })
      : await rpc().putHostConfig({ ...target, ...input }),
  );
}

export async function deleteForgeConfig(
  repoKey: string,
  expectedRevision: number,
  workspaceId: ForgeScope = null,
): Promise<void> {
  const target = { ...configTarget(repoKey), ...scoped(workspaceId) };
  if ("owner" in target) {
    await rpc().removeRepoConfig({ ...target, expectedRevision });
  } else {
    await rpc().removeHostConfig({ ...target, expectedRevision });
  }
}

export async function forgeIssues(
  repo: ForgeRepo,
  state: ForgeListState,
  cursor: string | null = null,
  workspaceId: ForgeScope = null,
  options: ForgeListOptions = {},
) {
  return forgeIssuePageExtSchema.parse(
    await searchRpc().issues({
      ...repo,
      state,
      ...(cursor ? { cursor } : {}),
      ...listOptions(options),
      ...scoped(workspaceId),
    }),
  );
}

export async function forgeIssue(
  repo: ForgeRepo,
  number: number,
  workspaceId: ForgeScope = null,
) {
  return forgeIssueExtSchema.parse(
    await rpc().issue({ ...repo, number, ...scoped(workspaceId) }),
  );
}

export async function setForgeIssueState(
  repo: ForgeRepo,
  number: number,
  state: "open" | "closed",
) {
  return forgeIssueSchema.parse(
    await rpc().setIssueState({ ...repo, number, state }),
  );
}

export async function forgePulls(
  repo: ForgeRepo,
  state: ForgeListState,
  cursor: string | null = null,
  workspaceId: ForgeScope = null,
  options: ForgeListOptions = {},
) {
  return forgePullPageExtSchema.parse(
    await searchRpc().pulls({
      ...repo,
      state,
      ...(cursor ? { cursor } : {}),
      ...listOptions(options),
      ...scoped(workspaceId),
    }),
  );
}

export async function forgePull(
  repo: ForgeRepo,
  number: number,
  workspaceId: ForgeScope = null,
) {
  return forgePullExtSchema.parse(
    await rpc().pull({ ...repo, number, ...scoped(workspaceId) }),
  );
}

export async function createForgePull(
  repo: ForgeRepo,
  input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  },
) {
  return forgePullSchema.parse(await rpc().createPull({ ...repo, ...input }));
}

export async function forgePullFiles(repo: ForgeRepo, number: number) {
  return forgeFilesSchema.parse(await rpc().pullFiles({ ...repo, number }))
    .files;
}

export async function forgePullChecks(repo: ForgeRepo, number: number) {
  return forgeChecksSchema.parse(await rpc().pullChecks({ ...repo, number }));
}

export async function mergeForgePull(
  repo: ForgeRepo,
  number: number,
  input: { method: ForgeMergeMethod; headSha: string },
) {
  return forgeMergedSchema.parse(
    await rpc().merge({ ...repo, number, ...input }),
  );
}

export type ForgeMergeOptions = z.infer<typeof forgeMergeOptionsSchema>;

/** 这个仓库现在能用的合并方式与自动合并（GitLab 按项目设置，§29.6）。 */
export async function forgeMergeOptions(
  repo: ForgeRepo,
): Promise<ForgeMergeOptions> {
  return forgeMergeOptionsSchema.parse(await rpc().mergeOptions(repo));
}

/** 流水线通过后合并（GitLab）；项目开了合并列车时排进列车。 */
export async function autoMergeForgePull(
  repo: ForgeRepo,
  number: number,
  input: { method: ForgeMergeMethod; headSha: string },
) {
  return forgeAutoMergeSchema.parse(
    await rpc().autoMerge({ ...repo, number, ...input }),
  );
}

export async function cancelAutoMergeForgePull(
  repo: ForgeRepo,
  number: number,
): Promise<void> {
  await rpc().cancelAutoMerge({ ...repo, number });
}

/**
 * 合并后删源分支（Gitea / GitLab）：带页面上显示的 head；分支动过、受保护、
 * 来自 fork 或还没合并时答 `{ deleted: false, reasonCode }` 而不是照删。
 */
export async function deleteForgeBranch(
  repo: ForgeRepo,
  number: number,
  headSha: string,
) {
  return forgeBranchDeletionSchema.parse(
    await rpc().deleteBranch({ ...repo, number, headSha }),
  );
}

/* ------------- 搜索、筛选与审查（#934，形状见 plans/forge-search） ------------- */

/**
 * 列表的新字段一律可选并带缺省：旧 core 不给时照常渲染。契约类型随 core 一条线
 * 落进 `@armadra/shared` 之前，页面在这里扩展基础 schema。
 */
export const forgeReviewDecisionSchema = z
  .enum(["approved", "changesRequested", "reviewRequired"])
  .nullable();
export type ForgeReviewDecision = z.infer<typeof forgeReviewDecisionSchema>;

export const forgeChecksRollupSchema = z.object({
  rollup: z.enum(["pending", "success", "failure", "neutral", "none"]),
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ForgeChecksRollup = z.infer<typeof forgeChecksRollupSchema>;

const count = z.number().int().nonnegative().nullable().default(null);

export const forgeIssueExtSchema = forgeIssueSchema.extend({
  assignees: z.array(z.string()).default([]),
  milestone: z.string().nullable().default(null),
  linkedPulls: z.number().int().nonnegative().default(0),
});
export type ForgeIssueItem = z.infer<typeof forgeIssueExtSchema>;

export const forgePullExtSchema = forgePullSchema.extend({
  labels: z.array(z.string()).default([]),
  assignees: z.array(z.string()).default([]),
  milestone: z.string().nullable().default(null),
  commentCount: z.number().int().nonnegative().default(0),
  reviewDecision: forgeReviewDecisionSchema.default(null),
  checks: forgeChecksRollupSchema.nullable().default(null),
  additions: count,
  deletions: count,
  changedFiles: count,
  commitCount: count,
  linkedIssues: z.array(z.number().int().positive()).default([]),
  authorAssociation: z.string().nullable().default(null),
});
export type ForgePullItem = z.infer<typeof forgePullExtSchema>;

const pageFields = {
  nextCursor: z.string().nullable(),
  totalCount: count,
  openCount: count,
  closedCount: count,
  page: count,
  pageCount: count,
  unsupported: z.array(z.string()).default([]),
};
export const forgeIssuePageExtSchema = z.object({
  items: z.array(forgeIssueExtSchema),
  ...pageFields,
});
export const forgePullPageExtSchema = z.object({
  items: z.array(forgePullExtSchema),
  ...pageFields,
});
export type ForgeIssuePage = z.infer<typeof forgeIssuePageExtSchema>;
export type ForgePullPage = z.infer<typeof forgePullPageExtSchema>;

export type ForgeSort = "updated" | "created" | "comments";
export interface ForgeListOptions {
  /** 限定词串，如 `label:core author:x sync`；空串不发。 */
  q?: string;
  sort?: ForgeSort;
  direction?: "asc" | "desc";
  /** 1 起；给了 core 就按页码翻、忽略 cursor。 */
  page?: number;
}

function listOptions(options: ForgeListOptions): Record<string, unknown> {
  const q = options.q?.trim();
  return {
    ...(q ? { q } : {}),
    ...(options.sort ? { sort: options.sort } : {}),
    ...(options.direction ? { direction: options.direction } : {}),
    ...(options.page && options.page > 1 ? { page: options.page } : {}),
  };
}

export const forgeReviewerSchema = z.object({
  login: z.string(),
  state: z.enum([
    "approved",
    "changesRequested",
    "commented",
    "pending",
    "dismissed",
  ]),
  submittedAtMs: z.number().int().nullable().default(null),
});
export type ForgeReviewer = z.infer<typeof forgeReviewerSchema>;

export const forgeCommitSchema = z.object({
  sha: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  authoredAtMs: z.number().int(),
  url: z.string(),
});
export type ForgeCommit = z.infer<typeof forgeCommitSchema>;

export const forgeFacetsSchema = z.object({
  labels: z
    .array(z.object({ name: z.string(), color: z.string().nullable() }))
    .default([]),
  milestones: z
    .array(z.object({ title: z.string(), open: z.boolean() }))
    .default([]),
  assignees: z.array(z.string()).default([]),
});
export type ForgeFacets = z.infer<typeof forgeFacetsSchema>;

interface ForgeSearchRpc {
  issues(input: unknown): Promise<unknown>;
  pulls(input: unknown): Promise<unknown>;
  pullReviewers(input: unknown): Promise<unknown>;
  pullCommits(input: unknown): Promise<unknown>;
  facets(input: unknown): Promise<unknown>;
}
const searchRpc = () => rpc() as unknown as ForgeSearchRpc;

export async function forgePullReviewers(
  repo: ForgeRepo,
  number: number,
): Promise<ForgeReviewer[]> {
  return z
    .object({ reviewers: z.array(forgeReviewerSchema) })
    .parse(await searchRpc().pullReviewers({ ...repo, number })).reviewers;
}

export async function forgePullCommits(
  repo: ForgeRepo,
  number: number,
): Promise<ForgeCommit[]> {
  return z
    .object({ commits: z.array(forgeCommitSchema) })
    .parse(await searchRpc().pullCommits({ ...repo, number })).commits;
}

/** 筛选下拉的候选；旧 core 没有这条路由时调用方退回列表里出现过的值。 */
export async function forgeFacets(
  repo: ForgeRepo,
  workspaceId: ForgeScope = null,
): Promise<ForgeFacets> {
  return forgeFacetsSchema.parse(
    await searchRpc().facets({ ...repo, ...scoped(workspaceId) }),
  );
}

/* ------------------- 讨论与工作空间仓库（#922，形状见 plans/forge-auto-detect） ------------------- */

export const forgeCredentialSourceSchema = z
  .enum(["ghCli", "glab", "tea", "gitCredential", "stored"])
  .nullable();
export type ForgeCredentialSource = z.infer<typeof forgeCredentialSourceSchema>;

/** 现有识别结果加令牌来源；旧 core 不给来源时为 `null`。 */
export const forgeDetectionExtSchema = forgeDetectionSchema.extend({
  credentialSource: forgeCredentialSourceSchema.default(null),
});
export type ForgeDetectionExt = z.infer<typeof forgeDetectionExtSchema>;

export const forgeConversationItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["comment", "review"]),
  author: z.string().nullable(),
  body: z.string(),
  /** 评审结论（`approved` / `changes_requested` / `commented`）；评论 `null`。 */
  state: z.string().nullable(),
  url: z.string(),
  createdAtMs: z.number().int(),
});
export type ForgeConversationItem = z.infer<typeof forgeConversationItemSchema>;
const forgeConversationSchema = z.object({
  items: z.array(forgeConversationItemSchema),
});

export const workspaceRepositorySchema = z.object({
  reason: z.enum(["ok", "notGit", "noRemote", "remoteHostUnavailable"]),
  selected: z.string().nullable(),
  selectedBy: z
    .enum(["user", "ghResolved", "upstream", "origin", "first"])
    .nullable(),
  remotes: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      detection: forgeDetectionExtSchema.nullable(),
    }),
  ),
});
export type WorkspaceRepository = z.infer<typeof workspaceRepositorySchema>;
export type WorkspaceRemote = WorkspaceRepository["remotes"][number];

export const forgeHostsSchema = z.object({
  reuseLocalLogins: z.boolean(),
  hosts: z.array(
    z.object({
      host: z.string(),
      forge: forgeKindSchema.nullable(),
      credentialSource: forgeCredentialSourceSchema,
      accountLogin: z.string().nullable(),
      credential: z.boolean(),
    }),
  ),
});
export type ForgeHosts = z.infer<typeof forgeHostsSchema>;

/**
 * 这些 procedure 由 core 一条线新增（讨论路由、工作空间仓库、主机表）；契约类型
 * 随它们落进 `@armadra/shared` 之前，页面用这层窄接口调，答案仍过上面的 schema。
 */
interface ForgeAutoRpc {
  issueComments(input: unknown): Promise<unknown>;
  pullComments(input: unknown): Promise<unknown>;
  workspaceRepository(input: unknown): Promise<unknown>;
  selectWorkspaceRemote(input: unknown): Promise<unknown>;
  hosts(input: unknown): Promise<unknown>;
  setReuseLocalLogins(input: unknown): Promise<unknown>;
}
const autoRpc = () => rpc() as unknown as ForgeAutoRpc;

export async function forgeIssueComments(
  repo: ForgeRepo,
  number: number,
  workspaceId: ForgeScope = null,
): Promise<ForgeConversationItem[]> {
  return forgeConversationSchema.parse(
    await autoRpc().issueComments({ ...repo, number, ...scoped(workspaceId) }),
  ).items;
}

export async function forgePullComments(
  repo: ForgeRepo,
  number: number,
  workspaceId: ForgeScope = null,
): Promise<ForgeConversationItem[]> {
  return forgeConversationSchema.parse(
    await autoRpc().pullComments({ ...repo, number, ...scoped(workspaceId) }),
  ).items;
}

/** 工作空间的仓库：各 remote 与选中的那个（打开面板即识别）。 */
export async function forgeWorkspaceRepository(
  workspaceId: string,
): Promise<WorkspaceRepository> {
  return workspaceRepositorySchema.parse(
    await autoRpc().workspaceRepository({ workspaceId }),
  );
}

/** 切换主 remote；`null` 清掉用户的选择。 */
export async function selectWorkspaceRemote(
  workspaceId: string,
  remote: string | null,
): Promise<WorkspaceRepository> {
  return workspaceRepositorySchema.parse(
    await autoRpc().selectWorkspaceRemote({ workspaceId, remote }),
  );
}

export async function forgeHosts(): Promise<ForgeHosts> {
  return forgeHostsSchema.parse(await autoRpc().hosts({}));
}

/** 开关「复用本机登录」；调用方随后重读主机表（答复形状不依赖）。 */
export async function setReuseLocalLogins(enabled: boolean): Promise<void> {
  await autoRpc().setReuseLocalLogins({ enabled });
}

/** 平台显示名：品牌名不翻译。 */
export const FORGE_NAMES: Record<string, string> = {
  github: "GitHub",
  gitea: "Gitea",
  gitlab: "GitLab",
};

/** 问不到 `merge-options`（旧 core）时各平台的合并方式。 */
export function mergeMethods(forge: string): ForgeMergeMethod[] {
  return forge === "gitlab"
    ? ["merge", "squash"]
    : ["merge", "squash", "rebase"];
}
