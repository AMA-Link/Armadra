// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  Workspace,
} from "@armadra/shared";
import { createBoard } from "@armadra/board/dom";

import { useCanvasStore, resetHistory } from "@/store/canvas-store";
import { emptyWhiteboard } from "../whiteboard/model";
import { createBoardEdgeAdapter } from "./edge-adapter";
import { edgeDataOf } from "./edge-model";

const stamp = "2026-11-16T00:00:00.000Z";
const workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
} as Workspace;
const board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: stamp,
  updatedAt: stamp,
} as Board;
const node = (n: number): CanvasNode =>
  ({
    id: `019ff7d1-0000-7000-8000-${String(n).padStart(12, "0")}`,
    boardId: board.id,
    type: "terminal",
    title: "t",
    color: "#0a84ff",
    position: { x: n * 300, y: 0 },
    size: { width: 200, height: 150 },
    data: { kind: "terminal" },
    createdAt: stamp,
    updatedAt: stamp,
  }) as CanvasNode;

const state = () => useCanvasStore.getState();
let stage: ReturnType<typeof createBoard<CanvasNode>>;
let adapter: ReturnType<typeof createBoardEdgeAdapter>;

beforeEach(() => {
  resetHistory();
  useCanvasStore.setState({
    workspace: null,
    boards: [],
    boardId: null,
    document: null,
    whiteboard: emptyWhiteboard(),
    selectedNodeIds: [],
    selectedEdgeIds: [],
    selectedItemIds: [],
    focusNodeId: null,
  });
  state().setWorkspace(workspace);
  state().setDocument({
    board,
    nodes: [node(1), node(2), node(3)],
    edges: [],
  } as BoardDocument);
  stage = createBoard<CanvasNode>();
  stage.scene.transact(
    (draft) => {
      for (const n of state().document!.nodes) {
        draft.set({
          id: n.id,
          kind: "terminal",
          x: n.position.x,
          y: n.position.y,
          w: 200,
          h: 150,
          z: 1,
          data: n,
        });
      }
    },
    { history: "ignore" },
  );
  adapter = createBoardEdgeAdapter(stage);
});
afterEach(() => adapter.destroy());

describe("连线 → 场景", () => {
  it("建边写进场景，带两端；删边与删端点都清掉", () => {
    const [a, b, c] = state().document!.nodes;
    const id = state().addEdge(a!.id, b!.id)!;
    const entity = stage.scene.get(id)!;
    expect(entity.ends).toEqual([a!.id, b!.id]);
    expect(entity.kind).toBe("link");
    expect(edgeDataOf(entity)).toEqual({ type: "link" });
    // 边的包围盒是两端的并集（缩略图据此取范围）。
    expect(stage.scene.bounds(id)).toMatchObject({ x: 300, y: 0, w: 500 });

    const other = state().addEdge(b!.id, c!.id)!;
    expect(stage.scene.has(other)).toBe(true);
    state().removeEdges([id]);
    expect(stage.scene.has(id)).toBe(false);
    expect(stage.scene.has(other)).toBe(true);
  });

  it("角色变化换实体，没变的边保持同一个对象", () => {
    const [a, b, c] = state().document!.nodes;
    const first = state().addEdge(a!.id, b!.id)!;
    const second = state().addEdge(b!.id, c!.id)!;
    const kept = stage.scene.get(second);
    state().setEdgeRole(first, "supervises");
    expect(edgeDataOf(stage.scene.get(first)!).role).toBe("supervises");
    expect(stage.scene.get(second)).toBe(kept);
  });

  it("不进引擎撤销栈", () => {
    const [a, b] = state().document!.nodes;
    state().addEdge(a!.id, b!.id);
    expect(stage.scene.canUndo?.() ?? false).toBe(false);
  });
});
