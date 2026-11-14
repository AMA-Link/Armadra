import { describe, expect, it } from "vitest";
import type { GitLogCommit } from "@armadra/shared";

import { collapseLog } from "./collapse";
import { commitKey } from "./graph";

const oid = (char: string) => char.repeat(40);

const commit = (
  repositoryPath: string,
  id: string,
  parents: string[],
): GitLogCommit => ({
  repositoryPath,
  oid: oid(id),
  parents: parents.map(oid),
  subject: id,
  authorName: "Ada",
  authorEmail: "ada@example.invalid",
  authorTime: "2026-09-01T00:00:00Z",
  committerTime: "2026-09-01T00:00:00Z",
  refs: [],
});

/**
 * 主线：m2 → m1 → base。m2 合并了 x2 → x1（分叉自 m1），m1 合并了 y1（分叉
 * 自 base）。另有一个还没合并的分支 z1，分叉自 m2。
 */
const page = [
  commit(".", "z", ["m"]), // 未合并分支尖端，比主线还新
  commit(".", "m", ["n", "x"]), // m2
  commit(".", "x", ["w"]), // x2
  commit(".", "w", ["n"]), // x1
  commit(".", "n", ["b", "y"]), // m1
  commit(".", "y", ["b"]), // y1
  commit(".", "b", []), // base
];
const key = (id: string, repository = ".") => `${repository}:${oid(id)}`;

describe("collapseLog", () => {
  it("主线沿第一父走，分支提交记在合并名下", () => {
    const head = [page[1]!, ...page.slice(2)];
    const result = collapseLog(head, new Set());
    expect([...result.mainline]).toEqual([key("m"), key("n"), key("b")]);
    expect(result.mergedBy.get(key("x"))).toBe(key("m"));
    expect(result.mergedBy.get(key("w"))).toBe(key("m"));
    expect(result.mergedBy.get(key("y"))).toBe(key("n"));
    expect(result.sideCount.get(key("m"))).toBe(2);
    expect(result.sideCount.get(key("n"))).toBe(1);
  });

  it("折叠时藏起分支提交，合并只留第一父", () => {
    const head = [page[1]!, ...page.slice(2)];
    const result = collapseLog(head, new Set());
    expect(result.commits.map((entry) => entry.subject)).toEqual([
      "m",
      "n",
      "b",
    ]);
    expect(result.commits[0]!.parents).toEqual([oid("n")]);
  });

  it("展开一个合并只放回它名下的提交与父边", () => {
    const head = [page[1]!, ...page.slice(2)];
    const result = collapseLog(head, new Set([key("m")]));
    expect(result.commits.map((entry) => entry.subject)).toEqual([
      "m",
      "x",
      "w",
      "n",
      "b",
    ]);
    expect(result.commits[0]!.parents).toEqual([oid("n"), oid("x")]);
    expect(
      result.commits.find((entry) => entry.subject === "n")!.parents,
    ).toEqual([oid("b")]);
  });

  it("还没合并的分支原样保留；主线从仓库最新的提交起算", () => {
    const result = collapseLog(page, new Set());
    // 「全部分支」时最新的是 z：它在第一父链上，于是算进主线。
    expect(result.mainline.has(key("z"))).toBe(true);
    expect(result.commits.map((entry) => entry.subject)).toEqual([
      "z",
      "m",
      "n",
      "b",
    ]);
  });

  it("每个仓库各自一条主线，互不相干", () => {
    const mixed = [
      commit(".", "m", ["n", "x"]),
      commit("pkg", "m", ["n"]),
      commit(".", "x", ["n"]),
      commit(".", "n", []),
      commit("pkg", "n", []),
    ];
    const result = collapseLog(mixed, new Set());
    expect(result.mainline.has(key("m", "pkg"))).toBe(true);
    expect(result.mainline.has(key("n", "pkg"))).toBe(true);
    // 同 oid 不同仓库：pkg 的 n 不会被当成根仓库合并的落点。
    expect(result.mergedBy.get(key("x"))).toBe(key("m"));
    expect(result.commits.map(commitKey)).toEqual([
      key("m"),
      key("m", "pkg"),
      key("n"),
      key("n", "pkg"),
    ]);
  });

  it("关掉折叠时提交与父边原样返回，分类照算", () => {
    const head = [page[1]!, ...page.slice(2)];
    const result = collapseLog(head, new Set(), false);
    expect(result.commits).toHaveLength(head.length);
    expect(result.commits[0]!.parents).toHaveLength(2);
    expect(result.sideCount.get(key("m"))).toBe(2);
  });

  it("叠加分支依次合并：每个合并只算自己带进来的（#932）", () => {
    // b1 → b2 是 B1 分支；c1 建在 b2 上是 B2 分支。先合 B1（m1），再合 B2（m2）。
    const stacked = [
      commit(".", "y", ["x", "c"]), // m2：第二父 c1
      commit(".", "x", ["o", "e"]), // m1：第二父 b2
      commit(".", "c", ["e"]), // c1（建在 b2 上）
      commit(".", "e", ["d"]), // b2
      commit(".", "d", ["o"]), // b1
      commit(".", "o", []),
    ];
    const result = collapseLog(stacked, new Set());
    expect(result.sideCount.get(key("y"))).toBe(1);
    expect(result.sideCount.get(key("x"))).toBe(2);
    expect(result.mergedBy.get(key("c"))).toBe(key("y"));
    expect(result.mergedBy.get(key("e"))).toBe(key("x"));
    expect(result.mergedBy.get(key("d"))).toBe(key("x"));
  });
});
