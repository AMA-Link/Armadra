import { describe, expect, it } from "vitest";

import type { Box } from "../../geometry";
import {
  labelFontSize,
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
    expect(label).toMatchObject({ x: 200, y: 20, fontSize: 11 });
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
    expect(label).toMatchObject({ x: 80, y: 20 });
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
