import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  Workspace,
} from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { onNodeNamesRequest } from "@/nodes/node-names";
import { clearAllDrafts, getDrafts } from "./drafts";
import { useFlowNodes } from "./use-flow-nodes";

const now = "2026-01-01T00:00:00.000Z";
const node = (id: string, type: CanvasNode["type"]): CanvasNode => ({
  id,
  boardId: "board",
  type,
  title: id,
  color: "#0a84ff",
  position: { x: 0, y: 0 },
  size: { width: 240, height: 200 },
  labels: [],
  note: "",
  data:
    type === "sticky"
      ? { kind: "sticky", content: "" }
      : ({ kind: type } as never),
  createdAt: now,
  updatedAt: now,
});

const document: BoardDocument = {
  board: {
    id: "board",
    workspaceId: "ws",
    name: "b",
    sortOrder: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    whiteboard: "",
    createdAt: now,
    updatedAt: now,
  } as Board,
  nodes: [node("a", "sticky"), node("b", "sticky")],
  edges: [
    {
      id: "e1",
      boardId: "board",
      source: "a",
      target: "b",
      kind: "link",
      createdAt: now,
      updatedAt: now,
    },
  ],
};

beforeEach(() => {
  useCanvasStore.setState({
    selectedNodeIds: [],
    selectedEdgeIds: [],
    selectedItemIds: [],
  });
  useCanvasStore.getState().setWorkspace({ id: "ws" } as Workspace);
  useCanvasStore.getState().setDocument(document);
});
afterEach(() => {
  cleanup();
  clearAllDrafts();
});

describe("useFlowNodes", () => {
  /**
   * 只改边的选区时节点表的身份必须不变。换了身份 React Flow 的
   * `StoreUpdater` 就多跑一次 `setNodes`，那一次会把「节点新 + 边旧」的半成品
   * 喂给选区监听器，边在选中 / 没选中之间来回弹直到 React 白屏。
   */
  it("只改边的选区，nodes 数组身份不变", () => {
    const { result } = renderHook(() => useFlowNodes());
    const before = result.current.nodes;

    act(() => {
      useCanvasStore.getState().setSelection({ edges: ["e1"] });
    });

    expect(
      result.current.edges.find((edge) => edge.id === "e1")?.selected,
    ).toBe(true);
    expect(result.current.nodes).toBe(before);
  });

  /** 反过来同理：只改节点的选区不该重建边表。 */
  it("只改节点的选区，edges 数组身份不变", () => {
    const { result } = renderHook(() => useFlowNodes());
    const before = result.current.edges;

    act(() => {
      useCanvasStore.getState().selectNodes(["a"]);
    });

    expect(result.current.nodes.find((item) => item.id === "a")?.selected).toBe(
      true,
    );
    expect(result.current.edges).toBe(before);
  });

  /**
   * 选区只从 `onNodesChange` / `onEdgesChange` 两条变更流写回。
   * React Flow 的 `onSelectionChange` 慢一帧，照着它写回就是自激。
   */
  it("不再向 React Flow 交出 onSelectionChange", () => {
    const { result } = renderHook(() => useFlowNodes());
    expect("onSelectionChange" in result.current).toBe(false);
  });

  /**
   * 一条边建立的那一刻，两端才第一次需要互相称呼（设计 §2.2）。被拒绝的那一
   * 次不问——重复的连线没有建立任何新关系。
   */
  it("连上一条新线之后问两端要名字，重复的那次不问", () => {
    const asked: string[][] = [];
    const release = onNodeNamesRequest((ids) => asked.push([...ids]));
    try {
      const { result } = renderHook(() => useFlowNodes());
      act(() => {
        useCanvasStore.getState().addNode("sticky", { id: "c" } as never);
      });
      const created = useCanvasStore.getState().document!.nodes.at(-1)!.id;
      act(() => {
        result.current.onConnect({
          source: "a",
          target: created,
          sourceHandle: null,
          targetHandle: null,
        });
      });
      expect(asked).toEqual([["a", created]]);

      // 已经连着的一对：`addEdge` 什么都不做，也就没有新关系要命名。
      act(() => {
        result.current.onConnect({
          source: "a",
          target: "b",
          sourceHandle: null,
          targetHandle: null,
        });
      });
      expect(asked).toHaveLength(1);
    } finally {
      release();
    }
  });

  /**
   * 连线两端的边由几何按相对位置现算（#211），从哪个把手拖出来不入库：
   * 存下来的边只有 `source` / `target`，节点移动后线自己换边。
   */
  it("连线时不把起笔与落点的把手写进边", () => {
    const { result } = renderHook(() => useFlowNodes());
    act(() => {
      useCanvasStore.getState().addNode("sticky", { id: "c" } as never);
    });
    const created = useCanvasStore.getState().document!.nodes.at(-1)!.id;
    act(() => {
      result.current.onConnect({
        source: "a",
        target: created,
        sourceHandle: "top",
        targetHandle: "left",
      });
    });
    const edge = useCanvasStore
      .getState()
      .document!.edges.find((item) => item.target === created)!;
    expect(edge).toBeDefined();
    expect("sourceHandle" in edge).toBe(false);
    expect("targetHandle" in edge).toBe(false);
  });

  /**
   * 多选拖动（#713）：React Flow 把整组被拖动的节点放在第三个参数里——拖其中
   * 一个节点时 `node` 是指针下那个，拖框选之后的虚线选区框时 `node` 是组里
   * 第一个。画布是受控的，节点画在哪只看投影（文档 + 草稿），所以整组都得
   * 进草稿，否则只有一个节点跟着指针走。
   */
  describe("多选拖动", () => {
    /** 文档节点 id 是 UUID（`isDocumentNodeId`），白板对象才是 `wb:`。 */
    const id = (letter: string) =>
      `00000000-0000-4000-8000-00000000000${letter}`;
    const [A, B, C] = ["a", "b", "c"].map(id) as [string, string, string];
    const three = () => {
      const base = document.nodes[0]!;
      useCanvasStore.getState().setDocument({
        ...document,
        nodes: [A, B, C].map((nodeId, index) => ({
          ...base,
          id: nodeId,
          title: nodeId,
          position: { x: index * 300, y: 0 },
        })),
        edges: [],
      });
      useCanvasStore.getState().setSelection({ nodes: [A, B, C] });
    };
    const dragged = (
      nodes: { id: string; position: { x: number; y: number } }[],
      dy: number,
    ) =>
      nodes.map((item) => ({
        ...item,
        position: { x: item.position.x, y: item.position.y + dy },
      }));

    for (const [label, grabbed] of [
      ["b", () => B],
      ["组里第一个，即拖虚线选区框", () => A],
    ] as const) {
      it(`拖动中整组都跟着走（指针下是 ${label}）`, () => {
        three();
        const { result } = renderHook(() => useFlowNodes());
        const selected = result.current.nodes.filter((item) => item.selected);
        expect(selected.map((item) => item.id)).toEqual([A, B, C]);
        const moving = dragged(selected, 120) as typeof selected;
        const node = moving.find((item) => item.id === grabbed())!;

        act(() => result.current.onNodeDrag({}, node, moving));

        expect([...getDrafts().keys()].sort()).toEqual([A, B, C]);
        const projected = new Map(
          result.current.nodes.map((item) => [item.id, item.position]),
        );
        expect(projected.get(A)).toEqual({ x: 0, y: 120 });
        expect(projected.get(B)).toEqual({ x: 300, y: 120 });
        expect(projected.get(C)).toEqual({ x: 600, y: 120 });
        // 文档在松手之前一点不动：一次手势一条历史。
        expect(
          useCanvasStore
            .getState()
            .document!.nodes.map((item) => item.position),
        ).toEqual([
          { x: 0, y: 0 },
          { x: 300, y: 0 },
          { x: 600, y: 0 },
        ]);

        act(() => result.current.onNodeDragStop({}, node, moving));
        expect(getDrafts().size).toBe(0);
        expect(
          useCanvasStore
            .getState()
            .document!.nodes.map((item) => item.position),
        ).toEqual([
          { x: 0, y: 120 },
          { x: 300, y: 120 },
          { x: 600, y: 120 },
        ]);
      });
    }

    it("没有第三个参数时退回只写指针下那一个", () => {
      three();
      const { result } = renderHook(() => useFlowNodes());
      const [first] = dragged(result.current.nodes.slice(0, 1), 50);
      act(() =>
        result.current.onNodeDrag(
          {},
          first as (typeof result.current.nodes)[number],
        ),
      );
      expect([...getDrafts().keys()]).toEqual([A]);
    });
  });
});
