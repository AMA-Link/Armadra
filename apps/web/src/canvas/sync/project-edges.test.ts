import { describe, expect, it } from "vitest";
import type { BoardDocument, CanvasEdge, CanvasNode } from "@armadra/shared";

import { emptyWhiteboard, type WhiteboardDoc } from "../whiteboard/model";
import { edgeArrowheads, edgeLabelKey, projectEdges } from "./project-edges";

/** 文档 → 连线的投影、箭头方向与标签键。 */

const STAMP = "2026-09-06T00:00:00.000Z";
const NODE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
const EDGE = "44444444-4444-4444-8444-444444444444";

function node(id: string, patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    boardId: "board",
    type: "sticky",
    title: "note",
    color: "#ffd60a",
    position: { x: 10, y: 20 },
    size: { width: 240, height: 200 },
    labels: [],
    note: "",
    data: { kind: "sticky", content: "" },
    createdAt: STAMP,
    updatedAt: STAMP,
    ...patch,
  } as CanvasNode;
}

function edge(source: string, target: string): CanvasEdge {
  return {
    id: EDGE,
    boardId: "board",
    source,
    target,
    kind: "link",
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function board(nodes: CanvasNode[], edges: CanvasEdge[] = []): BoardDocument {
  return { board: {} as BoardDocument["board"], nodes, edges };
}

const EMPTY: WhiteboardDoc = emptyWhiteboard();

describe("projectEdges", () => {
  it("一条 `edges` 行投成一条 `link` 边", () => {
    const edges = projectEdges(
      board([node(NODE), node(OTHER)], [edge(NODE, OTHER)]),
      EMPTY,
    );
    // `data` 里只带角色；缺省不带，所以一块老画布上的边投出来是空的。
    expect(edges).toEqual([
      {
        id: EDGE,
        type: "link",
        source: NODE,
        target: OTHER,
        data: {},
      },
    ]);
  });

  it("主从的角色跟着投出去：边的样子由它决定", () => {
    const rows = board([node(NODE), node(OTHER)], [edge(NODE, OTHER)]);
    const supervises = {
      ...rows,
      edges: rows.edges.map((entry) => ({
        ...entry,
        role: "supervises" as const,
      })),
    };
    expect(projectEdges(supervises, EMPTY)[0]?.data).toEqual({
      role: "supervises",
    });
  });

  it("两端有一个不在画布上就投不出来（远端刚删掉那个节点）", () => {
    const edges = projectEdges(board([node(NODE)], [edge(NODE, OTHER)]), EMPTY);
    expect(edges).toEqual([]);
  });

  it("引用投成 `reference` 边，一端是白板对象", () => {
    const whiteboard: WhiteboardDoc = {
      ...emptyWhiteboard(),
      items: [
        {
          id: "abc",
          kind: "shape",
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          z: 0,
          style: { color: "black", size: "m" },
          geo: "rectangle",
        },
      ],
      references: [{ id: "ref-1", itemId: "abc", nodeId: NODE }],
    };
    const edges = projectEdges(board([node(NODE)]), whiteboard);
    expect(edges).toEqual([
      {
        id: "ref-1",
        type: "reference",
        source: "wb:abc",
        target: NODE,
      },
    ]);
  });

  it("来源是 Frame 时起点就是那个分组节点的 id，不加 `wb:` 前缀", () => {
    const whiteboard: WhiteboardDoc = {
      ...emptyWhiteboard(),
      references: [{ id: "ref-frame", itemId: GROUP, nodeId: NODE }],
    };
    const edges = projectEdges(
      board([node(NODE), node(GROUP, { type: "group" })]),
      whiteboard,
    );
    expect(edges).toEqual([
      {
        id: "ref-frame",
        type: "reference",
        source: GROUP,
        target: NODE,
      },
    ]);
  });

  it("来源既不是白板对象也不是 Frame 时整条不画（普通节点当不了来源）", () => {
    const whiteboard: WhiteboardDoc = {
      ...emptyWhiteboard(),
      references: [{ id: "ref-x", itemId: OTHER, nodeId: NODE }],
    };
    expect(projectEdges(board([node(NODE), node(OTHER)]), whiteboard)).toEqual(
      [],
    );
  });
});

/* ------------------------- 边的箭头与标签（原样保留） ---------------------- */

describe("edgeArrowheads", () => {
  it("箭头指向读的那一端，与用户从哪头拖出来无关", () => {
    expect(edgeArrowheads("terminal", "terminal")).toEqual({
      start: "arrow",
      end: "arrow",
    });
    expect(edgeArrowheads("sticky", "terminal")).toEqual({
      start: "none",
      end: "arrow",
    });
    expect(edgeArrowheads("terminal", "sticky")).toEqual({
      start: "arrow",
      end: "none",
    });
    expect(edgeArrowheads("sticky", "editor")).toEqual({
      start: "none",
      end: "none",
    });
  });
});

describe("edgeLabelKey", () => {
  it("按内容那一端的类型取键，两端都是终端时是「上下文」", () => {
    expect(edgeLabelKey("terminal", "terminal")).toBe("edge.context");
    expect(edgeLabelKey("sticky", "terminal")).toBe("edge.sticky");
    expect(edgeLabelKey("terminal", "editor")).toBe("edge.file");
    expect(edgeLabelKey("terminal", "files")).toBe("edge.dir");
    expect(edgeLabelKey("terminal", "browser")).toBe("edge.web");
    expect(edgeLabelKey("terminal", "diff")).toBe("edge.diff");
    expect(edgeLabelKey("terminal", "automation")).toBe("edge.context");
  });

  it("派发线不看类型，一律是「派发」", () => {
    expect(edgeLabelKey("terminal", "terminal", "supervises")).toBe(
      "edge.role.dispatch",
    );
    expect(edgeLabelKey("sticky", "terminal", "peer")).toBe("edge.sticky");
  });
});
