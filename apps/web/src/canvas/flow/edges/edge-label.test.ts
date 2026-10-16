import { describe, expect, it } from "vitest";

import type { Box } from "../../geometry";
import {
  labelFontSize,
  placeLabelOn,
  type Stroke,
  labelSize,
  LABEL_SCREEN_FONT,
  placeLabel,
  textWidth,
} from "./edge-label";
import { routeFor } from "./link-visual";

/** 关系标签的字号与摆放（#318）。 */

const box = (x: number, y: number, width = 100, height = 100): Box => ({
  x,
  y,
  width,
  height,
});

function overlaps(
  label: { x: number; y: number; width: number; height: number },
  rect: Box,
): boolean {
  return (
    label.x - label.width / 2 < rect.x + rect.width &&
    label.x + label.width / 2 > rect.x &&
    label.y - label.height / 2 < rect.y + rect.height &&
    label.y + label.height / 2 > rect.y
  );
}

describe("字号", () => {
  it("缩小画布时按屏幕字号放大，放大画布时跟着画布", () => {
    expect(labelFontSize(1)).toBe(LABEL_SCREEN_FONT);
    expect(labelFontSize(0.5)).toBe(22);
    expect(labelFontSize(2)).toBe(LABEL_SCREEN_FONT);
  });

  it("中文按一个字宽估，西文按 0.6", () => {
    expect(textWidth("派发", 10)).toBe(20);
    expect(textWidth("ab", 10)).toBe(12);
    expect(labelSize("派发", 10).height).toBe(14);
  });
});

describe("摆放", () => {
  it("落在放得下的最长一段的中点", () => {
    const label = placeLabel(
      [
        { x: 0, y: 0 },
        { x: 0, y: 20 },
        { x: 400, y: 20 },
        { x: 400, y: 40 },
      ],
      "派发",
      11,
      [],
    );
    expect(label!.x).toBeCloseTo(200);
    expect(label).toMatchObject({ y: 20, fontSize: 11 });
  });

  it("中点压着节点时沿这一段往两头挪", () => {
    const blocker = box(150, 0, 100, 40);
    const label = placeLabel(
      [
        { x: 0, y: 20 },
        { x: 400, y: 20 },
        { x: 400, y: 300 },
      ],
      "共享上下文",
      11,
      [blocker],
    );
    expect(label).toMatchObject({ y: 20 });
    expect(overlaps(label!, blocker)).toBe(false);
    // 仍然落在这一段上（x 在 0 到 400 之间）。
    expect(label!.x - label!.width / 2).toBeGreaterThanOrEqual(0);
  });

  it("哪儿都放不下就不画", () => {
    const label = placeLabel(
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
      ],
      "派发",
      11,
      [box(-20, -20, 40, 50)],
    );
    expect(label).toBeNull();
  });

  it("截图里的扇出：窄缝里退到小字号，三条派发线的标签都在两排之间，不压任何节点", () => {
    const coordinator = box(660, 0, 620, 390);
    const agents = [
      box(0, 420, 620, 390),
      box(660, 420, 620, 390),
      box(1320, 420, 620, 390),
    ];
    const all = [coordinator, ...agents];
    // 45% 缩放：屏幕 11px 在画布里约 24。
    const fontSize = labelFontSize(0.45);
    for (const agent of agents) {
      const others = agents.filter((rect) => rect !== agent);
      const route = routeFor(coordinator, agent, others, "vertical");
      const label = placeLabel(route.points, "派发", fontSize, all);
      expect(label).not.toBeNull();
      expect(label!.fontSize).toBeLessThan(fontSize);
      for (const rect of all) expect(overlaps(label!, rect)).toBe(false);
    }
  });
});

describe("不压别的线", () => {
  it("别的线段占着中点时挪开", () => {
    const crossing: Box = { x: 197, y: -50, width: 6, height: 140 };
    const label = placeLabel(
      [
        { x: 0, y: 20 },
        { x: 400, y: 20 },
      ],
      "派发",
      11,
      [crossing],
    );
    expect(label).not.toBeNull();
    expect(overlaps(label!, crossing)).toBe(false);
  });
});

describe("一组线只摆一枚标签（#397）", () => {
  const stroke = (
    edge: string,
    k: number,
    bundle: string,
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): Stroke => {
    const horizontal = a.y === b.y;
    return {
      edge,
      k,
      bundle,
      horizontal,
      at: horizontal ? a.y : a.x,
      box: {
        x: Math.min(a.x, b.x) - 3,
        y: Math.min(a.y, b.y) - 3,
        width: Math.abs(b.x - a.x) + 6,
        height: Math.abs(b.y - a.y) + 6,
      },
    };
  };
  // 一个主向左右两个子派发：共用主干 y = 100，两条竖直的落脚线在 x = 0 与 x = 600。
  const left = [
    { x: 300, y: 80 },
    { x: 300, y: 100 },
    { x: 0, y: 100 },
    { x: 0, y: 120 },
  ];
  const right = [
    { x: 300, y: 80 },
    { x: 300, y: 100 },
    { x: 600, y: 100 },
    { x: 600, y: 120 },
  ];
  const lines = [
    { edge: "l", bundle: "g", points: left },
    { edge: "r", bundle: "g", points: right },
  ];
  const strokes = [
    ...left.slice(1).map((p, i) => stroke("l", i + 1, "g", left[i]!, p)),
    ...right.slice(1).map((p, i) => stroke("r", i + 1, "g", right[i]!, p)),
  ];

  it("只返回一个位置，落在被两条线共用的主干上，且不被落脚线穿过", () => {
    const label = placeLabelOn(lines, "派发", 11, [], strokes);
    expect(label).not.toBeNull();
    expect(label!.y).toBe(100);
    // 两条竖线（x = 300 的出线、x = 0 / 600 的落脚线）都不在标签里。
    for (const x of [0, 300, 600]) {
      expect(
        label!.x - label!.width / 2 < x + 3 &&
          label!.x + label!.width / 2 > x - 3,
      ).toBe(false);
    }
  });

  it("共线的同束线段不算穿过：标签压在主干上是预期的", () => {
    const label = placeLabelOn(lines.slice(0, 1), "派发", 11, [], strokes);
    expect(label).not.toBeNull();
  });

  it("别的束的线横穿主干附近时，标签挪到不被穿过的位置", () => {
    const other = stroke("o", 1, "h", { x: 150, y: 0 }, { x: 150, y: 300 });
    const label = placeLabelOn(lines, "派发", 11, [], [...strokes, other]);
    expect(label).not.toBeNull();
    expect(
      label!.x - label!.width / 2 < 153 && label!.x + label!.width / 2 > 147,
    ).toBe(false);
  });

  it("曲线占掉的那一截不放标签", () => {
    // 主干很短（60），两头各让出 30：中间放不下一枚标签，退到整段中点的兜底，
    // 之后因压着两头的落脚线而被拒绝。
    const short = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 60, y: 100 },
      { x: 60, y: 200 },
    ];
    const segs = short
      .slice(1)
      .map((p, i) => stroke("s", i + 1, "s", short[i]!, p));
    const label = placeLabelOn(
      [
        {
          edge: "s",
          bundle: "s",
          points: short,
          cuts: [
            { before: 30, after: 30 },
            { before: 30, after: 30 },
          ],
        },
      ],
      "派发",
      11,
      [],
      segs,
    );
    expect(label?.y).not.toBe(100);
  });
});
