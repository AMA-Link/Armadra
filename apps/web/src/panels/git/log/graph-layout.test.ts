import { describe, expect, it } from "vitest";

import type { GraphCommit, GraphKeys } from "../CommitGraph";
import { graphLayout } from "./graph-layout";

interface Node extends GraphCommit {
  repo?: string;
}

const keys: GraphKeys<Node> = {
  key: (commit) => `${commit.repo ?? "."}:${commit.oid}`,
  parent: (commit, parent) => `${commit.repo ?? "."}:${parent}`,
};

const node = (oid: string, parents: string[], repo?: string): Node => ({
  oid,
  parents,
  repo,
});

const lanes = (layout: ReturnType<typeof graphLayout>) =>
  layout.rows.map((row) => row.lane);

describe("逐行布线（#942）", () => {
  it("一条直线：全在第 0 道，颜色一条链", () => {
    const layout = graphLayout(
      [node("c", ["b"]), node("b", ["a"]), node("a", [])],
      keys,
    );
    expect(lanes(layout)).toEqual([0, 0, 0]);
    expect(new Set(layout.rows.map((row) => row.chain)).size).toBe(1);
    expect(layout.segments.map((s) => [s.row, s.from, s.to])).toEqual([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    expect(layout.lanes).toBe(1);
  });

  it("分支尾在自己的车道竖直走，到父提交上一行才斜着汇入", () => {
    // m 合并 x（侧枝），侧枝三个提交，然后汇进分叉点 f。
    const layout = graphLayout(
      [
        node("m", ["a", "x3"]),
        node("x3", ["x2"]),
        node("a", ["b"]),
        node("x2", ["x1"]),
        node("b", ["f"]),
        node("x1", ["f"]),
        node("f", []),
      ],
      keys,
    );
    expect(lanes(layout)).toEqual([0, 1, 0, 1, 0, 1, 0]);
    // 侧枝最后一段：第 5 行（x1，车道 1）→ 第 6 行 f 的车道 0。
    const last = layout.segments.find((s) => s.child === ".:x1");
    expect(last).toMatchObject({ row: 5, from: 1, to: 0 });
    // 中间每一段都是竖的，没有跨多行的斜线。
    for (const segment of layout.segments) {
      if (segment.row < 5)
        expect(Math.abs(segment.from - segment.to)).toBeLessThanOrEqual(1);
    }
    // 颜色：侧枝与主线不同链，侧枝从尖端到汇入同一条链。
    const chain = (key: string) => layout.byKey.get(key)!.chain;
    expect(chain(".:x3")).toBe(chain(".:x1"));
    expect(chain(".:x3")).not.toBe(chain(".:m"));
  });

  it("左边的车道结束后，右边的线左移一格", () => {
    // 两个侧枝：p 先结束，q 的车道从 2 移到 1。
    const layout = graphLayout(
      [
        node("m2", ["m1", "q2"]),
        node("m1", ["base", "p1"]),
        node("p1", ["root1"]),
        node("q2", ["q1"]),
        node("q1", ["base"]),
        node("base", []),
      ],
      keys,
    );
    // p1 是根之后断开的侧枝（root1 不在页里，画残桩），q 往左挪。
    expect(layout.stubs.map((stub) => stub.child)).toEqual([".:p1"]);
    expect(layout.byKey.get(".:q2")!.lane).toBe(1);
    const shift = layout.segments.find(
      (s) => s.child === ".:m2" && s.parent === ".:q2" && s.row === 2,
    );
    expect(shift).toMatchObject({ from: 2, to: 1 });
  });

  it("多条车道可以等同一个父提交，在父提交上一行一起汇入", () => {
    const layout = graphLayout(
      [
        node("m", ["a", "b"]),
        node("a", ["f"]),
        node("b", ["f"]),
        node("f", []),
      ],
      keys,
    );
    const into = layout.segments.filter(
      (s) => s.parent === ".:f" && s.row === 2,
    );
    expect(into.map((s) => s.to)).toEqual([0, 0]);
    expect(layout.byKey.get(".:f")!.lane).toBe(0);
  });

  it("长边截成 ↓ / ↑ 两段，中间不占列", () => {
    const main = Array.from({ length: 10 }, (_, i) =>
      node(`a${i}`, [i === 9 ? "f" : `a${i + 1}`]),
    );
    const layout = graphLayout(
      [node("m", ["a0", "x"]), node("x", ["f"]), ...main, node("f", [])],
      keys,
      4,
    );
    expect(layout.arrows.map((a) => [a.dir, a.child])).toEqual([
      ["down", ".:x"],
      ["up", ".:x"],
    ]);
    const up = layout.arrows.find((a) => a.dir === "up")!;
    // ↑ 在父提交上一行出现。
    expect(up.row).toBe(layout.byKey.get(".:f")!.row - 1);
    // 中间的行只有主线一道。
    expect(layout.rows[5]!.width).toBe(1);
  });

  it("不同仓库互不相连", () => {
    const layout = graphLayout(
      [node("a", ["b"], "one"), node("a", ["b"], "two"), node("b", [], "one")],
      keys,
    );
    expect(layout.byKey.get("two:a")!.lane).toBe(1);
    expect(layout.stubs.map((stub) => stub.child)).toEqual(["two:a"]);
  });

  it("每行宽度只算这一行用到的车道；汇入的线不算", () => {
    const layout = graphLayout(
      [
        node("m", ["a", "x"]),
        node("x", ["a"]),
        node("a", ["b"]),
        node("b", []),
      ],
      keys,
    );
    expect(layout.rows.map((row) => row.width)).toEqual([2, 2, 1, 1]);
  });
});
