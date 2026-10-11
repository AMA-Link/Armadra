import { describe, expect, it } from "vitest";

import type { Box } from "../../geometry";
import {
  arrowHead,
  linkColor,
  linkView,
  ARROW_SIZE,
  LINK_CONTEXT_COLOR,
} from "./link-visual";

/**
 * 连线的画法（React Flow 计划 F06）。
 *
 * 「谁读谁」的箭头方向、标签、以及沿末段的箭头几何——全是纯函数，
 * 不需要挂画布。路由本身在 `route.test.ts`。
 */

const LEFT: Box = { x: 0, y: 0, width: 100, height: 100 };
const RIGHT: Box = { x: 300, y: 0, width: 100, height: 100 };

describe("箭头方向与标签（§21）", () => {
  it("终端 ↔ 终端：双箭头，标签是「共享上下文」", () => {
    const view = linkView(LEFT, RIGHT, "terminal", "terminal");
    expect(view.arrowStart).toBe(true);
    expect(view.arrowEnd).toBe(true);
    expect(view.labelKey).toBe("edge.context");
  });

  it("内容 → 终端：单向指向终端，标签按内容那一端的类型", () => {
    const view = linkView(LEFT, RIGHT, "sticky", "terminal");
    expect(view.arrowStart).toBe(false);
    expect(view.arrowEnd).toBe(true);
    expect(view.labelKey).toBe("edge.sticky");
  });

  it("终端 → 内容：箭头仍然指向终端，与拖动方向无关", () => {
    const view = linkView(LEFT, RIGHT, "terminal", "editor");
    expect(view.arrowStart).toBe(true);
    expect(view.arrowEnd).toBe(false);
    expect(view.labelKey).toBe("edge.file");
  });

  it("内容 ↔ 内容（含分组）：没有箭头，只表示归到一起", () => {
    const view = linkView(LEFT, RIGHT, "group", "sticky");
    expect(view.arrowStart).toBe(false);
    expect(view.arrowEnd).toBe(false);
  });
});

describe("派发线（ui-wave2 §3.2）", () => {
  it("只在子那一端画箭头，标签是「派发」", () => {
    const view = linkView(LEFT, RIGHT, "terminal", "terminal", "supervises");
    expect(view.arrowStart).toBe(false);
    expect(view.arrowEnd).toBe(true);
    expect(view.labelKey).toBe("edge.role.dispatch");
  });

  it("纵向锚走底 → 顶，对等线缺省走就近边", () => {
    const below: Box = { x: 0, y: 400, width: 100, height: 100 };
    const dispatch = linkView(
      LEFT,
      RIGHT,
      "terminal",
      "terminal",
      "supervises",
      "vertical",
    );
    expect([dispatch.route.sourceSide, dispatch.route.targetSide]).toEqual([
      "bottom",
      "top",
    ]);
    const peer = linkView(LEFT, below, "terminal", "terminal", "peer");
    expect(peer.labelKey).toBe("edge.context");
    expect([peer.route.sourceSide, peer.route.targetSide]).toEqual([
      "bottom",
      "top",
    ]);
  });
});

describe("贴边起笔", () => {
  it("目标在右边时从右侧边中点出发、落在目标左侧边中点", () => {
    const { route } = linkView(LEFT, RIGHT, "terminal", "terminal");
    expect(route.points).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 50 },
    ]);
  });

  it("目标在左边时两端整个换边（不从头部上方绕过去）", () => {
    const { route } = linkView(RIGHT, LEFT, "terminal", "terminal");
    expect(route.points).toEqual([
      { x: 300, y: 50 },
      { x: 100, y: 50 },
    ]);
  });
});

describe("箭头几何", () => {
  it("两条倒刺都落在离箭尖 ARROW_SIZE 的地方", () => {
    const d = arrowHead({ x: 100, y: 0 }, { x: 0, y: 0 });
    const points = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/gu)].map(
      ([, x, y]) => ({ x: Number(x), y: Number(y) }),
    );
    expect(points).toHaveLength(3);
    for (const barb of [points[0]!, points[2]!]) {
      expect(Math.hypot(barb.x - 100, barb.y - 0)).toBeCloseTo(ARROW_SIZE, 6);
    }
    // 中间那个点是箭尖本身。
    expect(points[1]).toEqual({ x: 100, y: 0 });
  });

  it("两端重合时不画箭头（除以 0 的方向没有意义）", () => {
    expect(arrowHead({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe("");
  });
});

describe("连线颜色（上下文与派发分色）", () => {
  it("上下文线用专用色；派发线用主的簇色；选中与投递闪动都是品牌色", () => {
    expect(linkColor({ supervises: false })).toBe(LINK_CONTEXT_COLOR);
    expect(LINK_CONTEXT_COLOR).toBe("var(--link-context)");
    expect(
      linkColor({ supervises: true, familyColor: "var(--node-color-2)" }),
    ).toBe("var(--node-color-2)");
    expect(linkColor({ supervises: true })).toBe("var(--brand)");
    expect(linkColor({ supervises: false, selected: true })).toBe(
      "var(--brand)",
    );
    expect(linkColor({ supervises: true, flashing: true })).toBe(
      "var(--brand)",
    );
  });
});
