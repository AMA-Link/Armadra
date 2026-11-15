import type {
  ForgeListState,
  ForgeRepo,
  ForgeScope,
  ForgeSort,
} from "../../api/forge";

/** 列表请求里随筛选变化的部分；缺省是「无搜索、按更新倒序、第 1 页」。 */
export interface ForgeListKey {
  q: string;
  sort: ForgeSort;
  direction: "asc" | "desc";
  page: number;
  cursor: string | null;
}
export const DEFAULT_LIST_KEY: ForgeListKey = {
  q: "",
  sort: "updated",
  direction: "desc",
  page: 1,
  cursor: null,
};

/** 仓库加范围：两个工作空间对同一仓库可能用不同的配置（契约 §75）。 */
function repoKey(repo: ForgeRepo, scope: ForgeScope): string {
  return `${scope ?? ""}|${repo.host}/${repo.owner}/${repo.name}`;
}

export const forgeKeys = {
  all: ["forge"] as const,
  issues: (
    repo: ForgeRepo,
    state: ForgeListState,
    scope: ForgeScope = null,
    list: ForgeListKey = DEFAULT_LIST_KEY,
  ) => ["forge", "issues", repoKey(repo, scope), state, list] as const,
  issue: (repo: ForgeRepo, number: number, scope: ForgeScope = null) =>
    ["forge", "issue", repoKey(repo, scope), number] as const,
  issueComments: (repo: ForgeRepo, number: number, scope: ForgeScope = null) =>
    ["forge", "issue-comments", repoKey(repo, scope), number] as const,
  pulls: (
    repo: ForgeRepo,
    state: ForgeListState,
    scope: ForgeScope = null,
    list: ForgeListKey = DEFAULT_LIST_KEY,
  ) => ["forge", "pulls", repoKey(repo, scope), state, list] as const,
  facets: (repo: ForgeRepo, scope: ForgeScope = null) =>
    ["forge", "facets", repoKey(repo, scope)] as const,
  pullReviewers: (repo: ForgeRepo, number: number) =>
    ["forge", "pull-reviewers", repoKey(repo, null), number] as const,
  pullCommits: (repo: ForgeRepo, number: number) =>
    ["forge", "pull-commits", repoKey(repo, null), number] as const,
  pull: (repo: ForgeRepo, number: number, scope: ForgeScope = null) =>
    ["forge", "pull", repoKey(repo, scope), number] as const,
  pullComments: (repo: ForgeRepo, number: number, scope: ForgeScope = null) =>
    ["forge", "pull-comments", repoKey(repo, scope), number] as const,
  pullFiles: (repo: ForgeRepo, number: number) =>
    ["forge", "pull-files", repoKey(repo, null), number] as const,
  pullChecks: (repo: ForgeRepo, number: number) =>
    ["forge", "pull-checks", repoKey(repo, null), number] as const,
};

/** 时间戳 → 本地化的日期时间；没有时间给空串。 */
export function when(ms: number | null, locale: string): string {
  if (!ms || ms <= 0) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}
