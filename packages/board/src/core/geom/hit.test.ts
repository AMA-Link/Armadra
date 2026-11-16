import { describe, expect, it } from "vitest";
import { hitAll, hitTop, marquee, type HitSource } from "./hit";
import { createGridIndex } from "./spatial";

const r = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

function make(extra: Partial<HitSource> = {}) {
  const index = createGridIndex<string>();
  index.insert("under", r(0, 0, 100, 100));
  index.insert("over", r(50, 50, 100, 100));
  index.insert("far", r(1000, 1000, 10, 10));
  const z: Record<string, number> = { under: 1, over: 2, far: 0 };
  return {
    index,
    order: (id: string) => z[id] ?? 0,
    ...extra,
  } satisfies HitSource;
}

describe("hit", () => {
  it("按 z 取最上", () => {
    const s = make();
    expect(hitAll(s, { x: 60, y: 60 })).toEqual(["over", "under"]);
    expect(hitTop(s, { x: 60, y: 60 })).toBe("over");
    expect(hitTop(s, { x: 10, y: 10 })).toBe("under");
    expect(hitTop(s, { x: 500, y: 500 })).toBeUndefined();
  });
  it("容差外扩", () => {
    const s = make();
    expect(hitTop(s, { x: 104, y: 10 })).toBeUndefined();
    expect(hitTop(s, { x: 104, y: 10 }, 5)).toBe("under");
  });
  it("精确回调与过滤", () => {
    const s = make({
      precise: (id) => id !== "over",
      filter: (id) => id !== "far",
    });
    expect(hitAll(s, { x: 60, y: 60 })).toEqual(["under"]);
    expect(
      hitAll(make({ filter: (id) => id !== "over" }), { x: 60, y: 60 }),
    ).toEqual(["under"]);
  });
  it("框选：相交与完全包含，按 z 升序", () => {
    const s = make();
    expect(marquee(s, r(40, 40, 30, 30))).toEqual(["under", "over"]);
    expect(marquee(s, r(40, 40, 30, 30), "contain")).toEqual([]);
    expect(marquee(s, r(-10, -10, 200, 200), "contain")).toEqual([
      "under",
      "over",
    ]);
    expect(
      marquee(make({ filter: (id) => id === "over" }), r(-10, -10, 200, 200)),
    ).toEqual(["over"]);
  });
});
