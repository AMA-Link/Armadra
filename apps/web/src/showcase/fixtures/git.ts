import type { GitLogCommit } from "@armadra/shared";

/**
 * `git` 分区的样例（#927）：三个仓库按时间交错的一页日志，主线全是 PR 合并，
 * 合并的第二父各带一到两个分支提交——正是「按合并折叠」要处理的形状。
 * oid 只要互不相同，内容随意。
 */
const oid = (seed: string) => seed.padEnd(40, "0");

interface Spec {
  repo: string;
  id: string;
  parents: string[];
  subject: string;
  at: string;
  refs?: string[];
}

const SPECS: Spec[] = [
  {
    repo: ".",
    id: "a1",
    parents: ["a2", "a1b"],
    subject: "Merge pull request #78 from AMA-Link/docs/iphone-0173",
    at: "2026-11-13T20:10:00Z",
    refs: ["HEAD -> refs/heads/main"],
  },
  {
    repo: ".",
    id: "a1b",
    parents: ["a2"],
    subject: "docs(workspace): 进展总表记 iPhone 已补装 v0.17.3",
    at: "2026-11-13T20:02:00Z",
  },
  {
    repo: "Armadra",
    id: "b1",
    parents: ["b2", "b1b"],
    subject: "Merge pull request #920 from AMA-Link/release/v0.17.3",
    at: "2026-11-13T09:12:00Z",
    refs: ["HEAD -> refs/heads/main", "refs/tags/v0.17.3"],
  },
  {
    repo: "Armadra",
    id: "b1b",
    parents: ["b1c"],
    subject: "chore(release): 第三方声明随 agent 0.17.3 重新生成",
    at: "2026-11-13T09:02:00Z",
  },
  {
    repo: "Armadra",
    id: "b1c",
    parents: ["b2"],
    subject: "docs(changelog): 0.17.3",
    at: "2026-11-13T08:40:00Z",
  },
  {
    repo: "armadra-cloud",
    id: "c1",
    parents: ["c2", "c1b"],
    subject: "Merge pull request #231 from AMA-Link/release/v0.17.3",
    at: "2026-11-13T08:30:00Z",
    refs: ["HEAD -> refs/heads/main"],
  },
  {
    repo: "armadra-cloud",
    id: "c1b",
    parents: ["c2"],
    subject: "chore(protocol): 协议包版本号 0.17.3",
    at: "2026-11-13T08:21:00Z",
  },
  {
    repo: "Armadra",
    id: "b2",
    parents: ["b3", "b2b"],
    subject: "Merge pull request #919 from AMA-Link/chore/minimatch-11",
    at: "2026-11-13T08:21:00Z",
  },
  {
    repo: "Armadra",
    id: "b2b",
    parents: ["b2c"],
    subject: "chore(deps): minimatch 升到 11.0.4，去掉旧 override",
    at: "2026-11-13T07:46:00Z",
  },
  {
    repo: "Armadra",
    id: "b2c",
    parents: ["b3"],
    subject: "fix(tools): glob 调用改用新签名",
    at: "2026-11-13T07:31:00Z",
  },
  {
    repo: ".",
    id: "a2",
    parents: ["a3", "a2b"],
    subject:
      "Merge pull request #77 from AMA-Link/fix/agent-release-no-unreleased",
    at: "2026-11-13T07:20:00Z",
  },
  {
    repo: ".",
    id: "a2b",
    parents: ["a3"],
    subject: "fix(scripts): agent 发版脚本补一条对齐版本的维护条目",
    at: "2026-11-13T07:05:00Z",
  },
  {
    repo: "Armadra",
    id: "b3",
    parents: ["b4", "b3b"],
    subject:
      "Merge pull request #917 from AMA-Link/chore/drop-pre-011-version-fallback",
    at: "2026-11-13T07:10:00Z",
  },
  {
    repo: "Armadra",
    id: "b3b",
    parents: ["b4"],
    subject: "chore(core): 控制面版本门去掉旧版本兜底",
    at: "2026-11-13T06:40:00Z",
  },
  {
    repo: "armadra-cloud",
    id: "c2",
    parents: ["c3", "c2b"],
    subject: "Merge pull request #229 from AMA-Link/feat/relay-heartbeat",
    at: "2026-11-12T22:00:00Z",
  },
  {
    repo: "armadra-cloud",
    id: "c2b",
    parents: ["c2c"],
    subject: "feat(relay): heartbeat 间隔读环境变量",
    at: "2026-11-12T21:40:00Z",
  },
  {
    repo: "armadra-cloud",
    id: "c2c",
    parents: ["c3"],
    subject: "test(relay): 补心跳超时测试",
    at: "2026-11-12T21:30:00Z",
  },
  {
    repo: "Armadra",
    id: "b4",
    parents: ["b5"],
    subject: "fix(web): 小地图拖动残影",
    at: "2026-11-12T20:00:00Z",
  },
  {
    repo: ".",
    id: "a3",
    parents: [],
    subject: "docs(ops): 部署记录 0.17.3",
    at: "2026-11-12T19:00:00Z",
  },
  {
    repo: "Armadra",
    id: "b5",
    parents: [],
    subject: "release: v0.17.2",
    at: "2026-11-10T21:30:00Z",
    refs: ["refs/tags/v0.17.2"],
  },
  {
    repo: "armadra-cloud",
    id: "c3",
    parents: [],
    subject: "release: v0.17.2",
    at: "2026-11-10T21:00:00Z",
    refs: ["refs/tags/v0.17.2"],
  },
];

export const GIT_LOG_COMMITS: GitLogCommit[] = SPECS.map((spec) => ({
  repositoryPath: spec.repo,
  oid: oid(`${spec.repo.length}${spec.id}`),
  parents: spec.parents.map((parent) => oid(`${spec.repo.length}${parent}`)),
  subject: spec.subject,
  authorName: "Owlbay",
  authorEmail: "owlbay@example.invalid",
  authorTime: spec.at,
  committerTime: spec.at,
  refs: spec.refs ?? [],
}));

/** 发现顺序 = 仓库色序号。 */
export const GIT_LOG_COLORS = new Map([
  [".", 0],
  ["Armadra", 1],
  ["armadra-cloud", 2],
]);
