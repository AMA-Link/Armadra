import { describe, expect, it } from "vitest";

import { routeFor } from "./link";
import {
  EdgeLayoutEngine,
  type EdgePlan,
  type LayoutInput,
  type RoutedEdge,
  type RoutedView,
} from "./router";
import type { SceneNode } from "./scene";
import { smoothPath } from "./smooth";

/** 引擎自己的路由器：不依赖任何画布库，直接喂节点矩形与边表。 */

const node = (x: number, y: number, obstacle = true): SceneNode => ({
  box: { x, y, width: 200, height: 100 },
  obstacle,
});

function input(
  nodes: Map<string, SceneNode>,
  edges: RoutedEdge[],
  overrides: Partial<LayoutInput<RoutedEdge, RoutedView>> = {},
): LayoutInput<RoutedEdge, RoutedView> {
  return {
    edges,
    nodes,
    dragging: new Set(),
    fontSize: 11,
    tipSize: 11,
    translate: (key) => `t:${key}`,
    plan: (edge, scene): EdgePlan<RoutedView> => ({
      key: "peer",
      bundle: `edge:${edge.id}`,
      priority: 1,
      view: (previous) => {
        const route = routeFor(
          scene.source,
          scene.target,
          scene.obstacles,
          "free",
          previous,
        );
        return {
          route,
          d: smoothPath(route.points, []),
          labelKey: "peer",
          arrowStart: false,
          arrowEnd: true,
        };
      },
    }),
    ...overrides,
  };
}

const EDGE: RoutedEdge = { id: "e", source: "a", target: "b" };

describe("EdgeLayoutEngine", () => {
  it("算出折线、路径与标签；两端没尺寸的边没有布局", () => {
    const engine = new EdgeLayoutEngine();
    const nodes = new Map([
      ["a", node(0, 0)],
      ["b", node(600, 0)],
      ["c", { box: null, obstacle: true }],
    ]);
    engine.recompute(
      input(nodes, [EDGE, { id: "x", source: "a", target: "c" }]),
    );
    const layout = engine.get("e");
    expect(layout?.view.route.points.length).toBeGreaterThanOrEqual(2);
    expect(layout?.view.d.startsWith("M")).toBe(true);
    expect(layout?.text).toBe("t:peer");
    expect(layout?.label).not.toBeNull();
    expect(engine.get("x")).toBeNull();
  });

  it("什么都没变时沿用同一个对象；字号为 0 不画标签", () => {
    const engine = new EdgeLayoutEngine();
    const nodes = new Map([
      ["a", node(0, 0)],
      ["b", node(600, 0)],
    ]);
    engine.recompute(input(nodes, [EDGE]));
    const first = engine.get("e");
    engine.recompute(input(nodes, [EDGE]));
    expect(engine.get("e")).toBe(first);
    engine.recompute(input(nodes, [EDGE], { fontSize: 0 }));
    expect(engine.get("e")?.label).toBeNull();
  });

  it("拖动中远处的线不重算，松手后补上", () => {
    const engine = new EdgeLayoutEngine();
    const edges = [EDGE, { id: "f", source: "c", target: "d" }];
    const nodes = new Map([
      ["a", node(0, 0)],
      ["b", node(600, 0)],
      ["c", node(0, 500)],
      ["d", node(600, 500)],
    ]);
    engine.recompute(input(nodes, edges));
    const far = engine.get("f");
    nodes.set("d", node(600, 700));
    engine.recompute(input(nodes, edges, { dragging: new Set(["a"]) }));
    expect(engine.get("f")).toBe(far);
    engine.recompute(input(nodes, edges));
    expect(engine.get("f")).not.toBe(far);
  });
});
