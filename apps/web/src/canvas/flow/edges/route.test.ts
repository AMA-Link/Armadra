import { describe, expect, it } from "vitest";
import type { Position } from "@armadra/shared";

import { anchorPoint, type Box } from "../../geometry";
import { routeFor } from "./link-visual";
import {
  midpointOf,
  roundedPath,
  ROUTE_CLEARANCE,
  routeEdge,
  simplify,
  type Route,
} from "./route";

/**
 * 避障正交路由（#318）。
 *
 * 核心断言只有一条：路线的每一段都不进入任何节点外扩 {@link ROUTE_CLEARANCE}
 * 的范围——两端自己只豁免首段 / 末段（那一段就是从边中点垂直出去的）。
 */

const box = (x: number, y: number, width = 100, height = 100): Box => ({
  x,
  y,
  width,
  height,
});

/** 横竖线段是否进入矩形外扩 `pad` 后的内部。 */
function hits(a: Position, b: Position, rect: Box, pad: number): boolean {
  const l = rect.x - pad;
  const t = rect.y - pad;
  const r = rect.x + rect.width + pad;
  const btm = rect.y + rect.height + pad;
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return minX < r && maxX > l && minY < btm && maxY > t;
}

function expectClear(
  route: Route,
  source: Box,
  target: Box,
  obstacles: readonly Box[],
): void {
  const { points } = route;
  const last = points.length - 2;
  for (let k = 0; k <= last; k += 1) {
    const a = points[k]!;
    const b = points[k + 1]!;
    // 只走横竖线。
    expect(a.x === b.x || a.y === b.y).toBe(true);
    for (const rect of obstacles) {
      expect(hits(a, b, rect, ROUTE_CLEARANCE - 0.5)).toBe(false);
    }
    if (k !== 0) expect(hits(a, b, source, ROUTE_CLEARANCE - 0.5)).toBe(false);
    if (k !== last) {
      expect(hits(a, b, target, ROUTE_CLEARANCE - 0.5)).toBe(false);
    }
  }
}

/**
 * 主人截图里的那一排（画布单位，按 45% 缩放换算）：协调者在上，三个 Agent
 * 紧贴在下面一排，上下只隔 30，左右隔 40；再上下各有一个节点。
 */
const COORDINATOR = box(660, 0, 620, 390);
const AGENTS = [
  box(0, 420, 620, 390),
  box(660, 420, 620, 390),
  box(1320, 420, 620, 390),
];
const ABOVE = box(0, -320, 620, 260);
const BELOW = box(660, 840, 620, 300);
const FAN_OUT = [COORDINATOR, ...AGENTS, ABOVE, BELOW];

describe("派发扇出（截图里的布局）", () => {
  for (const [index, agent] of AGENTS.entries()) {
    it(`协调者 → Agent ${index + 1}：底 → 顶，全程在两排之间的窄缝里，不压任何节点`, () => {
      const obstacles = FAN_OUT.filter(
        (rect) => rect !== COORDINATOR && rect !== agent,
      );
      const route = routeFor(COORDINATOR, agent, obstacles, "vertical");
      expect(route.sourceSide).toBe("bottom");
      expect(route.targetSide).toBe("top");
      expect(route.points[0]).toEqual(anchorPoint(COORDINATOR, "bottom"));
      expect(route.points.at(-1)).toEqual(anchorPoint(agent, "top"));
      expectClear(route, COORDINATOR, agent, obstacles);
      // 不越过协调者的底边、也不压到 Agent 的标题栏。
      for (const point of route.points) {
        expect(point.y).toBeGreaterThanOrEqual(390);
        expect(point.y).toBeLessThanOrEqual(420);
      }
      // 最多两个拐弯：下 → 横 → 下。
      expect(route.points.length).toBeLessThanOrEqual(4);
    });
  }

  it("正下方那个是一条竖直短线", () => {
    const route = routeFor(COORDINATOR, AGENTS[1]!, [], "vertical");
    expect(route.points).toEqual([
      { x: 970, y: 390 },
      { x: 970, y: 420 },
    ]);
  });
});

describe("对等线绕开挡在中间的节点", () => {
  it("两端同高、中间横着一个终端：从上方或下方绕过去", () => {
    const source = box(0, 0);
    const target = box(800, 0);
    const wall = box(350, -60, 200, 220);
    const route = routeFor(source, target, [wall]);
    expectClear(route, source, target, [wall]);
    expect(route.points.length).toBeGreaterThan(2);
  });

  it("目标在一圈节点后面也找得到路", () => {
    const source = box(0, 0);
    const target = box(600, 600);
    const obstacles = [
      box(450, 450, 400, 60),
      box(450, 790, 400, 60),
      box(450, 510, 60, 280),
    ];
    const route = routeFor(source, target, obstacles);
    expectClear(route, source, target, obstacles);
  });

  it("没有障碍时同一行的两个节点就是一条直线", () => {
    const route = routeFor(box(0, 0), box(300, 0));
    expect(route.points).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 50 },
    ]);
  });

  it("叠在一起的两个节点退回一条折线，不抛错", () => {
    const route = routeFor(box(0, 0), box(10, 10));
    expect(route.points.length).toBeGreaterThanOrEqual(2);
  });
});

describe("防抖：上一次的边有黏性", () => {
  // 斜对角、两条轴上空隙一样：右 → 顶 与 底 → 左 两个 L 一样长、各拐一次。
  const source = box(0, 0);
  const target = box(300, 300);

  it("斜对角走只拐一次的 L，而不是拐两次的 Z", () => {
    const route = routeFor(source, target);
    expect(route.points).toHaveLength(3);
    expect([route.sourceSide, route.targetSide]).toEqual(["right", "top"]);
  });

  it("上一次走的是底 → 左，平手时继续走它", () => {
    const route = routeFor(source, target, [], "free", {
      source: "bottom",
      target: "left",
    });
    expect([route.sourceSide, route.targetSide]).toEqual(["bottom", "left"]);
  });
});

describe("性能", () => {
  it("100 个节点的网格上 50 条线，每条只看附近的障碍，总耗时可控", () => {
    const nodes: Box[] = [];
    for (let row = 0; row < 10; row += 1) {
      for (let col = 0; col < 10; col += 1) {
        nodes.push(box(col * 500, row * 360, 420, 280));
      }
    }
    const near = (a: Box, b: Box) =>
      nodes.filter(
        (rect) =>
          rect !== a &&
          rect !== b &&
          rect.x < Math.max(a.x + a.width, b.x + b.width) + 240 &&
          rect.x + rect.width > Math.min(a.x, b.x) - 240 &&
          rect.y < Math.max(a.y + a.height, b.y + b.height) + 240 &&
          rect.y + rect.height > Math.min(a.y, b.y) - 240,
      );
    const started = performance.now();
    for (let k = 0; k < 50; k += 1) {
      const a = nodes[k]!;
      const b = nodes[(k * 7 + 13) % 100]!;
      if (a === b) continue;
      const obstacles = near(a, b);
      const route = routeFor(a, b, obstacles);
      expectClear(route, a, b, obstacles);
    }
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("路径与取点", () => {
  it("simplify 去掉共线点与重复点", () => {
    expect(
      simplify([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 0, y: 20 },
        { x: 10, y: 20 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 20 },
      { x: 10, y: 20 },
    ]);
  });

  it("拐角是圆角，半径不超过相邻两段的一半", () => {
    const d = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 100, y: 10 },
      ],
      14,
    );
    expect(d).toBe("M 0,0 L 0,5 Q 0,10 5,10 L 100,10");
  });

  it("midpointOf 按弧长取一半", () => {
    expect(
      midpointOf([
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 100, y: 100 },
      ]),
    ).toEqual({ x: 0, y: 100 });
  });

  it("routeEdge 只许给定的边", () => {
    const route = routeEdge({
      source: box(0, 0),
      target: box(300, 0),
      obstacles: [],
      sourceSides: ["bottom"],
      targetSides: ["bottom"],
    });
    expect(route.sourceSide).toBe("bottom");
    expect(route.targetSide).toBe("bottom");
    expect(route.points[0]).toEqual({ x: 50, y: 100 });
    expect(route.points.at(-1)).toEqual({ x: 350, y: 100 });
  });
});
