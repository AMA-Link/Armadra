import { describe, expect, it } from "vitest";
import {
  cubicAt,
  distToCubic,
  distToPolyline,
  distToSegment,
  flattenCubic,
  pointsBounds,
  rectBottom,
  rectCenter,
  rectContains,
  rectContainsPoint,
  rectFromPoints,
  rectInflate,
  rectIntersection,
  rectIntersects,
  rectRight,
  rectUnion,
  rectsBounds,
  vecAdd,
  vecDist,
  vecLerp,
  vecScale,
  vecSub,
} from "./math";

const r = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("vec", () => {
  it("基本运算", () => {
    expect(vecAdd({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
    expect(vecSub({ x: 3, y: 4 }, { x: 1, y: 2 })).toEqual({ x: 2, y: 2 });
    expect(vecScale({ x: 1, y: 2 }, 3)).toEqual({ x: 3, y: 6 });
    expect(vecDist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(vecLerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({
      x: 5,
      y: 10,
    });
  });
});

describe("rect", () => {
  it("边与中心", () => {
    expect(rectRight(r(1, 2, 3, 4))).toBe(4);
    expect(rectBottom(r(1, 2, 3, 4))).toBe(6);
    expect(rectCenter(r(0, 0, 10, 20))).toEqual({ x: 5, y: 10 });
  });
  it("点包含含边界", () => {
    expect(rectContainsPoint(r(0, 0, 10, 10), { x: 10, y: 10 })).toBe(true);
    expect(rectContainsPoint(r(0, 0, 10, 10), { x: 10.1, y: 5 })).toBe(false);
  });
  it("包含与相交", () => {
    expect(rectContains(r(0, 0, 10, 10), r(0, 0, 10, 10))).toBe(true);
    expect(rectContains(r(0, 0, 10, 10), r(5, 5, 6, 1))).toBe(false);
    expect(rectIntersects(r(0, 0, 10, 10), r(10, 10, 5, 5))).toBe(true);
    expect(rectIntersects(r(0, 0, 10, 10), r(11, 0, 5, 5))).toBe(false);
    expect(rectIntersects(r(0, 0, 10, 10), r(0, 11, 5, 5))).toBe(false);
  });
  it("交集与并集", () => {
    expect(rectIntersection(r(0, 0, 10, 10), r(5, 5, 10, 10))).toEqual(
      r(5, 5, 5, 5),
    );
    expect(rectIntersection(r(0, 0, 1, 1), r(5, 5, 1, 1))).toBeNull();
    expect(rectIntersection(r(0, 0, 1, 10), r(5, 0, 1, 1))).toBeNull();
    expect(rectUnion(r(0, 0, 1, 1), r(5, 5, 1, 1))).toEqual(r(0, 0, 6, 6));
  });
  it("包围盒", () => {
    expect(rectsBounds([])).toBeNull();
    expect(rectsBounds([r(1, 1, 2, 2), r(-1, 0, 1, 1)])).toEqual(
      r(-1, 0, 4, 3),
    );
    expect(pointsBounds([])).toBeNull();
    expect(
      pointsBounds([
        { x: 1, y: 5 },
        { x: -2, y: 3 },
      ]),
    ).toEqual(r(-2, 3, 3, 2));
  });
  it("外扩与对角点", () => {
    expect(rectInflate(r(0, 0, 10, 10), 2)).toEqual(r(-2, -2, 14, 14));
    expect(rectInflate(r(0, 0, 4, 4), -5)).toEqual(r(2, 2, 0, 0));
    expect(rectFromPoints({ x: 5, y: 1 }, { x: 1, y: 4 })).toEqual(
      r(1, 1, 4, 3),
    );
  });
});

describe("距离", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  it("点到线段", () => {
    expect(distToSegment({ x: 5, y: 3 }, a, b)).toBe(3);
    expect(distToSegment({ x: -3, y: 4 }, a, b)).toBe(5);
    expect(distToSegment({ x: 13, y: 4 }, a, b)).toBe(5);
    expect(distToSegment({ x: 3, y: 4 }, a, a)).toBe(5);
  });
  it("点到折线", () => {
    expect(distToPolyline(a, [])).toBe(Infinity);
    expect(distToPolyline({ x: 3, y: 4 }, [a])).toBe(5);
    expect(distToPolyline({ x: 10, y: 5 }, [a, b, { x: 10, y: 10 }])).toBe(0);
  });
  it("贝塞尔", () => {
    const p = [a, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }] as const;
    expect(cubicAt(...p, 0)).toEqual(a);
    expect(cubicAt(...p, 1)).toEqual({ x: 10, y: 0 });
    expect(cubicAt(...p, 0.5)).toEqual({ x: 5, y: 7.5 });
    expect(flattenCubic(...p, 4)).toHaveLength(5);
    expect(flattenCubic(...p, 0)).toHaveLength(2);
    expect(distToCubic({ x: 5, y: 7.5 }, ...p)).toBeLessThan(0.1);
    expect(distToCubic({ x: 5, y: 20 }, ...p)).toBeGreaterThan(12);
  });
});
