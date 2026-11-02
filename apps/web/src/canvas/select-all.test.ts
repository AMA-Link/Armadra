import { afterEach, describe, expect, it } from "vitest";
import type { BoardDocument, CanvasNode } from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { makeEdge, makeItem, makeNode } from "./test-support";
import { selectAllCanvas } from "./select-all";
import { emptyWhiteboard, toItemId } from "./whiteboard/model";

/**
 * 全选写的是画布 store 的选区（节点 / 边 / 白板对象三张 id 表），之后拖动、
 * 删除读的是同一份，所以一次选中的多个节点一起动。
 */

const STAMP = "2026-11-02T00:00:00.000Z";

function load(
  nodes: CanvasNode[],
  edges = [] as ReturnType<typeof makeEdge>[],
) {
  useCanvasStore.setState({
    document: {
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
    } as unknown as BoardDocument,
  });
}

afterEach(() => {
  useCanvasStore.setState({
    document: null,
    whiteboard: emptyWhiteboard(),
    selectedNodeIds: [],
    selectedEdgeIds: [],
    selectedItemIds: [],
  });
});

describe("selectAllCanvas", () => {
  it("选中全部节点、白板对象与连线", () => {
    const a = makeNode("terminal");
    const b = makeNode("sticky");
    const edge = makeEdge(a.id, b.id);
    const item = makeItem("shape");
    load([a, b], [edge]);
    useCanvasStore.setState({
      whiteboard: { ...emptyWhiteboard(), items: [item] },
    });

    selectAllCanvas(useCanvasStore.getState());

    const state = useCanvasStore.getState();
    expect(state.selectedNodeIds).toEqual([a.id, b.id]);
    expect(state.selectedEdgeIds).toEqual([edge.id]);
    expect(state.selectedItemIds).toEqual([toItemId(item.id)]);
  });

  it("替换掉原有的部分选区", () => {
    const a = makeNode("terminal");
    const b = makeNode("sticky");
    load([a, b]);
    useCanvasStore.getState().selectNodes([a.id]);

    selectAllCanvas(useCanvasStore.getState());

    expect(useCanvasStore.getState().selectedNodeIds).toEqual([a.id, b.id]);
  });

  it("空画布选区为空，不报错", () => {
    load([]);
    selectAllCanvas(useCanvasStore.getState());
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
  });

  it("没有加载文档时也是安全的空操作", () => {
    expect(() => selectAllCanvas(useCanvasStore.getState())).not.toThrow();
  });
});
