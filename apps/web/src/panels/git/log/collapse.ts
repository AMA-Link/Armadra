import type { GitLogCommit } from "@armadra/shared";

import { commitKey } from "./graph";

/**
 * 按第一父折叠（Git 历史重设计 #927 B1）。
 *
 * 主线上几乎全是 PR 合并，车道全画出来是一排短彩线，看不出「这次合并带进来
 * 了什么」。这里把每个仓库分成三类提交：
 *
 * - **主线**：从这个仓库在本页的第一个（最新的）提交起，沿第一父一路往下；
 * - **分支提交**：从主线上某个合并的其余父提交出发、沿所有父提交走到主线为止
 *   遇到的提交，记在那个合并名下；
 * - **其余**：本页里不属于任何合并的提交（还没合并的分支），原样保留。
 *
 * 折叠的合并只留第一父——它的其余父提交连同名下的分支提交都不进图，图上
 * 也就不会为它们留出一条等不到人的车道；展开的合并原样交给 `commitGraph()`。
 * 车道算法本身不动：多仓库各占车道、未合并分支怎么画，都沿用原来的判定。
 */
export interface CollapsedLog {
  /** 交给图与表格的提交；折叠合并的 `parents` 只剩第一父。 */
  commits: GitLogCommit[];
  /** 主线提交的 `commitKey`。 */
  mainline: ReadonlySet<string>;
  /** 分支提交 → 带它进来的合并的 `commitKey`。 */
  mergedBy: ReadonlyMap<string, string>;
  /** 合并的 `commitKey` → 名下分支提交的个数（本页里能找到的）。 */
  sideCount: ReadonlyMap<string, number>;
}

export function collapseLog(
  commits: readonly GitLogCommit[],
  expanded: ReadonlySet<string>,
  enabled = true,
): CollapsedLog {
  const byKey = new Map(commits.map((commit) => [commitKey(commit), commit]));
  const parentKey = (commit: GitLogCommit, parent: string) =>
    `${commit.repositoryPath}:${parent}`;

  const mainline = new Set<string>();
  const seenRepository = new Set<string>();
  for (const commit of commits) {
    if (seenRepository.has(commit.repositoryPath)) continue;
    seenRepository.add(commit.repositoryPath);
    let current: GitLogCommit | undefined = commit;
    while (current && !mainline.has(commitKey(current))) {
      mainline.add(commitKey(current));
      const first: string | undefined = current.parents[0];
      current = first ? byKey.get(parentKey(current, first)) : undefined;
    }
  }

  const mergedBy = new Map<string, string>();
  const sideCount = new Map<string, number>();
  for (const commit of commits) {
    const key = commitKey(commit);
    if (!mainline.has(key) || commit.parents.length < 2) continue;
    const queue = commit.parents
      .slice(1)
      .map((parent) => parentKey(commit, parent));
    let count = 0;
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (mainline.has(next) || mergedBy.has(next)) continue;
      const side = byKey.get(next);
      if (!side) continue;
      mergedBy.set(next, key);
      count += 1;
      for (const parent of side.parents) queue.push(parentKey(side, parent));
    }
    if (count > 0) sideCount.set(key, count);
  }

  if (!enabled) return { commits: [...commits], mainline, mergedBy, sideCount };

  const visible: GitLogCommit[] = [];
  for (const commit of commits) {
    const key = commitKey(commit);
    const owner = mergedBy.get(key);
    if (owner && !expanded.has(owner)) continue;
    // 名下分支提交不在本页的主线合并也只留第一父：否则它会拖着一截「页外」
    // 虚线残桩，主线上每个合并都挂一根，正是这次要去掉的噪声。
    visible.push(
      mainline.has(key) && commit.parents.length > 1 && !expanded.has(key)
        ? { ...commit, parents: commit.parents.slice(0, 1) }
        : commit,
    );
  }
  return { commits: visible, mainline, mergedBy, sideCount };
}

/**
 * 合并提交的标题。托管平台的合并信息是「Merge pull request #920 from
 * owner/release/v0.17.3」，真正有用的只有分支名与 PR 号；认不出来时返回
 * `null`，表格照原样显示主题。
 */
export function mergeLabel(
  subject: string,
): { branch: string; pr: string | null } | null {
  const pull = /^Merge pull request (#\d+) from [^/\s]+\/(\S+)/.exec(subject);
  if (pull) return { branch: pull[2]!, pr: pull[1]! };
  const branch = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  if (branch) return { branch: branch[1]!, pr: null };
  return null;
}
