import type { ForgeListState, ForgeRepo, ForgeScope } from "../../api/forge";

/** 仓库加范围：两个工作空间对同一仓库可能用不同的配置（契约 §75）。 */
function repoKey(repo: ForgeRepo, scope: ForgeScope): string {
  return `${scope ?? ""}|${repo.host}/${repo.owner}/${repo.name}`;
}

export const forgeKeys = {
  all: ["forge"] as const,
  issues: (repo: ForgeRepo, state: ForgeListState, scope: ForgeScope = null) =>
    ["forge", "issues", repoKey(repo, scope), state] as const,
  issue: (repo: ForgeRepo, number: number, scope: ForgeScope = null) =>
    ["forge", "issue", repoKey(repo, scope), number] as const,
  issueComments: (repo: ForgeRepo, number: number, scope: ForgeScope = null) =>
    ["forge", "issue-comments", repoKey(repo, scope), number] as const,
  pulls: (repo: ForgeRepo, state: ForgeListState, scope: ForgeScope = null) =>
    ["forge", "pulls", repoKey(repo, scope), state] as const,
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
