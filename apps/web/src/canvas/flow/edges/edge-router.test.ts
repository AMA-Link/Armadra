import { describe, expect, it } from "vitest";
import type { Edge, InternalNode, Node, ReactFlowState } from "@xyflow/react";

import type { Box } from "../../geometry";
import { EdgeRouter, type EdgeLayout, type LayoutParams } from "./edge-router";
import { cornerCuts, MIN_CUT } from "./smooth";
import type { Position } from "@armadra/shared";

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

/** 两条折线有没有共线且重叠（长于 1）的段。 */
function sharesSegment(
  a: readonly Position[],
  b: readonly Position[],
): boolean {
  for (let i = 1; i < a.length; i += 1) {
    for (let j = 1; j < b.length; j += 1) {
      const [p, q] = [a[i - 1]!, a[i]!];
      const [r, t] = [b[j - 1]!, b[j]!];
      if (p.y === q.y && r.y === t.y && p.y === r.y) {
        const lo = Math.max(Math.min(p.x, q.x), Math.min(r.x, t.x));
        const hi = Math.min(Math.max(p.x, q.x), Math.max(r.x, t.x));
        if (hi - lo > 1) return true;
      }
      if (p.x === q.x && r.x === t.x && p.x === r.x) {
        const lo = Math.max(Math.min(p.y, q.y), Math.min(r.y, t.y));
        const hi = Math.min(Math.max(p.y, q.y), Math.max(r.y, t.y));
        if (hi - lo > 1) return true;
      }
    }
  }
  return false;
}

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

  it("派发线共用主干；上下文线不挤进两排之间那道窄缝，与派发线没有重叠的段", () => {
    const router = new EdgeRouter(fakeStore(nodes, edges));
    for (const id of ["d1", "d2", "d3"]) {
      expect(router.read(id, PARAMS)!.view.route.points[0]).toEqual({
        x: 970,
        y: 390,
      });
    }
    const p1 = router.read("p1", PARAMS)!.view.route.points;
    // 缝是 390–420：上下文线的拐点都不在缝里。
    for (const point of p1.slice(1, -1)) {
      expect(point.y > 390 && point.y < 420).toBe(false);
    }
    for (const id of ["d1", "d2", "d3"]) {
      const d = router.read(id, PARAMS)!.view.route.points;
      expect(sharesSegment(p1, d)).toBe(false);
    }
  });

  it("挤在同一条线上的不同束错开一个车道", () => {
    // 两条上下文线被迫走同一道缝（只有这一条路）。
    const tight = new Map([
      internal("l1", { x: 0, y: 0, width: 100, height: 100 }),
      internal("l2", { x: 0, y: 140, width: 100, height: 100 }),
      internal("r1", { x: 600, y: 0, width: 100, height: 100 }),
      internal("r2", { x: 600, y: 140, width: 100, height: 100 }),
      internal("wall", { x: 200, y: -2000, width: 300, height: 2110 }),
      internal("floor", { x: 200, y: 150, width: 300, height: 2000 }),
    ]);
    const router = new EdgeRouter(
      fakeStore(tight, [link("x1", "l1", "r2"), link("x2", "l2", "r1")]),
    );
    const x1 = router.read("x1", PARAMS)!.view.route.points;
    const x2 = router.read("x2", PARAMS)!.view.route.points;
    expect(sharesSegment(x1, x2)).toBe(false);
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
    expect(perFrame).toBeLessThan(300);
    expect(release).toBeLessThan(2000);
  });
});

describe("派发组一个标签、线不穿标签、拐角不小于下限（#397）", () => {
  // 1 个协调者 + 3 个 Agent + 1 个独立节点：与 #397 的截图布局一致。
  const boxes: Record<string, Box> = {
    coord: { x: 660, y: 0, width: 620, height: 390 },
    a1: { x: 0, y: 420, width: 620, height: 390 },
    a2: { x: 660, y: 420, width: 620, height: 390 },
    a3: { x: 1320, y: 420, width: 620, height: 390 },
    solo: { x: 1320, y: 0, width: 620, height: 390 },
  };
  const nodes = new Map(
    Object.entries(boxes).map(([id, box]) => internal(id, box)),
  );
  const edges = [
    link("d1", "coord", "a1", "supervises"),
    link("d2", "coord", "a2", "supervises"),
    link("d3", "coord", "a3", "supervises"),
    link("p1", "solo", "coord"),
  ];

  const layoutsAt = (fontSize: number): Map<string, EdgeLayout> => {
    const router = new EdgeRouter(fakeStore(nodes, edges));
    const out = new Map<string, EdgeLayout>();
    for (const edge of edges) {
      out.set(edge.id, router.read(edge.id, { ...PARAMS, fontSize })!);
    }
    return out;
  };

  /** 标签有没有被宿主以外的线穿过：与宿主同向共线的段（共用主干）不算。 */
  function crossed(
    layouts: Map<string, EdgeLayout>,
    host: EdgeLayout,
  ): boolean {
    const label = host.label!;
    const hostPoints = host.view.route.points;
    let horizontal = true;
    for (let k = 1; k < hostPoints.length; k += 1) {
      const a = hostPoints[k - 1]!;
      const b = hostPoints[k]!;
      if (
        Math.abs(a.y - label.y) < 1.5 &&
        a.y === b.y &&
        label.x >= Math.min(a.x, b.x) &&
        label.x <= Math.max(a.x, b.x)
      ) {
        horizontal = true;
        break;
      }
      if (
        Math.abs(a.x - label.x) < 1.5 &&
        a.x === b.x &&
        label.y >= Math.min(a.y, b.y) &&
        label.y <= Math.max(a.y, b.y)
      ) {
        horizontal = false;
        break;
      }
    }
    const rect = {
      x: label.x - label.width / 2,
      y: label.y - label.height / 2,
      width: label.width,
      height: label.height,
    };
    for (const layout of layouts.values()) {
      const points = layout.view.route.points;
      for (let k = 1; k < points.length; k += 1) {
        const a = points[k - 1]!;
        const b = points[k]!;
        const segHorizontal = a.y === b.y;
        const line = segHorizontal ? a.y : a.x;
        const hostLine = horizontal ? label.y : label.x;
        if (segHorizontal === horizontal && Math.abs(line - hostLine) < 1.5) {
          continue;
        }
        const seg = {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          width: Math.abs(b.x - a.x),
          height: Math.abs(b.y - a.y),
        };
        if (
          rect.x < seg.x + seg.width &&
          rect.x + rect.width > seg.x &&
          rect.y < seg.y + seg.height &&
          rect.y + rect.height > seg.y
        ) {
          return true;
        }
      }
    }
    return false;
  }

  for (const [zoom, fontSize] of [
    [1, 11],
    [0.45, 24],
  ] as const) {
    it(`缩放 ${zoom}：三条派发线合起来只有一枚「派发」标签`, () => {
      const layouts = layoutsAt(fontSize);
      const dispatch = ["d1", "d2", "d3"].map((id) => layouts.get(id)!);
      expect(dispatch.filter((layout) => layout.label !== null)).toHaveLength(
        1,
      );
      for (const layout of dispatch) expect(layout.text).toBe("派发");
    });

    it(`缩放 ${zoom}：标签不被任何线穿过，不压节点、箭头与别的标签`, () => {
      const layouts = layoutsAt(fontSize);
      const labelled = [...layouts.values()].filter((l) => l.label !== null);
      expect(labelled.length).toBeGreaterThanOrEqual(1);
      const rects = labelled.map((layout) => {
        const label = layout.label!;
        return {
          x: label.x - label.width / 2,
          y: label.y - label.height / 2,
          width: label.width,
          height: label.height,
        };
      });
      const arrows: Box[] = [];
      for (const layout of layouts.values()) {
        const points = layout.view.route.points;
        for (const tip of [points[0]!, points[points.length - 1]!]) {
          arrows.push({ x: tip.x - 11, y: tip.y - 11, width: 22, height: 22 });
        }
      }
      for (const [i, rect] of rects.entries()) {
        expect(crossed(layouts, labelled[i]!)).toBe(false);
        for (const box of Object.values(boxes)) {
          expect(overlaps(rect, box)).toBe(false);
        }
        for (const arrow of arrows) expect(overlaps(rect, arrow)).toBe(false);
        for (const other of rects.slice(i + 1)) {
          expect(overlaps(rect, other)).toBe(false);
        }
      }
    });
  }

  it("两个协调者各派一组：两组各一枚标签，互不重叠", () => {
    const more = new Map(nodes);
    more.set(...internal("c2", { x: 2400, y: 0, width: 620, height: 390 }));
    more.set(...internal("b1", { x: 2400, y: 420, width: 300, height: 390 }));
    more.set(...internal("b2", { x: 2740, y: 420, width: 300, height: 390 }));
    const all = [
      ...edges,
      link("e1", "c2", "b1", "supervises"),
      link("e2", "c2", "b2", "supervises"),
    ];
    const router = new EdgeRouter(fakeStore(more, all));
    const labelled = all
      .map((edge) => router.read(edge.id, PARAMS)!)
      .filter((layout) => layout.label !== null);
    const dispatchLabels = labelled.filter((layout) => layout.text === "派发");
    expect(dispatchLabels).toHaveLength(2);
    const [first, second] = dispatchLabels.map((layout) => layout.label!);
    expect(
      overlaps(
        {
          x: first!.x - first!.width / 2,
          y: first!.y - first!.height / 2,
          width: first!.width,
          height: first!.height,
        },
        {
          x: second!.x - second!.width / 2,
          y: second!.y - second!.height / 2,
          width: second!.width,
          height: second!.height,
        },
      ),
    ).toBe(false);
  });

  it("每条线的拐角都是曲线，切入距离不小于下限；路径里没有直接折角", () => {
    const layouts = layoutsAt(11);
    for (const layout of layouts.values()) {
      const { points } = layout.view.route;
      for (const cut of cornerCuts(points)) {
        expect(Math.min(cut.before, cut.after)).toBeGreaterThanOrEqual(MIN_CUT);
      }
      const corners = points.length - 2;
      expect((layout.view.d.match(/Q/g) ?? []).length).toBe(corners);
    }
  });

  it("派发主干在两排之间的缝（30）里走正中间：离协调者与 Agent 标题栏各 15", () => {
    const layouts = layoutsAt(11);
    const trunk = layouts.get("d1")!.view.route.points;
    const horizontal = trunk.filter(
      (point, k) => k > 0 && point.y === trunk[k - 1]!.y,
    );
    expect(horizontal.length).toBeGreaterThan(0);
    for (const point of horizontal) expect(point.y).toBe(405);
  });
});
