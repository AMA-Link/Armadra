// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Edge, InternalNode, Node, ReactFlowState } from "@xyflow/react";
import type { CanvasNode } from "@armadra/shared";
import { createBoard } from "@armadra/board/dom";
import type { Entity } from "@armadra/board/core";

import type { Box } from "../geometry";
import { EdgeRouter } from "../flow/edges/edge-router";
import type { LayoutParams } from "../flow/edges/edge-plan";
import { edgeEntity, edgeKinds } from "./edge-model";
import { BoardEdgeRouter } from "./edge-layout";
import { hitEdge } from "./edge-hover";

/**
 * 路由在两种引擎下同一组节点位置给同一条折线（B4 验收）：旧引擎的 `EdgeRouter`
 * 读 React Flow 节点表，新引擎的 `BoardEdgeRouter` 读场景，核心与取边规则相同。
 */

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

function oldRouter(specs: Spec[], edges: Edge[]) {
  const nodes = new Map<string, InternalNode<Node>>(
    specs.map(({ id, box, type = "terminal", group }) => [
      id,
      {
        id,
        type: group ? "group" : "armadra",
        position: { x: box.x, y: box.y },
        data: { type: group ? "group" : type },
        dragging: false,
        measured: { width: box.width, height: box.height },
        internals: {
          positionAbsolute: { x: box.x, y: box.y },
          z: 0,
          userNode: {} as Node,
        },
      } as unknown as InternalNode<Node>,
    ]),
  );
  const state = { nodeLookup: nodes, edges } as unknown as ReactFlowState;
  return new EdgeRouter({ getState: () => state, subscribe: () => () => {} });
}

function newRouter(specs: Spec[], edges: Edge[]) {
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
    for (const edge of edges) draft.set(edgeEntity(edge as never));
  });
  return new BoardEdgeRouter(board);
}

const link = (id: string, source: string, target: string, role?: string) =>
  ({
    id,
    type: "link",
    source,
    target,
    data: role === undefined ? {} : { role },
  }) as Edge;

const reference = (id: string, source: string, target: string) =>
  ({ id, type: "reference", source, target }) as Edge;

function same(specs: Spec[], edges: Edge[]) {
  const before = oldRouter(specs, edges);
  const after = newRouter(specs, edges);
  for (const edge of edges) {
    const a = before.read(edge.id, PARAMS);
    const b = after.read(edge.id, PARAMS);
    expect(b, edge.id).not.toBeNull();
    expect(b!.view.route.points, edge.id).toEqual(a!.view.route.points);
    expect(b!.view.d, edge.id).toBe(a!.view.d);
    expect(b!.text, edge.id).toBe(a!.text);
    expect(b!.label, edge.id).toEqual(a!.label);
  }
  return after;
}

describe("新旧引擎路由一致", () => {
  const fan: Spec[] = [
    { id: "coord", box: { x: 660, y: 0, width: 620, height: 390 } },
    { id: "a1", box: { x: 0, y: 420, width: 620, height: 390 } },
    { id: "a2", box: { x: 660, y: 420, width: 620, height: 390 } },
    { id: "a3", box: { x: 1320, y: 420, width: 620, height: 390 } },
  ];

  it("派发扇出 + 上下文线", () => {
    same(fan, [
      link("d1", "coord", "a1", "supervises"),
      link("d2", "coord", "a2", "supervises"),
      link("d3", "coord", "a3", "supervises"),
      link("p1", "a1", "a3"),
    ]);
  });

  it("绕障碍、分组、内容节点与引用线", () => {
    same(
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
  });

  it("横向布局下的派发线", () => {
    const params: LayoutParams = { ...PARAMS, direction: "horizontal" };
    const before = oldRouter(fan, [link("d1", "coord", "a2", "supervises")]);
    const after = newRouter(fan, [link("d1", "coord", "a2", "supervises")]);
    expect(after.read("d1", params)!.view.route.points).toEqual(
      before.read("d1", params)!.view.route.points,
    );
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
      draft.set(edgeEntity(link("e", "a", "b") as never));
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
