import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SIBLING_GAP,
  boxesTooClose,
  type BoardDocument,
  type CanvasNode,
  type Position,
} from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { canUndo, resetHistory, undo } from "@/store/canvas/history";
import { resetCanvasLock, setCanvasLocked } from "./canvas-lock";
import { setFlow, type FlowHandle } from "./flow/flow-context";
import type { TidyRect } from "./tidy";
import { makeEdge, makeItem, makeNode } from "./test-support";
import {
  emptyWhiteboard,
  toItemId,
  type Item,
  type Reference,
} from "./whiteboard/model";
import { arrangeCanvas, tidySelection } from "./tidy-flow";

/**
 * 整理排布的画布侧（React Flow 计划 T06 / F09）。
 *
 * 重写自旧引擎的 `tidy-editor.test.ts`（7 项）：那一版从编辑器里捞 shape，
 * 还要处理旋转、隐藏、对象锁与「绕开固定对象」。现在输入只有
 * `document.nodes` 与 `whiteboard.items` 两张表，剩下的断言是：谁参与、
 * 谁跟着容器走、链接怎么上溯、以及整块只留一条历史。
 *
 * 算法本身（连通分量 + 视口宽高比裹行）在 `tidy.test.ts`。
 */

const STAMP = "2026-09-06T00:00:00.000Z";

function board(
  nodes: CanvasNode[],
  edges = [] as ReturnType<typeof makeEdge>[],
) {
  return {
    board: {
      id: "019ff7d1-0d12-7421-833d-2c5e8d64ed00",
      workspaceId: "w1",
      name: "board",
      sortOrder: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
      createdAt: STAMP,
      updatedAt: STAMP,
    },
    nodes,
    edges,
  } as unknown as BoardDocument;
}

function load(
  nodes: CanvasNode[],
  options: {
    edges?: ReturnType<typeof makeEdge>[];
    items?: Item[];
    references?: Reference[];
  } = {},
): void {
  useCanvasStore.setState({
    document: board(nodes, options.edges ?? []),
    whiteboard: {
      ...emptyWhiteboard(),
      items: options.items ?? [],
      references: options.references ?? [],
    },
  });
}

function positionOf(id: string): Position {
  const node = useCanvasStore
    .getState()
    .document?.nodes.find((entry) => entry.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node.position;
}

function itemPositionOf(id: string): Position {
  const item = useCanvasStore
    .getState()
    .whiteboard.items.find((entry) => entry.id === id);
  if (!item) throw new Error(`no item ${id}`);
  return { x: item.x, y: item.y };
}

beforeEach(() => {
  resetHistory();
  resetCanvasLock();
});

afterEach(() => {
  resetCanvasLock();
  resetHistory();
  useCanvasStore.setState({ document: null, whiteboard: emptyWhiteboard() });
});

describe("参与排布的对象", () => {
  it("空画布什么都不做", () => {
    load([]);
    expect(arrangeCanvas()).toEqual({});
  });

  it("顶层节点与顶层白板对象排在同一张表里", () => {
    const one = makeNode("sticky", { position: { x: 900, y: 40 } });
    const two = makeNode("sticky", { position: { x: 40, y: 900 } });
    const item = makeItem("shape", { x: 1500, y: 1500 });
    load([one, two], { items: [item] });

    const applied = arrangeCanvas({ aspect: 1 });
    expect(Object.keys(applied).sort()).toEqual(
      [one.id, two.id, toItemId(item.id)].sort(),
    );
    // 原来散在三个角上；排完之后包围盒收得比 1500 小得多。
    const xs = Object.values(applied).map((point) => point.x);
    const ys = Object.values(applied).map((point) => point.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1000);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1000);
  });

  it("Frame 整体移动一次，组员与组内白板对象都不单独参与", () => {
    const frame = makeNode("group", {
      position: { x: 800, y: 800 },
      size: { width: 400, height: 300 },
    });
    const member = makeNode("terminal", {
      parentId: frame.id,
      position: { x: 20, y: 30 },
    });
    const inside = makeItem("text", { parentId: frame.id, x: 10, y: 10 });
    const loose = makeNode("sticky", { position: { x: 0, y: 0 } });
    load([frame, member, loose], { items: [inside] });

    const applied = arrangeCanvas({ aspect: 1 });
    expect(Object.keys(applied).sort()).toEqual([frame.id, loose.id].sort());
    // 组员的相对坐标一点没动，Frame 内部的布局跟着整块搬走。
    expect(positionOf(member.id)).toEqual({ x: 20, y: 30 });
    expect(itemPositionOf(inside.id)).toEqual({ x: 10, y: 10 });
  });

  it("整块保持内容包围盒的左上角不动", () => {
    const one = makeNode("sticky", { position: { x: 400, y: 250 } });
    const two = makeNode("sticky", { position: { x: 900, y: 700 } });
    load([one, two]);

    const applied = arrangeCanvas({ aspect: 16 / 9 });
    const xs = Object.values(applied).map((point) => point.x);
    const ys = Object.values(applied).map((point) => point.y);
    // 左上角吸到 8px 网格：400 本来就在格上，250 落到 248。
    expect(Math.min(...xs)).toBe(400);
    expect(Math.min(...ys)).toBe(248);
  });
});

describe("链接", () => {
  it("连线让两个节点排到一起，组员之间的连线上溯到各自的 Frame", () => {
    const frame = makeNode("group", {
      position: { x: 0, y: 0 },
      size: { width: 300, height: 200 },
    });
    const member = makeNode("terminal", {
      parentId: frame.id,
      position: { x: 10, y: 10 },
    });
    const far = makeNode("terminal", { position: { x: 4000, y: 4000 } });
    load([frame, member, far], { edges: [makeEdge(member.id, far.id)] });

    const applied = arrangeCanvas({ aspect: 1 });
    // 同一组（连通分量）里的两个矩形挨着排，不会一个在原点一个在 4000。
    const gap = Math.hypot(
      applied[frame.id]!.x - applied[far.id]!.x,
      applied[frame.id]!.y - applied[far.id]!.y,
    );
    expect(gap).toBeLessThan(1000);
  });

  it("内容引用也算链接：被引用的对象排在那个 Agent 旁边", () => {
    const agent = makeNode("terminal", { position: { x: 0, y: 0 } });
    const far = makeNode("terminal", { position: { x: 5000, y: 0 } });
    const item = makeItem("text", { x: 5000, y: 5000 });
    load([agent, far], {
      items: [item],
      references: [{ id: "r1", itemId: item.id, nodeId: agent.id }],
    });

    const applied = arrangeCanvas({ aspect: 1 });
    const near = Math.hypot(
      applied[agent.id]!.x - applied[toItemId(item.id)]!.x,
      applied[agent.id]!.y - applied[toItemId(item.id)]!.y,
    );
    const away = Math.hypot(
      applied[far.id]!.x - applied[toItemId(item.id)]!.x,
      applied[far.id]!.y - applied[toItemId(item.id)]!.y,
    );
    expect(near).toBeLessThan(away);
  });
});

describe("提交", () => {
  it("节点与白板对象一起动，但只留一条历史", () => {
    const one = makeNode("sticky", { position: { x: 900, y: 40 } });
    const two = makeNode("sticky", { position: { x: 40, y: 900 } });
    const item = makeItem("shape", { x: 1500, y: 1500 });
    load([one, two], { items: [item] });
    const before = {
      one: positionOf(one.id),
      item: itemPositionOf(item.id),
    };

    arrangeCanvas({ aspect: 1 });
    expect(itemPositionOf(item.id)).not.toEqual(before.item);
    expect(useCanvasStore.getState().saveState).toBe("dirty");

    // 一条历史：一次 ⌘Z 把节点与白板对象一起还原。
    expect(canUndo()).toBe(true);
    undo();
    expect(canUndo()).toBe(false);
    expect(positionOf(one.id)).toEqual(before.one);
    expect(itemPositionOf(item.id)).toEqual(before.item);
  });

  it("已经整齐时不提交，也不记历史", () => {
    const only = makeNode("sticky", { position: { x: 104, y: 104 } });
    load([only]);
    const applied = arrangeCanvas({ aspect: 1 });
    expect(applied[only.id]).toEqual({ x: 104, y: 104 });
    expect(canUndo()).toBe(false);
  });

  it("锁定视图时什么都不动", () => {
    const one = makeNode("sticky", { position: { x: 900, y: 40 } });
    const two = makeNode("sticky", { position: { x: 40, y: 900 } });
    load([one, two]);
    setCanvasLocked(true);

    expect(arrangeCanvas({ aspect: 1 })).toEqual({});
    expect(positionOf(one.id)).toEqual({ x: 900, y: 40 });
    expect(canUndo()).toBe(false);
  });
});

describe("§6.4 / §6.5", () => {
  it("主从边：纵向（缺省）从在主下面同一行，横向从在主右侧同一列", () => {
    const main = makeNode("terminal", { position: { x: 3000, y: 3000 } });
    const subs = [0, 1, 2].map((index) =>
      makeNode("terminal", { position: { x: index * 700, y: index * 50 } }),
    );
    const edges = subs.map((sub) => ({
      ...makeEdge(main.id, sub.id),
      role: "supervises" as const,
    }));
    load([main, ...subs], { edges });
    const down = arrangeCanvas({ aspect: 100 });
    const ys = new Set(subs.map((sub) => down[sub.id]!.y));
    expect(ys.size).toBe(1);
    expect([...ys][0]).toBeGreaterThan(down[main.id]!.y);

    load([main, ...subs], { edges });
    const across = arrangeCanvas({ aspect: 100, direction: "horizontal" });
    const xs = new Set(subs.map((sub) => across[sub.id]!.x));
    expect(xs.size).toBe(1);
    expect([...xs][0]).toBeGreaterThan(across[main.id]!.x);
  });

  it("散落的白板孤岛整体平移，岛内相对位置不变", () => {
    const box = makeItem("shape", { x: 1000, y: 1000, w: 100, h: 40 });
    const label = makeItem("text", { x: 1010, y: 1050, w: 80, h: 20 });
    const node = makeNode("sticky", { position: { x: 0, y: 0 } });
    load([node], { items: [box, label] });
    arrangeCanvas({ aspect: 1 });
    const a = itemPositionOf(box.id);
    const b = itemPositionOf(label.id);
    expect({ dx: b.x - a.x, dy: b.y - a.y }).toEqual({ dx: 10, dy: 50 });
  });

  it("只整理选中：未选中的坐标不变，一次撤销全回", () => {
    const one = makeNode("sticky", { position: { x: 900, y: 40 } });
    const two = makeNode("sticky", { position: { x: 40, y: 900 } });
    const untouched = makeNode("sticky", { position: { x: 5000, y: 5000 } });
    load([one, two, untouched]);
    useCanvasStore.setState({ selectedNodeIds: [one.id, two.id] });

    const only = tidySelection(useCanvasStore.getState());
    expect(only && [...only].sort()).toEqual([one.id, two.id].sort());
    const applied = arrangeCanvas({ aspect: 1, only });
    expect(Object.keys(applied).sort()).toEqual([one.id, two.id].sort());
    expect(positionOf(untouched.id)).toEqual({ x: 5000, y: 5000 });
    // 原点取选区包围盒左上角（吸网格）。
    const xs = Object.values(applied).map((point) => point.x);
    const ys = Object.values(applied).map((point) => point.y);
    expect(Math.min(...xs)).toBe(40);
    expect(Math.min(...ys)).toBe(40);

    undo();
    expect(canUndo()).toBe(false);
    expect(positionOf(one.id)).toEqual({ x: 900, y: 40 });
    expect(positionOf(two.id)).toEqual({ x: 40, y: 900 });
  });

  it("选区不足两个顶层单元时整理全画布", () => {
    const frame = makeNode("group", {
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
    });
    const a = makeNode("sticky", { parentId: frame.id });
    const b = makeNode("sticky", { parentId: frame.id });
    load([frame, a, b]);
    // 两个组员上溯到同一个组 = 一个单元。
    useCanvasStore.setState({ selectedNodeIds: [a.id, b.id] });
    expect(tidySelection(useCanvasStore.getState())).toBeNull();
    useCanvasStore.setState({ selectedNodeIds: [a.id] });
    expect(tidySelection(useCanvasStore.getState())).toBeNull();
  });

  it("整理两次，第二次不再提交", () => {
    const main = makeNode("terminal", { position: { x: 333, y: 777 } });
    const sub = makeNode("terminal", { position: { x: 10, y: 10 } });
    const web = makeNode("browser", { position: { x: 2000, y: 1500 } });
    const item = makeItem("shape", { x: 1234, y: 99 });
    load([main, sub, web], {
      items: [item],
      edges: [
        { ...makeEdge(main.id, sub.id), role: "supervises" as const },
        makeEdge(sub.id, web.id),
      ],
    });
    arrangeCanvas({ aspect: 16 / 9 });
    resetHistory();
    arrangeCanvas({ aspect: 16 / 9 });
    expect(canUndo()).toBe(false);
  });
});

/* ------------------------------ 不重叠（#319） ------------------------------ */

/** 顶层对象排完之后的占地：Frame 含组员，节点按文档尺寸。 */
function footprints(): { id: string; wb: boolean; box: TidyRect }[] {
  const state = useCanvasStore.getState();
  const nodes = state.document?.nodes ?? [];
  const items = state.whiteboard.items;
  const result: { id: string; wb: boolean; box: TidyRect }[] = [];
  for (const node of nodes.filter((entry) => !entry.parentId)) {
    const size = node.size ?? { width: 240, height: 200 };
    const parts: TidyRect[] = [{ ...node.position, ...size }];
    for (const member of nodes.filter((entry) => entry.parentId === node.id)) {
      parts.push({
        x: node.position.x + member.position.x,
        y: node.position.y + member.position.y,
        ...(member.size ?? { width: 240, height: 200 }),
      });
    }
    for (const item of items.filter((entry) => entry.parentId === node.id)) {
      parts.push({
        x: node.position.x + item.x,
        y: node.position.y + item.y,
        width: item.w,
        height: item.h,
      });
    }
    const left = Math.min(...parts.map((part) => part.x));
    const top = Math.min(...parts.map((part) => part.y));
    result.push({
      id: node.id,
      wb: false,
      box: {
        x: left,
        y: top,
        width: Math.max(...parts.map((part) => part.x + part.width)) - left,
        height: Math.max(...parts.map((part) => part.y + part.height)) - top,
      },
    });
  }
  for (const item of items.filter((entry) => !entry.parentId)) {
    result.push({
      id: item.id,
      wb: true,
      box: { x: item.x, y: item.y, width: item.w, height: item.h },
    });
  }
  return result;
}

/** 任意两个顶层对象（两个都是白板对象的除外：孤岛内部是用户自己摆的）。 */
function crowded(gap: number): string[] {
  const all = footprints();
  const hits: string[] = [];
  for (const [index, a] of all.entries()) {
    for (const b of all.slice(index + 1)) {
      if (a.wb && b.wb) continue;
      if (boxesTooClose(a.box, b.box, gap)) hits.push(`${a.id}×${b.id}`);
    }
  }
  return hits;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("不重叠（#319）", () => {
  afterEach(() => setFlow(null));

  it("组员伸出框外：Frame 按「框 ∪ 组员」占地，排完不压别人，组员相对位置不变", () => {
    const frame = makeNode("group", {
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
    });
    const member = makeNode("terminal", {
      parentId: frame.id,
      position: { x: 350, y: 250 },
      size: { width: 600, height: 400 },
    });
    const loose = makeNode("terminal", {
      position: { x: 420, y: 0 },
      size: { width: 960, height: 600 },
    });
    load([frame, member, loose]);
    arrangeCanvas({ aspect: 100 });
    expect(crowded(SIBLING_GAP)).toEqual([]);
    expect(positionOf(member.id)).toEqual({ x: 350, y: 250 });
  });

  it("只整理选区：排好的块让开没选中的对象", () => {
    const one = makeNode("terminal", {
      position: { x: 900, y: 40 },
      size: { width: 960, height: 600 },
    });
    const two = makeNode("terminal", {
      position: { x: 40, y: 900 },
      size: { width: 960, height: 600 },
    });
    // 正好挡在选区包围盒左上角的落点上。
    const blocker = makeNode("sticky", { position: { x: 300, y: 100 } });
    load([one, two, blocker]);
    useCanvasStore.setState({ selectedNodeIds: [one.id, two.id] });
    arrangeCanvas({
      aspect: 1,
      only: tidySelection(useCanvasStore.getState()),
    });
    expect(positionOf(blocker.id)).toEqual({ x: 300, y: 100 });
    expect(crowded(SIBLING_GAP)).toEqual([]);
    // 一次撤销全回。
    undo();
    expect(canUndo()).toBe(false);
    expect(positionOf(one.id)).toEqual({ x: 900, y: 40 });
  });

  it("React Flow 量到的尺寸比文档大时按实测占地", () => {
    const big = makeNode("sticky", {
      position: { x: 0, y: 0 },
      size: { width: 240, height: 200 },
    });
    const next = makeNode("sticky", { position: { x: 300, y: 0 } });
    load([big, next]);
    setFlow({
      getNode: (id: string) =>
        id === big.id ? { measured: { width: 900, height: 700 } } : undefined,
    } as unknown as FlowHandle);
    arrangeCanvas({ aspect: 100 });
    const a = positionOf(big.id);
    const b = positionOf(next.id);
    expect(
      boxesTooClose(
        { ...a, width: 900, height: 700 },
        { ...b, width: 240, height: 200 },
        SIBLING_GAP,
      ),
    ).toBe(false);
  });

  it("随机画布（含大终端、组、白板对象、派发线）：排完不挤、组员不动、再整理不动、一次撤销全回", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = seeded(seed);
      const nodes: CanvasNode[] = [];
      const items: Item[] = [];
      const count = 2 + Math.floor(random() * 14);
      for (let index = 0; index < count; index += 1) {
        const at = {
          x: Math.round(random() * 2400),
          y: Math.round(random() * 1600),
        };
        const roll = random();
        if (roll < 0.15) {
          const frame = makeNode("group", {
            position: at,
            size: { width: 500, height: 400 },
          });
          nodes.push(
            frame,
            makeNode("terminal", {
              parentId: frame.id,
              position: { x: 40, y: 60 },
              size: { width: 640, height: 440 },
            }),
          );
          items.push(makeItem("shape", { parentId: frame.id, x: 20, y: 20 }));
        } else if (roll < 0.3) {
          items.push(makeItem("shape", { ...at, w: 160, h: 90 }));
        } else {
          nodes.push(
            makeNode("terminal", {
              position: at,
              size:
                roll < 0.7
                  ? { width: 960, height: 600 }
                  : { width: 240, height: 200 },
              data: {
                kind: "terminal",
                agent: { id: "claude" },
              } as CanvasNode["data"],
            }),
          );
        }
      }
      const tops = nodes.filter((node) => !node.parentId);
      const edges = [];
      for (let index = 0; index < tops.length; index += 1) {
        if (tops.length < 2 || random() < 0.4) continue;
        const source = tops[Math.floor(random() * tops.length)]!;
        const target = tops[Math.floor(random() * tops.length)]!;
        if (source.id === target.id) continue;
        edges.push(
          random() < 0.6
            ? { ...makeEdge(source.id, target.id), role: "supervises" as const }
            : makeEdge(source.id, target.id),
        );
      }
      resetHistory();
      load(nodes, { edges, items });
      const before = new Map(nodes.map((node) => [node.id, node.position]));
      const direction = seed % 2 === 0 ? "vertical" : "horizontal";

      arrangeCanvas({ aspect: 16 / 9, direction });
      expect(crowded(SIBLING_GAP), `seed ${seed}`).toEqual([]);
      for (const node of nodes.filter((entry) => entry.parentId)) {
        expect(positionOf(node.id), `seed ${seed}`).toEqual(node.position);
      }

      // 已经整齐：再整理一次不提交。
      const tidyHistory = canUndo();
      resetHistory();
      arrangeCanvas({ aspect: 16 / 9, direction });
      expect(canUndo(), `seed ${seed}`).toBe(false);

      // 一次撤销回到原位（第一次整理有改动时）。
      if (tidyHistory) {
        resetHistory();
        load(nodes, { edges, items });
        arrangeCanvas({ aspect: 16 / 9, direction });
        undo();
        expect(canUndo(), `seed ${seed}`).toBe(false);
        for (const node of nodes) {
          expect(positionOf(node.id), `seed ${seed}`).toEqual(
            before.get(node.id),
          );
        }
      }
    }
  });
});
