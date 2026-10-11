import type {
  ForgeConfig,
  ForgeDetection,
  ForgeIssue,
  ForgePull,
} from "../../api/forge";

/**
 * `integration` 分区里托管平台那几张样本的假数据（契约 §29）：一个 Gitea 仓库的
 * issue 与 PR 列表、一个 GitLab merge request 的详情、设置页的配置行。
 * 纯对象；主机名、标题与补丁是数据不是界面文案。
 */

const AT = Date.UTC(2026, 9, 3, 8, 30, 0);
const SHA = "3f2a9c1d7e5b4a6f8c0d2e4f6a8b0c1d2e3f4a5b";

export const GITEA_DETECTION: ForgeDetection = {
  repository: { host: "git.example.test", owner: "acme", name: "app" },
  forge: "gitea",
  source: "config",
  configKey: "git.example.test",
  apiBase: "https://git.example.test/api/v1",
  webUrl: "https://git.example.test/acme/app",
  credential: true,
  accountLogin: "bot",
};

const pull = (
  number: number,
  title: string,
  overrides: Partial<ForgePull> = {},
): ForgePull => ({
  number,
  title,
  body: "",
  state: "open",
  draft: false,
  author: "alice",
  baseRef: "main",
  headRef: "feature/login",
  headSha: SHA,
  mergeable: "mergeable",
  url: "",
  createdAtMs: AT,
  updatedAtMs: AT,
  mergedAtMs: null,
  autoMerge: false,
  fromFork: false,
  ...overrides,
});

const issue = (
  number: number,
  title: string,
  overrides: Partial<ForgeIssue> = {},
): ForgeIssue => ({
  number,
  title,
  body: "",
  state: "open",
  author: "alice",
  labels: [],
  commentCount: 0,
  url: "",
  createdAtMs: AT,
  updatedAtMs: AT,
  closedAtMs: null,
  ...overrides,
});

export const GITEA_ISSUES: ForgeIssue[] = [
  issue(21, "登录后跳回原页面", { labels: ["bug"] }),
  issue(18, "Dark mode for settings", { author: "bob" }),
];

export const GITEA_PULLS: ForgePull[] = [
  pull(14, "登录页拆成两步", { draft: true }),
  pull(13, "Fix header spacing", {
    headRef: "fix/header",
    mergeable: "conflicting",
  }),
  pull(11, "Bump dependencies", {
    headRef: "deps",
    state: "merged",
    mergedAtMs: AT,
  }),
];

export const GITLAB_MR: ForgePull = pull(12, "Login rework", {
  body: "Split the login page into two steps.",
});

export const FORGE_CONFIGS: ForgeConfig[] = [
  {
    repoKey: "git.example.test",
    forge: "gitea",
    apiBase: "https://git.example.test/api/v1",
    credential: true,
    accountLogin: "bot",
    revision: 3,
    createdAtMs: AT,
    updatedAtMs: AT,
  },
  {
    repoKey: "gitlab.example.test/acme/app",
    forge: "gitlab",
    apiBase: "https://gitlab.example.test/api/v4",
    credential: false,
    accountLogin: null,
    revision: 1,
    createdAtMs: AT,
    updatedAtMs: AT,
  },
];
