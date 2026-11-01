import { describe, expect, it } from "vitest";

import {
  GOLDEN_CELLS,
  GOLDEN_RATIO,
  GOLDEN_TOLERANCE_PX,
  GRID_SPACINGS,
  GRID_UNIT,
  WORKTREE_FRAME_SIZE,
  aspectOf,
  defaultNodeSizeOf,
  goldenSize,
  isGoldenSize,
  minNodeSizeOf,
  scaleGoldenSize,
} from "./golden-ratio.js";
import { NODE_TYPES } from "./primitives.js";

describe("goldenSize", () => {
  it("φ 是 (1+√5)/2", () => {
    expect(GOLDEN_RATIO).toBeCloseTo(1.6180339887, 9);
  });

  it("横向以宽为长边，竖向以高为长边", () => {
    expect(goldenSize(960)).toEqual({ width: 960, height: 593 });
    expect(goldenSize(640, "portrait")).toEqual({ width: 396, height: 640 });
  });

  it("任意长边的比例都在 1px 容差内", () => {
    for (let long = 100; long <= 2000; long += 1) {
      expect(isGoldenSize(goldenSize(long))).toBe(true);
      expect(isGoldenSize(goldenSize(long, "portrait"))).toBe(true);
    }
  });
});

describe("节点尺寸表", () => {
  it.each(NODE_TYPES)("%s 的默认与最小尺寸都是黄金比例", (type) => {
    for (const size of [defaultNodeSizeOf(type), minNodeSizeOf(type)]) {
      expect(isGoldenSize(size)).toBe(true);
      expect(Math.abs(aspectOf(size) - GOLDEN_RATIO)).toBeLessThan(0.02);
    }
  });

  it.each(NODE_TYPES)("%s 的默认尺寸不小于最小尺寸", (type) => {
    const size = defaultNodeSizeOf(type);
    const min = minNodeSizeOf(type);
    expect(size.width).toBeGreaterThanOrEqual(min.width);
    expect(size.height).toBeGreaterThanOrEqual(min.height);
  });

  it("文件列表竖长，其余横向", () => {
    for (const type of NODE_TYPES) {
      const { width, height } = defaultNodeSizeOf(type);
      expect(width > height).toBe(type !== "files");
    }
  });

  it("worktree Frame 是黄金比例且装得下默认终端", () => {
    expect(isGoldenSize(WORKTREE_FRAME_SIZE)).toBe(true);
    expect(WORKTREE_FRAME_SIZE).toEqual({ width: 1157, height: 715 });
    expect(WORKTREE_FRAME_SIZE.width).toBeGreaterThan(
      defaultNodeSizeOf("terminal").width,
    );
    expect(WORKTREE_FRAME_SIZE.height).toBeGreaterThan(
      defaultNodeSizeOf("terminal").height,
    );
  });
});

describe("点阵与格数", () => {
  it("点阵间距是 φ 阶梯上的斐波那契数，第一档是基准单位", () => {
    expect(GRID_SPACINGS[0]).toBe(GRID_UNIT);
    expect([...GRID_SPACINGS]).toEqual([13, 21, 34]);
    for (let index = 1; index < GRID_SPACINGS.length; index += 1) {
      const ratio = GRID_SPACINGS[index]! / GRID_SPACINGS[index - 1]!;
      expect(Math.abs(ratio - GOLDEN_RATIO)).toBeLessThan(0.04);
    }
  });

  it("档位里每一对格数的比例都在 1px 容差内，并且穷举不漏（长边到 89 格）", () => {
    for (const [long, short] of GOLDEN_CELLS) {
      expect(
        Math.abs(long * GRID_UNIT - short * GRID_UNIT * GOLDEN_RATIO),
      ).toBeLessThanOrEqual(GOLDEN_TOLERANCE_PX);
    }
    const found: [number, number][] = [];
    for (let long = 3; long <= 89; long += 1) {
      for (let short = 2; short < long; short += 1) {
        if (
          Math.abs(long * GRID_UNIT - short * GRID_UNIT * GOLDEN_RATIO) <=
          GOLDEN_TOLERANCE_PX
        ) {
          found.push([long, short]);
        }
      }
    }
    expect(found).toEqual(GOLDEN_CELLS.map(([a, b]) => [a, b]));
  });

  it.each(NODE_TYPES)("%s 的默认与最小尺寸是基准单位的整数倍", (type) => {
    for (const size of [defaultNodeSizeOf(type), minNodeSizeOf(type)]) {
      expect(size.width % GRID_UNIT).toBe(0);
      expect(size.height % GRID_UNIT).toBe(0);
    }
    expect(WORKTREE_FRAME_SIZE.width % GRID_UNIT).toBe(0);
    expect(WORKTREE_FRAME_SIZE.height % GRID_UNIT).toBe(0);
  });

  it("会话（终端）比上一版小：715×442", () => {
    expect(defaultNodeSizeOf("terminal")).toEqual({ width: 715, height: 442 });
  });
});

describe("scaleGoldenSize", () => {
  it("缩放后落在点阵上、仍是黄金比例，方向不变", () => {
    const small = scaleGoldenSize(defaultNodeSizeOf("terminal"), 0.5);
    // 715 × 0.5 = 357.5 → 不超过它的最大一档是 21 格 = 273
    expect(small).toEqual({ width: 273, height: 169 });
    expect(isGoldenSize(small)).toBe(true);
    const tall = scaleGoldenSize(defaultNodeSizeOf("files"), 0.5);
    expect(tall.height).toBeGreaterThan(tall.width);
    expect(tall.width % GRID_UNIT).toBe(0);
    expect(isGoldenSize(tall)).toBe(true);
  });

  it("一档都放不下时取最小档", () => {
    expect(scaleGoldenSize(defaultNodeSizeOf("terminal"), 0.01)).toEqual({
      width: 169,
      height: 104,
    });
  });
});
