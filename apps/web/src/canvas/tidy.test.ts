import { describe, expect, it, vi } from "vitest";

/** 只为了拿默认尺寸；节点体（xterm / CodeMirror）不该被拉进纯几何单测。 */
const nodeMetaStub = {
  labelKey: "node.terminal",
  defaultSize: { width: 240, height: 200 },
  minSize: { width: 160, height: 120 },
  defaultColor: "#0a84ff",
  hasBridgeHandles: false,
};
vi.mock("../nodes/registry", () => ({
  NODE_META: new Proxy({}, { get: () => nodeMetaStub }),
  nodeMeta: () => nodeMetaStub,
}));

import type { CanvasEdge, CanvasNode } from "@armadra/shared";
import {
  CLUSTER_GAP,
  GRID_UNIT,
  LAYER_GAP,
  SIBLING_GAP,
} from "@armadra/shared";
import { chooseGrid, readingRows, tidy, tidyPositions } from "./tidy";
import { COLLAPSED_HEIGHT } from "../store/defaults";

/** 无主从边的分量沿连线方向分列，列距是横向层距。 */
const COLUMN = LAYER_GAP.horizontal;

const box = (id: string, width = 200, height = 100) => ({ id, width, height });

/** 排完之后每个盒子的矩形，用来验「不重叠」。 */
function rects(
  boxes: { id: string; width: number; height: number }[],
  positions: Record<string, { x: number; y: number }>,
) {
  return boxes.map((item) => {
    const at = positions[item.id];
    return {
      id: item.id,
      left: at!.x,
      top: at!.y,
      right: at!.x + item.width,
      bottom: at!.y + item.height,
    };
  });
}

function overlaps(
  boxes: { id: string; width: number; height: number }[],
  positions: Record<string, { x: number; y: number }>,
) {
  const all = rects(boxes, positions);
  const hits: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      if (
        a!.left < b!.right &&
        b!.left < a!.right &&
        a!.top < b!.bottom &&
        b!.top < a!.bottom
      ) {
        hits.push(`${a!.id}×${b!.id}`);
      }
    }
  }
  return hits;
}

/** 不吸网格的原始几何：这一组断言验的是排布本身，网格另有一组。 */
const raw: typeof tidy = (boxes, links, options = {}) =>
  tidy(boxes, links, { grid: 0, ...options });

describe("tidy", () => {
  it("空画布返回空表", () => {
    expect(raw([], [])).toEqual({});
  });

  it("分量内：源节点排在目标左边，一层一列", () => {
    const positions = raw(
      [box("a"), box("b"), box("c")],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    );
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 200 + COLUMN, y: 0 });
    expect(positions.c).toEqual({ x: (200 + COLUMN) * 2, y: 0 });
  });

  it("列内按行距堆叠，列宽取该列最宽的节点", () => {
    const positions = raw(
      [box("a", 300, 120), box("b", 200, 80), box("c", 200, 80)],
      [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
      ],
    );
    expect(positions.b).toEqual({ x: 300 + COLUMN, y: 0 });
    expect(positions.c).toEqual({ x: 300 + COLUMN, y: 80 + SIBLING_GAP });
  });

  it("有环也不会死循环，指向未知节点的边被忽略", () => {
    const positions = raw(
      [box("a"), box("b")],
      [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
        { source: "a", target: "ghost" },
      ],
    );
    expect(Object.keys(positions).sort()).toEqual(["a", "b"]);
    // 纯环里每个节点都有入边，谁都不是根，于是一起落到同一列。
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 0, y: 100 + SIBLING_GAP });
  });

  it("按连通分量分组，分量按阅读顺序摆放", () => {
    // 三个独立分量：a-b、c、d。宽度小、行宽上限大 → 同一行从左到右。
    const boxes = [box("a"), box("b"), box("c"), box("d")];
    const positions = raw(boxes, [{ source: "a", target: "b" }], {
      aspect: 100, // 极端扁平：一行放得下所有分量
    });
    // 分量 1（a→b）占据 [0, 200 + COLUMN + 200]，接着是 c、d。
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 200 + COLUMN, y: 0 });
    expect(positions.c!.y).toBe(0);
    expect(positions.d!.y).toBe(0);
    expect(positions.c!.x).toBeGreaterThan(positions.b!.x);
    expect(positions.d!.x).toBeGreaterThan(positions.c!.x);
    expect(overlaps(boxes, positions)).toEqual([]);
  });

  it("行放不下就换行，行高取行内最高的分量", () => {
    // 三个分量 a→b、c→d、e→f，各宽 200 + COLUMN + 200、高 100，宽高比 1 →
    // 行宽上限 ≈ sqrt(3 × 569 × 100)×1.15 ≈ 475 → 一行只放得下 1 个分量。
    // （全是孤立节点时不裹行，改排网格，见下面的「网格」一组。）
    const boxes = ["a", "b", "c", "d", "e", "f"].map((id) => box(id));
    const positions = raw(
      boxes,
      [
        { source: "a", target: "b" },
        { source: "c", target: "d" },
        { source: "e", target: "f" },
      ],
      { aspect: 1 },
    );
    const rows = new Set(boxes.map((item) => positions[item.id]!.y));
    expect(rows.size).toBe(3);
    // 行距 = 上一行的行高 + CLUSTER_GAP
    expect(positions.c).toEqual({ x: 0, y: 100 + CLUSTER_GAP });
    expect(overlaps(boxes, positions)).toEqual([]);
  });

  it("宽视口（宽高比 2）下 6 个等大节点排成 ≥2 列", () => {
    const boxes = ["a", "b", "c", "d", "e", "f"].map((id) => box(id));
    const positions = raw(boxes, [], { aspect: 2 });
    const columns = new Set(boxes.map((item) => positions[item.id]!.x));
    expect(columns.size).toBeGreaterThanOrEqual(2);
    expect(overlaps(boxes, positions)).toEqual([]);
    // 阅读顺序：第一个永远在原点。
    expect(positions.a).toEqual({ x: 0, y: 0 });
  });

  it("比整行还宽的分量独占一行，不会死循环", () => {
    const boxes = [box("wide", 4000, 100), box("a"), box("b")];
    const positions = raw(boxes, [], { aspect: 1 });
    expect(positions.wide).toEqual({ x: 0, y: 0 });
    expect(overlaps(boxes, positions)).toEqual([]);
  });

  it("同一份输入排两次结果一致（确定性）", () => {
    const boxes = ["a", "b", "c", "d"].map((id) => box(id));
    const links = [{ source: "a", target: "c" }];
    expect(raw(boxes, links, { aspect: 1.6 })).toEqual(
      raw(boxes, links, { aspect: 1.6 }),
    );
  });
});

/* ------------------------------ 文档层入口 -------------------------------- */

const timestamp = "2026-09-04T00:00:00.000Z";

function node(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    boardId: "board",
    type: "terminal",
    title: id,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  } as CanvasNode;
}

const link = (source: string, target: string): CanvasEdge =>
  ({
    id: `${source}-${target}`,
    boardId: "board",
    source,
    target,
    kind: "link",
    createdAt: timestamp,
    updatedAt: timestamp,
  }) as CanvasEdge;

describe("tidyPositions", () => {
  it("没写 size 的节点用 NODE_META 的默认尺寸", () => {
    const positions = tidyPositions([node("a"), node("b")], [link("a", "b")], {
      aspect: 100,
      grid: 0,
    });
    // 默认宽 240 → 第二列在 240 + 横向层距
    expect(positions.b).toEqual({ x: 240 + COLUMN, y: 0 });
  });

  it("折叠的节点按 COLLAPSED_HEIGHT 参与排布", () => {
    // root 分出两个折叠节点：同一列堆叠时按 40px 而不是 400px 算行距，
    // 否则折叠一排节点之后列里全是空气。
    const positions = tidyPositions(
      [
        node("root", { size: { width: 200, height: 100 } }),
        node("x", { size: { width: 200, height: 400 }, collapsed: true }),
        node("y", { size: { width: 200, height: 400 }, collapsed: true }),
      ],
      [link("root", "x"), link("root", "y")],
      { aspect: 100, grid: 0 },
    );
    expect(positions.x).toEqual({ x: 200 + COLUMN, y: 0 });
    expect(positions.y!.y).toBe(COLLAPSED_HEIGHT + SIBLING_GAP);
  });

  it("组框整体参与排布，组员的相对坐标不动", () => {
    const nodes = [
      node("solo", { size: { width: 200, height: 100 } }),
      node("frame", {
        type: "group",
        data: { kind: "group" },
        size: { width: 600, height: 400 },
        position: { x: 900, y: 900 },
      }),
      node("child", {
        parentId: "frame",
        size: { width: 200, height: 100 },
        position: { x: 24, y: 60 },
      }),
      node("child2", {
        parentId: "frame",
        size: { width: 200, height: 100 },
        position: { x: 260, y: 60 },
      }),
    ];
    const positions = tidyPositions(nodes, [], { aspect: 100, grid: 0 });

    // 组员不出现在结果里 → 保持相对组框的坐标，跟着组一起平移。
    expect(positions.child).toBeUndefined();
    expect(positions.child2).toBeUndefined();
    expect(Object.keys(positions).sort()).toEqual(["frame", "solo"]);

    // 组框按自己的 600×400 占位，排在 solo 右边一个簇间距之外。
    expect(positions.solo).toEqual({ x: 0, y: 0 });
    expect(positions.frame).toEqual({ x: 200 + CLUSTER_GAP, y: 0 });

    // 组一动，两个组员的**相对**偏移仍然是 236（= 260 - 24）。
    const frame = positions.frame;
    const absolute = (child: { x: number; y: number }) => ({
      x: frame!.x + child.x,
      y: frame!.y + child.y,
    });
    expect(absolute({ x: 260, y: 60 }).x - absolute({ x: 24, y: 60 }).x).toBe(
      236,
    );
  });
});

/* ------------------------- 刚体 / 阅读顺序 / 主从树 ------------------------- */

type At = { x: number; y: number };
const placed = (
  id: string,
  x: number,
  y: number,
  kind: "agent" | "node" | "wb" = "node",
  width = 200,
  height = 100,
) => ({ id, x, y, width, height, kind });
const supervises = (source: string, target: string) => ({
  source,
  target,
  role: "supervises" as const,
});

/** 再排一次，把结果当成新的原位置喂回去。 */
function again(
  boxes: ReturnType<typeof placed>[],
  links: Parameters<typeof tidy>[1],
  first: Record<string, At>,
  options: Parameters<typeof tidy>[2],
) {
  const moved = boxes.map((box) => ({ ...box, ...first[box.id]! }));
  return tidy(moved, links, options);
}

describe("tidy · §6.4", () => {
  it("(a) 横向一主三从：从在右列、等距、x 相同，主 y 居中于子块", () => {
    const boxes = [
      placed("main", 900, 600, "agent", 300, 200),
      placed("s1", 0, 0, "agent"),
      placed("s2", 2000, 50, "agent"),
      placed("s3", 400, 1500, "agent"),
    ];
    const links = ["s1", "s2", "s3"].map((id) => supervises("main", id));
    const at = tidy(boxes, links, { aspect: 100, direction: "horizontal" });

    expect(at.main!.x).toBe(0);
    const xs = new Set(["s1", "s2", "s3"].map((id) => at[id]!.x));
    expect(xs.size).toBe(1);
    expect(at.s1!.x).toBeGreaterThan(at.main!.x + 300);
    // 子按原阅读顺序（s1 在最上，s2 同一行偏右，s3 最下），等距。
    expect(at.s1!.y).toBe(0);
    expect(at.s2!.y - at.s1!.y).toBe(at.s3!.y - at.s2!.y);
    expect(at.s2!.y).toBeGreaterThan(at.s1!.y);
    // 主的中线对齐子块的中线（差不超过一格网格）。
    const blockMid = (at.s1!.y + at.s3!.y + 100) / 2;
    expect(Math.abs(at.main!.y + 100 - blockMid)).toBeLessThanOrEqual(
      GRID_UNIT,
    );
  });

  it("(a') 纵向一主三从：从在下一行、等距、y 相同，主 x 居中于子块", () => {
    const boxes = [
      placed("main", 900, 600, "agent", 300, 200),
      placed("s1", 0, 0, "agent"),
      placed("s2", 2000, 50, "agent"),
      placed("s3", 400, 1500, "agent"),
    ];
    const links = ["s1", "s2", "s3"].map((id) => supervises("main", id));
    const at = tidy(boxes, links, { aspect: 100, direction: "vertical" });

    expect(at.main!.y).toBe(0);
    const ys = new Set(["s1", "s2", "s3"].map((id) => at[id]!.y));
    expect(ys.size).toBe(1);
    expect(at.s1!.y).toBeGreaterThanOrEqual(200 + LAYER_GAP.vertical);
    expect(at.s1!.x).toBe(0);
    expect(at.s2!.x - at.s1!.x).toBe(at.s3!.x - at.s2!.x);
    expect(at.s2!.x).toBeGreaterThan(at.s1!.x);
    const blockMid = (at.s1!.x + at.s3!.x + 200) / 2;
    expect(Math.abs(at.main!.x + 150 - blockMid)).toBeLessThanOrEqual(
      GRID_UNIT,
    );
  });

  it("缺省方向是纵向", () => {
    const boxes = [placed("m", 0, 0, "agent"), placed("s", 900, 0, "agent")];
    const at = tidy(boxes, [supervises("m", "s")], { aspect: 100 });
    expect(at.s!.x).toBe(at.m!.x);
    expect(at.s!.y).toBeGreaterThan(at.m!.y);
  });

  it("纵向三层：孙排在子下面一层，子居中于孙", () => {
    const boxes = [
      placed("r", 0, 0, "agent"),
      placed("c", 0, 300, "agent"),
      placed("g1", 0, 600, "agent"),
      placed("g2", 300, 600, "agent"),
    ];
    const at = tidy(
      boxes,
      [supervises("r", "c"), supervises("c", "g1"), supervises("c", "g2")],
      { aspect: 100, direction: "vertical", grid: 0 },
    );
    expect(at.g1!.y).toBe(at.g2!.y);
    expect(at.g1!.y).toBe((100 + LAYER_GAP.vertical) * 2);
    expect(at.g2!.x).toBe(200 + SIBLING_GAP);
    // 子块宽 200 + 兄弟间距 + 200，子与根（宽 200）都居中于它。
    expect(at.c!.x).toBe((200 + SIBLING_GAP) / 2);
    expect(at.r!.x).toBe((200 + SIBLING_GAP) / 2);
    expect(overlaps(boxes, at)).toEqual([]);
  });

  it("(b) 两棵树各自成簇，互不交错", () => {
    const boxes = [
      placed("a", 0, 0, "agent"),
      placed("a1", 0, 400, "agent"),
      placed("b", 3000, 0, "agent"),
      placed("b1", 3000, 400, "agent"),
    ];
    const links = [supervises("a", "a1"), supervises("b", "b1")];
    const at = tidy(boxes, links, { aspect: 100, direction: "horizontal" });
    // 同一行从左到右：a 树整个在 b 树左边。
    expect(at.a!.y).toBe(at.b!.y);
    expect(Math.max(at.a!.x, at.a1!.x) + 200).toBeLessThan(at.b!.x);
    expect(at.a1!.y).toBe(at.a!.y);
    expect(at.b1!.y).toBe(at.b!.y);
  });

  it("(b') 纵向两棵树也各自成簇、互不重叠", () => {
    const boxes = [
      placed("a", 0, 0, "agent"),
      placed("a1", 0, 400, "agent"),
      placed("a2", 300, 400, "agent"),
      placed("b", 3000, 0, "agent"),
      placed("b1", 3000, 400, "agent"),
    ];
    const links = [
      supervises("a", "a1"),
      supervises("a", "a2"),
      supervises("b", "b1"),
    ];
    const at = tidy(boxes, links, { aspect: 100, direction: "vertical" });
    expect(at.a!.y).toBe(at.b!.y);
    expect(Math.max(at.a1!.x, at.a2!.x) + 200).toBeLessThan(at.b!.x);
    expect(at.b1!.x).toBe(at.b!.x);
    expect(overlaps(boxes, at)).toEqual([]);
  });

  it("(c) 附件（浏览器）落在所连 Agent 同列正下方", () => {
    const boxes = [
      placed("main", 0, 0, "agent"),
      placed("sub", 500, 0, "agent"),
      placed("web", 2000, 2000, "node", 300, 200),
      placed("other", 600, 900, "agent"),
    ];
    const links = [
      supervises("main", "sub"),
      supervises("main", "other"),
      { source: "sub", target: "web" },
    ];
    const at = tidy(boxes, links, { aspect: 100, direction: "horizontal" });
    expect(at.web!.x).toBe(at.sub!.x);
    expect(at.web!.y).toBeGreaterThan(at.sub!.y + 100);
    // 附件挤在 sub 与下一个兄弟之间，兄弟往下让。
    expect(at.other!.x).toBe(at.sub!.x);
    expect(at.other!.y).toBeGreaterThan(at.web!.y + 200);
  });

  it("(c') 纵向：附件落在所连 Agent 右侧同一行，下一个兄弟往右让", () => {
    const boxes = [
      placed("main", 0, 0, "agent"),
      placed("sub", 500, 0, "agent"),
      placed("web", 2000, 2000, "node", 300, 200),
      placed("other", 600, 900, "agent"),
    ];
    const links = [
      supervises("main", "sub"),
      supervises("main", "other"),
      { source: "sub", target: "web" },
    ];
    const at = tidy(boxes, links, { aspect: 100, direction: "vertical" });
    expect(at.web!.y).toBe(at.sub!.y);
    expect(at.web!.x).toBeGreaterThanOrEqual(at.sub!.x + 200 + SIBLING_GAP);
    expect(at.other!.y).toBe(at.sub!.y);
    expect(at.other!.x).toBeGreaterThanOrEqual(at.web!.x + 300 + SIBLING_GAP);
    expect(overlaps(boxes, at)).toEqual([]);
  });

  it("(d) 白板孤岛整体平移，内部相对位置不变", () => {
    const boxes = [
      placed("n", 0, 0),
      // 三个相距 ≤ 24px 的白板对象 = 一个孤岛（导入的 Mermaid 散件）。
      placed("w1", 1000, 1000, "wb", 100, 40),
      placed("w2", 1110, 1000, "wb", 100, 40),
      placed("w3", 1000, 1060, "wb", 210, 2),
      // 远处一个独立的白板对象自成一岛。
      placed("far", 5000, 5000, "wb", 50, 50),
    ];
    const at = tidy(boxes, [], { aspect: 1 });
    expect(at.w2!.x - at.w1!.x).toBe(110);
    expect(at.w2!.y - at.w1!.y).toBe(0);
    expect(at.w3!.y - at.w1!.y).toBe(60);
    expect(at.w3!.x - at.w1!.x).toBe(0);
    // 孤岛整体当一个盒子，和 far 不重叠。
    expect(overlaps(boxes, at)).toEqual([]);
  });

  it("(e) 幂等：整理两次，第二次位移为 0", () => {
    const boxes = [
      placed("main", 900, 600, "agent", 300, 200),
      placed("s1", 0, 0, "agent"),
      placed("s2", 2000, 50, "agent"),
      placed("web", 1300, 1700, "node", 320, 240),
      placed("note", 4000, 300),
      placed("ed", 4200, 900),
      placed("w1", 70, 2000, "wb", 120, 60),
      placed("w2", 200, 2010, "wb", 120, 60),
      placed("lone", 3333, 3333, "node", 150, 90),
    ];
    const links = [
      supervises("main", "s1"),
      supervises("main", "s2"),
      { source: "s2", target: "web" },
      { source: "note", target: "ed" },
    ];
    for (const direction of ["vertical", "horizontal"] as const) {
      const options = { aspect: 16 / 9, direction };
      const first = tidy(boxes, links, options);
      const second = again(boxes, links, first, options);
      expect(second).toEqual(first);
      expect(overlaps(boxes, first)).toEqual([]);
    }
  });

  it("(f) 阅读顺序：原来在上面的仍在上面", () => {
    // 三个孤立节点竖着排；宽高比 1 → 裹成一列，顺序不能被输入顺序打乱。
    const boxes = [
      placed("bottom", 0, 2000),
      placed("top", 0, 0),
      placed("middle", 0, 1000),
    ];
    const at = tidy(boxes, [], { aspect: 0.1 });
    expect(at.top!.y).toBeLessThan(at.middle!.y);
    expect(at.middle!.y).toBeLessThan(at.bottom!.y);
  });

  it("(g) 网格：单元左上角都是点阵单位（13px）的倍数", () => {
    const boxes = [
      placed("a", 13, 7, "node", 203, 97),
      placed("b", 500, 3, "node", 177, 131),
      placed("c", 999, 1001, "agent", 211, 149),
      placed("d", 1500, 20, "agent", 199, 99),
    ];
    const at = tidy(boxes, [supervises("c", "d")], { aspect: 1.6 });
    for (const point of Object.values(at)) {
      expect(point.x % GRID_UNIT).toBe(0);
      expect(point.y % GRID_UNIT).toBe(0);
    }
  });

  it("(h) 无主从边的分量沿用拓扑分列", () => {
    const boxes = [placed("a", 0, 0), placed("b", 0, 300), placed("c", 0, 600)];
    const at = tidy(
      boxes,
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
      { aspect: 100, grid: 0 },
    );
    expect(at.a).toEqual({ x: 0, y: 0 });
    expect(at.b).toEqual({ x: 200 + COLUMN, y: 0 });
    expect(at.c).toEqual({ x: (200 + COLUMN) * 2, y: 0 });
  });

  it("主从成环也不死循环，从最晚到的那条主从边剪断", () => {
    const boxes = [placed("x", 0, 0, "agent"), placed("y", 0, 500, "agent")];
    const at = tidy(boxes, [supervises("x", "y"), supervises("y", "x")], {
      aspect: 100,
      grid: 0,
      direction: "horizontal",
    });
    expect(at.x).toEqual({ x: 0, y: 0 });
    expect(at.y).toEqual({ x: 200 + LAYER_GAP.horizontal, y: 0 });
  });

  it("重心法：第二列按上一列邻居的位置排，减少交叉", () => {
    // a、b 在第 0 列（a 在上）；a→d、b→c，c 原本在 d 上面。
    const boxes = [
      placed("a", 0, 0),
      placed("b", 0, 400),
      placed("c", 500, 0),
      placed("d", 500, 400),
    ];
    const at = tidy(
      boxes,
      [
        { source: "a", target: "d" },
        { source: "b", target: "c" },
        { source: "a", target: "b" },
      ],
      { aspect: 100, grid: 0 },
    );
    // a→b 让 b 进了第 1 列，d 也在第 1 列；c 在第 2 列。
    expect(at.b!.x).toBe(at.d!.x);
    expect(overlaps(boxes, at)).toEqual([]);
  });
});

/* ---------------------------------- 网格（#713） ---------------------------------- */

/** 黄金比例的会话节点默认尺寸（55 × 34 格）。 */
const SESSION = { width: 55 * GRID_UNIT, height: 34 * GRID_UNIT };

const shape = (columns: number, rows: number) => ({ columns, rows });

describe("chooseGrid", () => {
  const landscape = [16 / 9, 16 / 10, 1288 / 900, 4 / 3];
  const portrait = [9 / 16, 10 / 16, 3 / 4, 900 / 1288];
  const expected: Record<number, [number, number]> = {
    1: [1, 1],
    2: [2, 1],
    3: [3, 1],
    4: [2, 2],
    5: [3, 2],
    6: [3, 2],
    7: [4, 2],
    8: [4, 2],
    9: [3, 3],
  };

  for (const aspect of landscape) {
    it(`横屏（${aspect.toFixed(2)}）：1–9 个按个数取列 ≥ 行`, () => {
      for (let count = 1; count <= 9; count += 1) {
        const [columns, rows] = expected[count]!;
        expect(
          chooseGrid(count, aspect, SESSION, CLUSTER_GAP),
          `${count}`,
        ).toEqual(shape(columns, rows));
      }
    });
  }

  for (const aspect of portrait) {
    it(`竖屏（${aspect.toFixed(2)}）：1–9 个是横屏的转置，行 ≥ 列`, () => {
      for (let count = 1; count <= 9; count += 1) {
        const [columns, rows] = expected[count]!;
        expect(
          chooseGrid(count, aspect, SESSION, CLUSTER_GAP),
          `${count}`,
        ).toEqual(shape(rows, columns));
      }
    });
  }

  it("格子总数够放、最多空一行不到", () => {
    for (const aspect of [...landscape, ...portrait, 1]) {
      for (let count = 1; count <= 40; count += 1) {
        const { columns, rows } = chooseGrid(count, aspect, SESSION, 104);
        expect(columns * rows).toBeGreaterThanOrEqual(count);
        expect(columns * (rows - 1)).toBeLessThan(count);
        expect((columns - 1) * rows).toBeLessThan(count);
      }
    }
  });

  it("正方视口两种朝向都试，取像素宽高比更接近的", () => {
    // 6 个黄金比例节点：3×2 太扁（≈2.4），2×3 接近正方（≈1.0）。
    expect(chooseGrid(6, 1, SESSION, CLUSTER_GAP)).toEqual(shape(2, 3));
    // 竖长的节点反过来。
    expect(
      chooseGrid(
        6,
        1,
        { width: SESSION.height, height: SESSION.width },
        CLUSTER_GAP,
      ),
    ).toEqual(shape(3, 2));
  });

  it("没有个数或宽高比不合法时有确定的结果", () => {
    expect(chooseGrid(0, 16 / 9)).toEqual(shape(0, 0));
    expect(chooseGrid(4, Number.NaN)).toEqual(shape(2, 2));
    expect(chooseGrid(6, 0)).toEqual(shape(3, 2));
  });
});

describe("readingRows", () => {
  const at = (id: string, x: number, y: number, width = 100, height = 60) => ({
    id,
    x,
    y,
    width,
    height,
  });

  it("行优先：先按行、行内按 x，与输入顺序和编号无关", () => {
    const rows = readingRows([
      at("6", 400, 210),
      at("1", 0, 0),
      at("4", 0, 200),
      at("3", 400, 30),
      at("5", 200, 190),
      at("2", 200, 10),
    ]);
    expect(rows.map((row) => row.map((unit) => unit.id))).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("同一行上下错开超过 48px 也不拆行，只要中心还压着行首", () => {
    // 旧的阅读顺序按 48px 量化：b 比 a 低 120px 就会被排到 a 后面的一行。
    const rows = readingRows([
      at("a", 500, 0, 715, 442),
      at("b", 0, 120, 715, 442),
    ]);
    expect(rows.map((row) => row.map((unit) => unit.id))).toEqual([["b", "a"]]);
  });

  it("中心落到行首下面就开新行", () => {
    const rows = readingRows([at("a", 500, 0), at("b", 0, 40)]);
    expect(rows.map((row) => row.map((unit) => unit.id))).toEqual([
      ["a"],
      ["b"],
    ]);
  });
});

describe("tidy：全是单个单元时排网格", () => {
  /** n 个会话，随手摆在一条斜线上（编号顺序 ≠ 画面顺序）。 */
  const sessions = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      placed(
        `s${index + 1}`,
        ((index * 7) % count) * 300,
        index * 37,
        "agent",
        SESSION.width,
        SESSION.height,
      ),
    );
  const pitchX = SESSION.width + CLUSTER_GAP;
  const pitchY = SESSION.height + CLUSTER_GAP;

  function grid(positions: Record<string, { x: number; y: number }>) {
    const xs = [...new Set(Object.values(positions).map((p) => p.x))];
    const ys = [...new Set(Object.values(positions).map((p) => p.y))];
    return { columns: xs.length, rows: ys.length };
  }

  for (const [count, columns, rows] of [
    [4, 2, 2],
    [6, 3, 2],
    [8, 4, 2],
  ] as const) {
    it(`横屏 ${count} 个 → ${columns}×${rows}，竖屏 → ${rows}×${columns}`, () => {
      const boxes = sessions(count);
      const wide = tidy(boxes, [], { aspect: 16 / 9 });
      expect(grid(wide)).toEqual({ columns, rows });
      const tall = tidy(boxes, [], { aspect: 9 / 16 });
      expect(grid(tall)).toEqual({ columns: rows, rows: columns });
      for (const positions of [wide, tall]) {
        expect(overlaps(boxes, positions)).toEqual([]);
        for (const point of Object.values(positions)) {
          expect(point.x % pitchX).toBe(0);
          expect(point.y % pitchY).toBe(0);
        }
      }
    });
  }

  it("格子等大、间距是点阵单位的整数倍", () => {
    expect(pitchX % GRID_UNIT).toBe(0);
    expect(pitchY % GRID_UNIT).toBe(0);
    const positions = tidy(sessions(6), [], { aspect: 16 / 9 });
    expect(positions).toMatchObject({
      s1: { x: 0, y: 0 },
    });
    const xs = [...new Set(Object.values(positions).map((p) => p.x))].sort(
      (a, b) => a - b,
    );
    expect(xs).toEqual([0, pitchX, 2 * pitchX]);
  });

  it("按画面上的阅读顺序填格子，不按编号", () => {
    // 画面上：第一行 c、a，第二行 d、b（编号顺序是 a b c d）。
    const boxes = [
      placed("a", 900, 20, "agent", SESSION.width, SESSION.height),
      placed("b", 950, 700, "agent", SESSION.width, SESSION.height),
      placed("c", 0, 90, "agent", SESSION.width, SESSION.height),
      placed("d", 10, 640, "agent", SESSION.width, SESSION.height),
    ];
    const positions = tidy(boxes, [], { aspect: 16 / 9 });
    expect(positions).toEqual({
      c: { x: 0, y: 0 },
      a: { x: pitchX, y: 0 },
      d: { x: 0, y: pitchY },
      b: { x: pitchX, y: pitchY },
    });
  });

  for (const [count, columns] of [
    [5, 3],
    [7, 4],
  ] as const) {
    it(`${count} 个：不满的最后一行整体居中`, () => {
      const positions = tidy(sessions(count), [], { aspect: 16 / 9 });
      const rows = new Map<number, number[]>();
      for (const point of Object.values(positions)) {
        rows.set(point.y, [...(rows.get(point.y) ?? []), point.x]);
      }
      const last = [...rows.entries()].sort((a, b) => b[0] - a[0])[0]![1];
      const full = columns * SESSION.width + (columns - 1) * CLUSTER_GAP;
      const used =
        last.length * SESSION.width + (last.length - 1) * CLUSTER_GAP;
      const left = Math.min(...last);
      const right = full - (Math.max(...last) + SESSION.width);
      // 左右留白相等（取整到点阵，差不超过一格）。
      expect(Math.abs(left - right)).toBeLessThanOrEqual(GRID_UNIT);
      expect(left).toBe(Math.floor((full - used) / 2 / GRID_UNIT) * GRID_UNIT);
    });
  }

  it("幂等：整理两次，第二次位移为 0", () => {
    for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 13]) {
      const boxes = sessions(count);
      for (const aspect of [16 / 9, 9 / 16, 1]) {
        const first = tidy(boxes, [], { aspect });
        expect(again(boxes, [], first, { aspect }), `${count}`).toEqual(first);
      }
    }
  });

  it("尺寸不一时每列取最宽、每行取最高，不重叠、幂等", () => {
    const boxes = [
      placed("big", 0, 0, "node", 900, 600),
      placed("note", 1000, 0, "node", 260, 160),
      placed("w", 0, 800, "wb", 120, 40),
      placed("term", 1000, 800, "agent", SESSION.width, SESSION.height),
    ];
    const first = tidy(boxes, [], { aspect: 16 / 9 });
    expect(overlaps(boxes, first)).toEqual([]);
    expect(first.big).toEqual({ x: 0, y: 0 });
    // 列宽、行高向上取整到点阵：900 → 910，600 → 611。
    const up = (value: number) => Math.ceil(value / GRID_UNIT) * GRID_UNIT;
    expect(first.note).toEqual({ x: up(900) + CLUSTER_GAP, y: 0 });
    expect(first.w).toEqual({ x: 0, y: up(600) + CLUSTER_GAP });
    expect(first.term).toEqual({
      x: up(900) + CLUSTER_GAP,
      y: up(600) + CLUSTER_GAP,
    });
    expect(again(boxes, [], first, { aspect: 16 / 9 })).toEqual(first);
  });

  it("有连线时不走网格", () => {
    const boxes = sessions(4);
    const positions = tidy(boxes, [{ source: "s1", target: "s2" }], {
      aspect: 16 / 9,
    });
    // s1 → s2 拓扑分列：s2 在 s1 右侧一个横向层距之外，同一行。
    expect(positions.s2!.y).toBe(positions.s1!.y);
    expect(positions.s2!.x - positions.s1!.x).toBe(
      Math.ceil((SESSION.width + COLUMN) / GRID_UNIT) * GRID_UNIT,
    );
  });
});
