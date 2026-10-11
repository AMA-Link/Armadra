import { describe, expect, it } from "vitest";
import type { Position } from "@armadra/shared";

import type { Box, Side } from "../../geometry";
import { LANE_GAP, nudge, PORT_GAP, type NudgeInput } from "./nudge";

/** 分道与分端口（#318）。 */

const A: Box = { x: 0, y: 0, width: 200, height: 100 };
const B: Box = { x: 600, y: 0, width: 200, height: 100 };

function input(
  id: string,
  bundle: string,
  points: Position[],
  ends: { source?: [string, Side, Box]; target?: [string, Side, Box] } = {},
  priority = 1,
): NudgeInput {
  const [sNode, sSide, sBox] = ends.source ?? [`${id}-s`, "bottom", A];
  const [tNode, tSide, tBox] = ends.target ?? [`${id}-t`, "bottom", B];
  return {
    id,
    bundle,
    priority,
    points,
    obstacles: [],
    source: { node: sNode, side: sSide, box: sBox },
    target: { node: tNode, side: tSide, box: tBox },
  };
}

// 两条 U 形线，中间那段都走 y = 200。
const U = (x0: number, x1: number): Position[] => [
  { x: x0, y: 100 },
  { x: x0, y: 200 },
  { x: x1, y: 200 },
  { x: x1, y: 100 },
];

describe("分道", () => {
  it("不同束在同一条线上重叠的中间段以原线为中心对称错开，相距一个车道", () => {
    const moved = nudge([
      input("dispatch", "d", U(100, 700), {}, 0),
      input("peer", "p", U(150, 650), {}, 1),
    ]);
    const dispatch = moved.get("dispatch")!;
    const peer = moved.get("peer")!;
    expect(dispatch[1]!.y).toBe(200 - LANE_GAP / 2);
    expect(peer[1]!.y).toBe(200 + LANE_GAP / 2);
    expect(peer[2]!.y).toBe(200 + LANE_GAP / 2);
    // 首尾仍在原来的端点上。
    expect(peer[0]).toEqual({ x: 150, y: 100 });
    expect(peer[3]).toEqual({ x: 650, y: 100 });
  });

  it("同一束（同一个主派出去的线）共用主干，不错开", () => {
    const moved = nudge([
      input("d1", "d", U(100, 700)),
      input("d2", "d", U(100, 500)),
    ]);
    expect(moved.size).toBe(0);
  });

  it("对称放不下时优先级高的留在原线，另一束往放得下的一侧让", () => {
    const wall: Box = { x: 0, y: 204, width: 900, height: 50 };
    const moved = nudge([
      input("a", "a", U(100, 700), {}, 0),
      { ...input("b", "b", U(150, 650), {}, 1), obstacles: [wall] },
    ]);
    expect(moved.get("b")![1]!.y).toBe(200 - LANE_GAP);
  });
});

describe("分端口", () => {
  it("两条不同束的线落在同一条边上时沿边排开", () => {
    const target: Box = { x: 600, y: 300, width: 200, height: 100 };
    const fromLeft = input(
      "left",
      "l",
      [
        { x: 100, y: 100 },
        { x: 100, y: 250 },
        { x: 700, y: 250 },
        { x: 700, y: 300 },
      ],
      { target: ["t", "top", target] },
    );
    const fromAbove = input(
      "above",
      "a",
      [
        { x: 700, y: 200 },
        { x: 700, y: 300 },
      ],
      {
        source: ["s", "bottom", { x: 600, y: 100, width: 200, height: 100 }],
        target: ["t", "top", target],
      },
    );
    const moved = nudge([fromLeft, fromAbove]);
    const left = moved.get("left")!;
    const above = moved.get("above")!;
    // 从左边来的那条落在左边的端口。
    expect(left.at(-1)!.x).toBe(700 - PORT_GAP / 2);
    expect(above.at(-1)!.x).toBe(700 + PORT_GAP / 2);
    // 两点一线的那条两端一起挪，仍是直线。
    expect(above[0]!.x).toBe(above[1]!.x);
  });
});
