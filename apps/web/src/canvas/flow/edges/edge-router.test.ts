import { describe, expect, it } from "vitest";
import type { Edge, InternalNode, Node, ReactFlowState } from "@xyflow/react";

import type { Box } from "../../geometry";
import { EdgeRouter, type LayoutParams } from "./edge-router";
import { LANE_GAP } from "./nudge";

/**
 * 全画布的连线布局（#318）：路线缓存、分道、标签互不重叠、只重算受影响的边。
 */

function internal(
  id: string,
  box: Box,
  type = "terminal",
  dragging = false,
): [string, InternalNode<Node>] {
  return [
    id,
    {
      id,
      type: "armadra",
      position: { x: box.x, y: box.y },
      data: { type },
      dragging,
      measured: { width: box.width, height: box.height },
      internals: {
        positionAbsolute: { x: box.x, y: box.y },
        z: 0,
        userNode: {} as Node,
      },
    } as unknown as InternalNode<Node>,
  ];
}

function fakeStore(nodes: Map<string, InternalNode<Node>>, edges: Edge[]) {
  let state = { nodeLookup: nodes, edges } as unknown as ReactFlowState;
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    set(next: Partial<ReactFlowState>) {
      state = { ...state, ...next } as ReactFlowState;
    },
  };
}

const PARAMS: LayoutParams = {
  direction: "vertical",
  fontSize: 11,
  t: (key) => (key === "edge.role.dispatch" ? "派发" : "共享上下文"),
};

const link = (id: string, source: string, target: string, role?: string) =>
  ({
    id,
    type: "link",
    source,
    target,
    data: role === undefined ? {} : { role },
  }) as Edge;

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

describe("截图里的扇出", () => {
  const boxes: Record<string, Box> = {
    coord: { x: 660, y: 0, width: 620, height: 390 },
    a1: { x: 0, y: 420, width: 620, height: 390 },
    a2: { x: 660, y: 420, width: 620, height: 390 },
    a3: { x: 1320, y: 420, width: 620, height: 390 },
  };
  const nodes = new Map(
    Object.entries(boxes).map(([id, box]) => internal(id, box)),
  );
  const edges = [
    link("d1", "coord", "a1", "supervises"),
    link("d2", "coord", "a2", "supervises"),
    link("d3", "coord", "a3", "supervises"),
    link("p1", "a1", "a3"),
  ];

  it("派发线共用主干；穿过同一道缝的上下文线让开一条车道", () => {
    const router = new EdgeRouter(fakeStore(nodes, edges));
    const d1 = router.read("d1", PARAMS)!;
    const p1 = router.read("p1", PARAMS)!;
    const trunk = d1.view.route.points[1]!.y;
    const ys = p1.view.route.points.slice(1, -1).map((point) => point.y);
    // 上下文线在缝里的那一段不和派发线重合。
    expect(ys.some((y) => Math.abs(y - trunk) === LANE_GAP)).toBe(true);
    for (const id of ["d1", "d2", "d3"]) {
      expect(router.read(id, PARAMS)!.view.route.points[0]).toEqual({
        x: 970,
        y: 390,
      });
    }
  });

  it("标签不压节点、彼此不叠", () => {
    const router = new EdgeRouter(fakeStore(nodes, edges));
    const labels = edges
      .map((edge) => router.read(edge.id, PARAMS)?.label)
      .filter((label) => label != null)
      .map((label) => ({
        x: label.x - label.width / 2,
        y: label.y - label.height / 2,
        width: label.width,
        height: label.height,
      }));
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const [i, label] of labels.entries()) {
      for (const box of Object.values(boxes)) {
        expect(overlaps(label, box)).toBe(false);
      }
      for (const other of labels.slice(i + 1)) {
        expect(overlaps(label, other)).toBe(false);
      }
    }
  });

  it("字号为 0 时不摆标签", () => {
    const router = new EdgeRouter(fakeStore(nodes, edges));
    expect(router.read("d1", { ...PARAMS, fontSize: 0 })!.label).toBeNull();
    expect(router.read("d1", { ...PARAMS, fontSize: 0 })!.text).toBe("派发");
  });
});

describe("增量重算", () => {
  it("挪一个节点，远处的边拿到的还是同一个对象", () => {
    const nodes = new Map([
      internal("a", { x: 0, y: 0, width: 100, height: 100 }),
      internal("b", { x: 400, y: 0, width: 100, height: 100 }),
      internal("c", { x: 3000, y: 3000, width: 100, height: 100 }),
      internal("d", { x: 3400, y: 3000, width: 100, height: 100 }),
    ]);
    const store = fakeStore(nodes, [
      link("ab", "a", "b"),
      link("cd", "c", "d"),
    ]);
    const router = new EdgeRouter(store);
    const ab = router.read("ab", PARAMS);
    const cd = router.read("cd", PARAMS);

    const moved = new Map(nodes);
    moved.set(...internal("b", { x: 400, y: 200, width: 100, height: 100 }));
    store.set({ nodeLookup: moved });
    expect(router.read("cd", PARAMS)).toBe(cd);
    expect(router.read("ab", PARAMS)).not.toBe(ab);

    // 平移（节点几何不变）：一条都不重算。
    const after = router.read("ab", PARAMS);
    store.set({ transform: [10, 10, 1] });
    expect(router.read("ab", PARAMS)).toBe(after);
  });

  it("100 个节点、60 条线：首次布局、拖动中每帧（只算挂在被拖节点上的线）与松手补算都在预算内", () => {
    const nodes = new Map<string, InternalNode<Node>>();
    for (let row = 0; row < 10; row += 1) {
      for (let col = 0; col < 10; col += 1) {
        const id = `n${row * 10 + col}`;
        nodes.set(
          ...internal(id, {
            x: col * 520,
            y: row * 380,
            width: 440,
            height: 300,
          }),
        );
      }
    }
    const edges: Edge[] = [];
    for (let k = 0; k < 60; k += 1) {
      const source = `n${k}`;
      const target = `n${(k * 7 + 11) % 100}`;
      if (source === target) continue;
      edges.push(
        link(`e${k}`, source, target, k % 3 === 0 ? "supervises" : undefined),
      );
    }
    const store = fakeStore(nodes, edges);
    const router = new EdgeRouter(store);
    let started = performance.now();
    for (const edge of edges) router.read(edge.id, PARAMS);
    const initial = performance.now() - started;

    // 拖动 n55 十帧。
    let frames = 0;
    started = performance.now();
    for (let step = 1; step <= 10; step += 1) {
      const next = new Map(store.getState().nodeLookup);
      next.set(
        ...internal(
          "n55",
          {
            x: 5 * 520 + step * 7,
            y: 5 * 380 + step * 5,
            width: 440,
            height: 300,
          },
          "terminal",
          true,
        ),
      );
      store.set({ nodeLookup: next });
      for (const edge of edges) router.read(edge.id, PARAMS);
      frames += 1;
    }
    const perFrame = (performance.now() - started) / frames;

    // 松手：被扫过的远处的线这时补算。
    const released = new Map(store.getState().nodeLookup);
    released.set(
      ...internal("n55", {
        x: 5 * 520 + 70,
        y: 5 * 380 + 50,
        width: 440,
        height: 300,
      }),
    );
    store.set({ nodeLookup: released });
    started = performance.now();
    for (const edge of edges) router.read(edge.id, PARAMS);
    const release = performance.now() - started;
    // 宽松的上限（CI 机器慢）；本机实测见 PR 描述。
    expect(initial).toBeLessThan(4000);
    expect(perFrame).toBeLessThan(100);
    expect(release).toBeLessThan(2000);
  });
});
