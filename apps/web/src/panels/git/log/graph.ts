import type { GitLogCommit } from "@armadra/shared";

import type { GraphKeys } from "../CommitGraph";

/**
 * 多仓库日志里一个提交的身份（Git 工具窗口设计 §2.2）。
 *
 * `仓库路径:oid`，而不是裸 oid。同一个工作空间里两个检出可能持有同一个 oid
 * ——链接 worktree 与主仓库本来就是同一个仓库，cherry-pick 过去的提交也可能
 * 撞上——裸 oid 会把两条本来无关的线连起来，画出一张说谎的图。
 */
export function commitKey(commit: {
  repositoryPath: string;
  oid: string;
}): string {
  return `${commit.repositoryPath}:${commit.oid}`;
}

/** 父提交永远在同一个仓库里，所以父的身份也带同一个仓库路径。 */
export const logGraphKeys: GraphKeys<GitLogCommit> = {
  key: commitKey,
  parent: (commit, parent) => `${commit.repositoryPath}:${parent}`,
};

/**
 * 仓库颜色条的调色板（§2.2「多仓库时每行左侧 3px 颜色条」）。
 *
 * 序号来自日志响应里的 `repositories[].color`，不是色值——主题换了颜色跟着
 * 换，而「哪个仓库是第几号」由服务端一次定下来，翻页不会变。
 */
const REPOSITORY_COLORS = [
  "var(--brand)",
  "var(--graph-2)",
  "var(--graph-3)",
  "var(--graph-1)",
  "var(--graph-5)",
  "var(--graph-4)",
  "var(--graph-6)",
  "var(--graph-7)",
];

export function repositoryColor(index: number): string {
  const size = REPOSITORY_COLORS.length;
  return REPOSITORY_COLORS[((index % size) + size) % size]!;
}

/**
 * 分支的颜色（#942）：按颜色链（一条第一父链）轮换主题色板，不按车道下标——
 * 分支挪车道时颜色不变。和本仓库主线同色时顺延一位，分支与主线一眼能分开。
 */
const BRANCH_COLORS = [
  "var(--graph-1)",
  "var(--graph-3)",
  "var(--graph-2)",
  "var(--graph-4)",
  "var(--graph-6)",
  "var(--graph-5)",
  "var(--graph-7)",
  "var(--graph-8)",
];

export function branchColor(chain: number, avoid?: string): string {
  const size = BRANCH_COLORS.length;
  const pick = (index: number) =>
    BRANCH_COLORS[((index % size) + size) % size]!;
  const color = pick(chain);
  return color === avoid ? pick(chain + 1) : color;
}
