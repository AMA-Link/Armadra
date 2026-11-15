import type {
  WorkspaceRepository,
  ForgeChecks,
  ForgeConfig,
  ForgeConversationItem,
  ForgeFile,
  ForgeDetection,
  ForgeCommit,
  ForgeFacets,
  ForgeIssue,
  ForgePullItem,
  ForgeReviewer,
} from "../../api/forge";
import { forgePullExtSchema } from "../../api/forge";

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
  overrides: Partial<ForgePullItem> = {},
): ForgePullItem =>
  forgePullExtSchema.parse({
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
  assignees: [],
  milestone: null,
  linkedPulls: 0,
  ...overrides,
});

export const GITEA_ISSUES: ForgeIssue[] = [
  issue(21, "登录后跳回原页面", { labels: ["bug"] }),
  issue(18, "Dark mode for settings", { author: "bob" }),
];

export const GITEA_PULLS: ForgePullItem[] = [
  pull(14, "登录页拆成两步", {
    draft: true,
    commentCount: 3,
    checks: { rollup: "pending", passed: 3, total: 7 },
  }),
  pull(13, "Fix header spacing", {
    headRef: "fix/header",
    mergeable: "conflicting",
    labels: ["web"],
    commentCount: 1,
    reviewDecision: "changesRequested",
    checks: { rollup: "failure", passed: 5, total: 7 },
  }),
  pull(10, "Add provider preset", {
    headRef: "feat/preset",
    commentCount: 0,
    reviewDecision: "approved",
    checks: { rollup: "success", passed: 7, total: 7 },
  }),
  pull(11, "Bump dependencies", {
    headRef: "deps",
    state: "merged",
    mergedAtMs: AT,
  }),
];

export const GITLAB_MR: ForgePullItem = pull(12, "Login rework", {
  labels: ["core", "web"],
  assignees: ["alice"],
  milestone: "v0.18.0",
  reviewDecision: "changesRequested",
  additions: 842,
  deletions: 97,
  changedFiles: 3,
  commitCount: 2,
  linkedIssues: [21],
  authorAssociation: "member",
  body: "Split the login page into two steps.\n\n- keep the session\n- add a **back** link\n\nCloses #21",
});

export const GITLAB_REPO = {
  host: "gitlab.example.test",
  owner: "acme",
  name: "app",
};

export const GITLAB_CHECKS: ForgeChecks = {
  headSha: SHA,
  rollup: "failure",
  checks: [
    { name: "lint", state: "success", url: "https://ci.example.test/1" },
    { name: "test", state: "success", url: "https://ci.example.test/2" },
    { name: "build", state: "pending", url: null },
    { name: "e2e", state: "failure", url: "https://ci.example.test/4" },
  ],
};

export const GITLAB_FILES: ForgeFile[] = [
  {
    path: "src/login.ts",
    previousPath: null,
    status: "added",
    additions: 48,
    deletions: 0,
    patch: null,
  },
  {
    path: "src/session.ts",
    previousPath: null,
    status: "modified",
    additions: 12,
    deletions: 5,
    patch: null,
  },
  {
    path: "src/legacy-login.ts",
    previousPath: null,
    status: "removed",
    additions: 0,
    deletions: 31,
    patch: null,
  },
];

export const GITLAB_COMMENTS: ForgeConversationItem[] = [
  {
    id: "r1",
    kind: "review",
    author: "bob",
    body: "Looks good, one nit on naming.",
    state: "approved",
    url: "",
    createdAtMs: AT,
  },
  {
    id: "r2",
    kind: "review",
    author: "carol",
    body: "The back link loses the form state.",
    state: "changes_requested",
    url: "",
    createdAtMs: AT,
  },
  {
    id: "c1",
    kind: "comment",
    author: "alice",
    body: "Fixed in the next push.",
    state: null,
    url: "",
    createdAtMs: AT,
  },
];

export const GITEA_ISSUE_DETAIL: ForgeIssue = issue(21, "登录后跳回原页面", {
  labels: ["bug"],
  commentCount: 2,
  body: "登录成功后应该回到之前的页面。\n\n1. 打开 `/settings`\n2. 登录\n3. 落在首页",
});

export const GITEA_ISSUE_COMMENTS: ForgeConversationItem[] = [
  {
    id: "i1",
    kind: "comment",
    author: "bob",
    body: "Reproduced on 0.17.3.",
    state: null,
    url: "",
    createdAtMs: AT,
  },
  {
    id: "i2",
    kind: "comment",
    author: "alice",
    body: "Fix is in #14.",
    state: null,
    url: "",
    createdAtMs: AT,
  },
];

export const FORGE_CONFIGS: ForgeConfig[] = [
  {
    workspaceId: null,
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
    workspaceId: null,
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

/** fork 工作空间：upstream 是默认，origin 缺令牌。 */
export const WORKSPACE_REPOSITORY: WorkspaceRepository = {
  reason: "ok",
  selected: "upstream",
  selectedBy: "upstream",
  remotes: [
    {
      name: "origin",
      url: "https://git.example.test/alice/app.git",
      detection: {
        ...GITEA_DETECTION,
        repository: { host: "git.example.test", owner: "alice", name: "app" },
        credential: false,
        accountLogin: null,
        credentialSource: null,
      },
    },
    {
      name: "upstream",
      url: "https://git.example.test/acme/app.git",
      detection: { ...GITEA_DETECTION, credentialSource: "stored" },
    },
  ],
};

export const GITLAB_REVIEWERS: ForgeReviewer[] = [
  { login: "bob", state: "approved", submittedAtMs: AT },
  { login: "carol", state: "changesRequested", submittedAtMs: AT },
];

export const GITLAB_COMMITS: ForgeCommit[] = [
  {
    sha: "a1b2c3d4e5f6a7b8c9d0",
    title: "feat(login): split into two steps",
    author: "alice",
    authoredAtMs: AT,
    url: "https://gitlab.example.test/acme/app/-/commit/a1b2c3d",
  },
  {
    sha: "0f9e8d7c6b5a4f3e2d1c",
    title: "fix(session): keep it across steps",
    author: "alice",
    authoredAtMs: AT,
    url: "https://gitlab.example.test/acme/app/-/commit/0f9e8d7",
  },
];

export const GITEA_FACETS: ForgeFacets = {
  labels: [
    { name: "bug", color: null },
    { name: "web", color: null },
  ],
  milestones: [{ title: "v0.18.0", open: true }],
  assignees: ["alice", "bob"],
};
