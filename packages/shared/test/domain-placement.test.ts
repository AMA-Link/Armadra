import { describe, expect, it } from "vitest";
import {
  LAYER_GAP,
  SIBLING_GAP,
  boxesTooClose,
  dispatchPlacement,
  type PlacementBox,
} from "../src/index.js";

/** 派发落点（契约 §50，#319）：两个方向各三条，含间距内的冲突回避。 */
const SIZE = { width: 400, height: 300 };
const main: PlacementBox = {
  id: "main",
  x: 100,
  y: 100,
  width: 400,
  height: 300,
};

describe("boxesTooClose", () => {
  const a = { x: 0, y: 0, width: 100, height: 100 };
  it("gap 为 0 时贴边不算", () => {
    expect(boxesTooClose(a, { x: 100, y: 0, width: 10, height: 10 })).toBe(
      false,
    );
    expect(boxesTooClose(a, { x: 99, y: 0, width: 10, height: 10 })).toBe(true);
  });
  it("间距不足 gap 算太近，恰好等于 gap 不算", () => {
    const b = { x: 100 + SIBLING_GAP, y: 0, width: 10, height: 10 };
    expect(boxesTooClose(a, b, SIBLING_GAP)).toBe(false);
    expect(boxesTooClose(a, { ...b, x: b.x - 1 }, SIBLING_GAP)).toBe(true);
  });
});

describe("dispatchPlacement · vertical", () => {
  it("没有从：主正下方一层、左对齐", () => {
    expect(dispatchPlacement([main], "main", SIZE, "vertical")).toEqual({
      x: 100,
      y: 400 + LAYER_GAP.vertical,
    });
  });

  it("已有从：接在最右那个的右边", () => {
    const y = 400 + LAYER_GAP.vertical;
    const child = { id: "c1", x: 100, y, width: 400, height: 300 };
    expect(
      dispatchPlacement([main, child], "main", SIZE, "vertical", ["c1"]),
    ).toEqual({ x: 500 + SIBLING_GAP, y });
  });

  it("落点离别的盒子不足兄弟间距就跳到挡路盒子的右边", () => {
    const y = 400 + LAYER_GAP.vertical;
    const blocker = { id: "b", x: 50, y: y + 50, width: 200, height: 100 };
    // 下沿离落点底边恰好一个间距：不算挡路。
    const far = {
      id: "f",
      x: 100,
      y: y + 300 + SIBLING_GAP,
      width: 50,
      height: 50,
    };
    const at = dispatchPlacement(
      [main, blocker, far],
      "main",
      SIZE,
      "vertical",
    );
    expect(at).toEqual({ x: 250 + SIBLING_GAP, y });
  });
});

describe("dispatchPlacement · horizontal", () => {
  it("没有从：主右侧一层、顶对齐", () => {
    expect(dispatchPlacement([main], "main", SIZE, "horizontal")).toEqual({
      x: 500 + LAYER_GAP.horizontal,
      y: 100,
    });
  });

  it("已有从：接在最下那个的下面", () => {
    const x = 500 + LAYER_GAP.horizontal;
    const child = { id: "c1", x, y: 100, width: 400, height: 300 };
    expect(
      dispatchPlacement([main, child], "main", SIZE, "horizontal", ["c1"]),
    ).toEqual({ x, y: 400 + SIBLING_GAP });
  });

  it("冲突时沿这一列往下让；让满 64 次就放到所有盒子右边", () => {
    const x = 500 + LAYER_GAP.horizontal;
    const blocker = { id: "b", x: x + 40, y: 150, width: 100, height: 100 };
    expect(
      dispatchPlacement([main, blocker], "main", SIZE, "horizontal"),
    ).toEqual({ x, y: 250 + SIBLING_GAP });
    // 一堵很高的墙：一步跳到它下面，不一格一格地挪。
    const wall = { id: "w", x: x + 10, y: 0, width: 10, height: 1_000_000 };
    expect(dispatchPlacement([main, wall], "main", SIZE, "horizontal")).toEqual(
      { x, y: 1_000_000 + SIBLING_GAP },
    );
    // 70 个间隔不够放下新节点的小盒子：跳满 64 次还被挡就放到所有盒子右边。
    const stack = Array.from({ length: 70 }, (_, index) => ({
      id: `s${index}`,
      x: x + 10,
      y: index * 400,
      width: 10,
      height: 10,
    }));
    expect(
      dispatchPlacement([main, ...stack], "main", SIZE, "horizontal"),
    ).toEqual({ x: x + 20 + LAYER_GAP.horizontal, y: 100 });
  });
});

it("任意已有盒子都与落点保持兄弟间距", () => {
  // 一排紧挨着的大终端：落点必须跳到最右那个之外。
  const row: PlacementBox[] = [0, 1, 2].map((index) => ({
    id: `t${index}`,
    x: 100 + index * 1000,
    y: 400 + LAYER_GAP.vertical,
    width: 960,
    height: 600,
  }));
  const size = { width: 960, height: 600 };
  const at = dispatchPlacement([main, ...row], "main", size, "vertical")!;
  for (const box of [main, ...row]) {
    expect(boxesTooClose(box, { ...at, ...size }, SIBLING_GAP)).toBe(false);
  }
});

it("主不在盒子里时返回 null", () => {
  expect(dispatchPlacement([], "main", SIZE, "vertical")).toBeNull();
});
