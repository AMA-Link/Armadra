import { describe, expect, it } from "vitest";
import {
  NODE_TYPES,
  DEFAULT_NODE_COLOR,
  GOLDEN_RATIO,
  GRID_UNIT,
} from "@armadra/shared";

import { t } from "@/app/preferences-store";
import {
  NODE_BODY,
  NODE_META,
  COLLAPSED_HEIGHT,
  defaultNodeSize,
  minNodeSize,
  nodeMeta,
} from "./registry";
import { HEADER_HEIGHT, NODE_BORDER_WIDTH, TERMINAL_PADDING } from "./geometry";
import { COLLAPSED_HEIGHT as STORED_COLLAPSED_HEIGHT } from "../store/defaults";

/** 计划书 §3.4 的尺寸表（黄金比例，#684），逐字抄一遍作为回归基线。 */
const EXPECTED = {
  terminal: { default: [715, 442], min: [273, 169] },
  sticky: { default: [273, 169], min: [169, 104] },
  group: { default: [884, 546], min: [169, 104] },
  editor: { default: [715, 442], min: [273, 169] },
  diff: { default: [1157, 715], min: [442, 273] },
  files: { default: [273, 442], min: [169, 273] },
  browser: { default: [1157, 715], min: [442, 273] },
  automation: { default: [442, 273], min: [273, 169] },
  agentActivity: { default: [442, 273], min: [273, 169] },
} as const;

describe("node registry", () => {
  it("covers every node type exactly once", () => {
    expect(Object.keys(NODE_META).sort()).toEqual([...NODE_TYPES].sort());
    expect(Object.keys(NODE_BODY).sort()).toEqual([...NODE_TYPES].sort());
  });

  it("answers metadata lookups for every type", () => {
    for (const type of NODE_TYPES) {
      expect(nodeMeta(type).labelKey).toBe(`node.${type}`);
      expect(defaultNodeSize(type).width).toBeGreaterThan(0);
      expect(minNodeSize(type).width).toBeGreaterThan(0);
    }
  });

  it("gives the browser node an 89×55-cell golden-ratio viewport (§3.4)", () => {
    expect(NODE_META.browser.defaultSize).toEqual({ width: 1157, height: 715 });
  });

  it("keeps every default and minimum size a whole number of grid cells", () => {
    for (const type of NODE_TYPES) {
      for (const size of [
        NODE_META[type].defaultSize,
        NODE_META[type].minSize,
      ]) {
        expect(size.width % GRID_UNIT).toBe(0);
        expect(size.height % GRID_UNIT).toBe(0);
      }
    }
  });

  it("keeps every default and minimum size at the golden ratio within 1px", () => {
    for (const type of NODE_TYPES) {
      const { defaultSize, minSize } = NODE_META[type];
      for (const size of [defaultSize, minSize]) {
        const long = Math.max(size.width, size.height);
        const short = Math.min(size.width, size.height);
        expect(Math.abs(long - short * GOLDEN_RATIO)).toBeLessThanOrEqual(1);
        // 文件列表竖长（1:φ），其余横向（φ:1）。
        expect(size.width > size.height).toBe(type !== "files");
      }
    }
  });

  it("matches the §3.4 size table", () => {
    for (const type of NODE_TYPES) {
      const meta = NODE_META[type];
      const expected = EXPECTED[type];
      expect([meta.defaultSize.width, meta.defaultSize.height]).toEqual([
        ...expected.default,
      ]);
      expect([meta.minSize.width, meta.minSize.height]).toEqual([
        ...expected.min,
      ]);
    }
  });

  it("never lets the default size fall below the minimum", () => {
    for (const type of NODE_TYPES) {
      const meta = NODE_META[type];
      expect(meta.defaultSize.width).toBeGreaterThanOrEqual(meta.minSize.width);
      expect(meta.defaultSize.height).toBeGreaterThanOrEqual(
        meta.minSize.height,
      );
    }
  });

  it("gives bridge handles to every type but group (§21)", () => {
    const withoutHandles = NODE_TYPES.filter(
      (type) => !NODE_META[type].hasBridgeHandles,
    );
    // 分组只是画框；两张 Host 侧卡片的内容都在 Host 上，连过去读不到东西。
    expect(withoutHandles).toEqual(["group", "automation", "agentActivity"]);
  });

  it("defaults to the palette blue, sticky to the palette yellow", () => {
    expect(NODE_META.sticky.defaultColor).toBe("#ffd60a");
    for (const type of NODE_TYPES) {
      if (type === "sticky") continue;
      expect(NODE_META[type].defaultColor).toBe(DEFAULT_NODE_COLOR);
    }
  });

  it("collapses to the header height from §3.4", () => {
    expect(COLLAPSED_HEIGHT).toBe(32);
    expect(HEADER_HEIGHT).toBe(30);
    expect(COLLAPSED_HEIGHT).toBe(HEADER_HEIGHT + NODE_BORDER_WIDTH * 2);
    expect(STORED_COLLAPSED_HEIGHT).toBe(COLLAPSED_HEIGHT);
  });

  /**
   * 外壳吃掉的像素（契约 §3.4，2026-09-19）。一个默认终端 715×442 里，
   * 头部 + 边框 + 内边距横向只拿走 10px、纵向 40px，剩下的全是 xterm 的。
   */
  it("leaves a 715×442 terminal 705×402 of content", () => {
    const { width, height } = NODE_META.terminal.defaultSize;
    expect(TERMINAL_PADDING).toBe(4);
    const content = {
      width: width - NODE_BORDER_WIDTH * 2 - TERMINAL_PADDING * 2,
      height:
        height - NODE_BORDER_WIDTH * 2 - HEADER_HEIGHT - TERMINAL_PADDING * 2,
    };
    expect(content).toEqual({ width: 705, height: 402 });
  });

  it("has a translatable label key and an icon for every type", () => {
    for (const type of NODE_TYPES) {
      expect(NODE_META[type].labelKey).toBe(`node.${type}`);
      expect(t(NODE_META[type].labelKey)).toMatch(/[一-龥]/);
      expect(NODE_META[type].icon).toBeTypeOf("object");
    }
  });
});
