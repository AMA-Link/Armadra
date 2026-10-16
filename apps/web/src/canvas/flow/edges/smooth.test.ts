import { describe, expect, it } from "vitest";
import type { Position } from "@armadra/shared";

import type { Box } from "../../geometry";
import {
  cornerCuts,
  CURVE_MARGIN,
  LONG_CUT,
  MIN_CUT,
  SOFT_RADIUS,
  softPath,
} from "./smooth";

/**
 * 正交折线的平滑（#397）：没有尖角、半径随间距自适应、避开拐角内侧的节点。
 */

const P = (x: number, y: number): Position => ({ x, y });

/** 路径里的二次曲线数；每个内部拐角必须各有一段，没有直接的 `L` 折角。 */
function curves(d: string): number {
  return (d.match(/Q/g) ?? []).length;
}

describe("拐角半径", () => {
  it("两侧都够长：切入距离就是基准半径，两侧相等", () => {
    const cuts = cornerCuts([P(0, 0), P(0, 400), P(400, 400)]);
    expect(cuts).toEqual([{ before: SOFT_RADIUS, after: SOFT_RADIUS }]);
  });

  it("一侧很短：短侧用尽（不超过连着端点那段的 75%），长侧拉成缓坡但不超过上限", () => {
    const [cut] = cornerCuts([P(0, 0), P(0, 15), P(600, 15)]);
    expect(cut!.before).toBeCloseTo(11.25);
    expect(cut!.after).toBeCloseTo(45);
    expect(cut!.after).toBeLessThanOrEqual(LONG_CUT);
  });

  it("中间段被两个拐角分享，不会互相吃掉", () => {
    const points = [P(0, 0), P(0, 100), P(30, 100), P(30, 300)];
    const cuts = cornerCuts(points);
    // 中间那段长 30：两个拐角在它上面各占不超过一半。
    expect(cuts[0]!.after + cuts[1]!.before).toBeLessThanOrEqual(30 + 1e-9);
    for (const cut of cuts) {
      expect(cut.before).toBeGreaterThanOrEqual(MIN_CUT);
      expect(cut.after).toBeGreaterThanOrEqual(MIN_CUT);
    }
  });

  it("拐角内侧有节点：弧缩小到离它至少 CURVE_MARGIN，但不小于下限", () => {
    const points = [P(0, 0), P(0, 400), P(400, 400)];
    // 节点贴在拐角内侧，离两段线都是 14。
    const wall: Box = { x: 14, y: 250, width: 100, height: 136 };
    const plain = cornerCuts(points)[0]!;
    const [cut] = cornerCuts(points, [wall]);
    expect(cut!.before).toBeLessThan(plain.before);
    expect(cut!.before).toBeGreaterThanOrEqual(MIN_CUT);
    // 采样检查：缩小后的曲线没有进入外扩带。
    const a = P(0, 400 - cut!.before);
    const b = P(cut!.after, 400);
    for (const t of [0.25, 0.5, 0.75]) {
      const u = 1 - t;
      const x = u * u * a.x + 2 * u * t * 0 + t * t * b.x;
      const y = u * u * a.y + 2 * u * t * 400 + t * t * b.y;
      const inside =
        x > wall.x - CURVE_MARGIN &&
        x < wall.x + wall.width + CURVE_MARGIN &&
        y > wall.y - CURVE_MARGIN &&
        y < wall.y + wall.height + CURVE_MARGIN;
      expect(inside).toBe(false);
    }
  });
});

describe("路径", () => {
  it("每个内部拐角一段二次曲线，没有直接折角", () => {
    const points = [P(0, 0), P(0, 50), P(200, 50), P(200, 300), P(500, 300)];
    const d = softPath(points);
    expect(curves(d)).toBe(points.length - 2);
    expect(d.startsWith("M 0,0")).toBe(true);
    expect(d.endsWith("L 500,300")).toBe(true);
  });

  it("曲线与两侧线段相切：起点在来向线段上，终点在去向线段上", () => {
    const d = softPath([P(0, 0), P(0, 200), P(200, 200)]);
    const match = d.match(
      /L ([\d.]+),([\d.]+) Q ([\d.]+),([\d.]+) ([\d.]+),([\d.]+)/,
    );
    expect(match).not.toBeNull();
    const [, ax, , cx, cy, , by] = match!.map(Number) as number[];
    // 起点与拐点同在 x = 0 的竖线上，终点与拐点同在 y = 200 的横线上。
    expect(ax).toBe(0);
    expect(cx).toBe(0);
    expect(cy).toBe(200);
    expect(by).toBe(200);
  });

  it("两点之间就是一条直线，没有曲线", () => {
    expect(softPath([P(0, 0), P(100, 0)])).toBe("M 0,0 L 100,0");
  });
});
