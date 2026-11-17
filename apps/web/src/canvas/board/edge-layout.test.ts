// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@armadra/shared";
import { createBoard } from "@armadra/board/dom";
import type { Entity } from "@armadra/board/core";

import type { Box } from "../geometry";
import type { LayoutParams } from "../flow/edges/edge-plan";
import { edgeEntity, edgeKinds } from "./edge-model";
import { BoardEdgeRouter } from "./edge-layout";
import { hitEdge } from "./edge-hover";

/**
 * 连线布局：同一组节点位置给出固定的折线（派发扇出分道、绕障碍、横向布局），
 * 拖动中跟随手势预览，几何命中。折线的期望值取自删除前与旧引擎路由器逐项一致的
 * 那一版输出。
 */

interface TestEdge {
  id: string;
  type: "link" | "reference";
  source: string;
  target: string;
  data?: { role?: "peer" | "supervises" };
}

const PARAMS: LayoutParams = {
  direction: "vertical",
  fontSize: 11,
  t: (key) => (key === "edge.role.dispatch" ? "派发" : "共享上下文"),
};

interface Spec {
  id: string;
  box: Box;
  type?: string;
  group?: boolean;
}

function newRouter(specs: Spec[], edges: TestEdge[]) {
  const board = createBoard<CanvasNode>({ kinds: edgeKinds() });
  board.scene.transact((draft) => {
    for (const { id, box, type = "terminal", group } of specs) {
      draft.set({
        id,
        kind: group ? "group" : type,
        x: box.x,
        y: box.y,
        w: box.width,
        h: box.height,
        z: 1,
        data: { type: group ? "group" : type } as unknown as CanvasNode,
      } as Entity<CanvasNode>);
    }
    for (const edge of edges) draft.set(edgeEntity(edge));
  });
  return new BoardEdgeRouter(board);
}

const link = (
  id: string,
  source: string,
  target: string,
  role?: "peer" | "supervises",
) =>
  ({
    id,
    type: "link",
    source,
    target,
    data: role === undefined ? {} : { role },
  }) as TestEdge;

const reference = (id: string, source: string, target: string) =>
  ({ id, type: "reference", source, target }) as TestEdge;

const pts = (...xy: [number, number][]) => xy.map(([x, y]) => ({ x, y }));

/** 读出一条连线的折线与标签文字。 */
function read(
  router: BoardEdgeRouter,
  id: string,
  params: LayoutParams = PARAMS,
) {
  const layout = router.read(id, params);
  expect(layout, id).not.toBeNull();
  return { points: layout!.view.route.points, text: layout!.text };
}

describe("连线布局", () => {
  const fan: Spec[] = [
    { id: "coord", box: { x: 660, y: 0, width: 620, height: 390 } },
    { id: "a1", box: { x: 0, y: 420, width: 620, height: 390 } },
    { id: "a2", box: { x: 660, y: 420, width: 620, height: 390 } },
    { id: "a3", box: { x: 1320, y: 420, width: 620, height: 390 } },
  ];

  it("派发扇出 + 上下文线：分道、标签文字", () => {
    const router = newRouter(fan, [
      link("d1", "coord", "a1", "supervises"),
      link("d2", "coord", "a2", "supervises"),
      link("d3", "coord", "a3", "supervises"),
      link("p1", "a1", "a3"),
    ]);
    expect(read(router, "d1")).toEqual({
      points: pts([970, 390], [970, 405], [310, 405], [310, 420]),
      text: "派发",
    });
    expect(read(router, "d2")).toEqual({
      points: pts([970, 390], [970, 420]),
      text: "派发",
    });
    expect(read(router, "d3")).toEqual({
      points: pts([970, 390], [970, 405], [1630, 405], [1630, 420]),
      text: "派发",
    });
    expect(read(router, "p1")).toEqual({
      points: pts(
        [620, 615],
        [640, 615],
        [640, 830],
        [1300, 830],
        [1300, 615],
        [1320, 615],
      ),
      text: "共享上下文",
    });
  });

  it("绕障碍、分组、内容节点与引用线", () => {
    const router = newRouter(
      [
        { id: "t", box: { x: 0, y: 0, width: 400, height: 300 } },
        {
          id: "s",
          box: { x: 900, y: 40, width: 240, height: 200 },
          type: "sticky",
        },
        {
          id: "wall",
          box: { x: 450, y: -200, width: 300, height: 700 },
          type: "editor",
        },
        {
          id: "frame",
          box: { x: -50, y: 600, width: 1300, height: 500 },
          group: true,
        },
        {
          id: "f1",
          box: { x: 0, y: 700, width: 300, height: 200 },
          type: "files",
        },
      ],
      [
        link("l1", "t", "s"),
        link("l2", "f1", "t"),
        reference("r1", "frame", "t"),
      ],
    );
    expect(read(router, "l1").points).toEqual(
      pts([400, 150], [430, 150], [430, -220], [1020, -220], [1020, 40]),
    );
    expect(read(router, "l2").points).toEqual(
      pts([150, 700], [150, 320], [192, 320], [192, 300]),
    );
    expect(read(router, "r1").points).toEqual(
      pts([600, 600], [600, 520], [208, 520], [208, 300]),
    );
  });

  it("横向布局下子在主正下方时改走就近边（主底 → 子顶）", () => {
    const router = newRouter(fan, [link("d1", "coord", "a2", "supervises")]);
    expect(
      read(router, "d1", { ...PARAMS, direction: "horizontal" }).points,
    ).toEqual(pts([970, 390], [970, 420]));
  });
});

describe("拖动中跟随", () => {
  it("手势预览改写端点，连线读到预览位置", () => {
    const board = createBoard<CanvasNode>({ kinds: edgeKinds() });
    board.scene.transact((draft) => {
      for (const [id, x] of [
        ["a", 0],
        ["b", 600],
      ] as const) {
        draft.set({
          id,
          kind: "terminal",
          x,
          y: 0,
          w: 200,
          h: 100,
          z: 1,
          data: { type: "terminal" } as unknown as CanvasNode,
        } as Entity<CanvasNode>);
      }
      draft.set(edgeEntity(link("e", "a", "b")));
    });
    const router = new BoardEdgeRouter(board);
    const before = router.read("e", PARAMS)!.view.route.points;
    board.scene.preview(new Map([["b", { x: 600, y: 400 }]]));
    const during = router.read("e", PARAMS)!.view.route.points;
    expect(during).not.toEqual(before);
    expect(during.at(-1)!.y).toBeGreaterThan(before.at(-1)!.y);
  });
});

describe("几何命中", () => {
  it("折线距离在容差内命中最近的一条，之外为空", () => {
    const router = newRouter(
      [
        { id: "a", box: { x: 0, y: 0, width: 200, height: 100 } },
        { id: "b", box: { x: 600, y: 0, width: 200, height: 100 } },
      ],
      [link("e", "a", "b")],
    );
    router.read("e", PARAMS);
    const points = router.current("e")!.view.route.points;
    const on = points[0]!;
    expect(hitEdge(router, on, 1)).toBe("e");
    expect(hitEdge(router, { x: on.x, y: on.y - 200 }, 1)).toBeNull();
  });
});
