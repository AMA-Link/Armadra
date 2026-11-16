// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, BoardDocument, Workspace } from "@armadra/shared";

vi.mock("@/nodes/registry", () => {
  const meta = {
    labelKey: "x",
    icon: null,
    defaultSize: { width: 240, height: 200 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#0a84ff",
    hasBridgeHandles: false,
  };
  return {
    NODE_META: { sticky: meta, group: meta },
    nodeMeta: () => meta,
  };
});

const { createBoard } = await import("@armadra/board/dom");
const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { emptyWhiteboard } = await import("../../whiteboard/model");
const { reorder, addItems } = await import("../../whiteboard/store");
const { createBoardAdapter } = await import("../board-adapter");
const { createWhiteboardSync } = await import("./sync");
const { whiteboardKinds } = await import("./kinds");
const { nodeKinds } = await import("../model");
const { clearAllDrafts } = await import("../../flow/drafts");

const stamp = "2026-11-15T00:00:00.000Z";
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

const state = () => useCanvasStore.getState();
const items = () => state().whiteboard.items;
const shape = (id: string, patch: Record<string, unknown> = {}) =>
  ({
    id,
    kind: "shape",
    x: 10,
    y: 20,
    w: 100,
    h: 60,
    z: 0,
    parentId: null,
    style: { color: "black", size: "m" },
    geo: "rectangle",
    ...patch,
  }) as never;

let stage: ReturnType<typeof createBoard>;
let sync: ReturnType<typeof createWhiteboardSync>;
let adapter: ReturnType<typeof createBoardAdapter>;
const start = () => {
  stage = createBoard({
    kinds: { ...nodeKinds(), ...whiteboardKinds() },
  }) as never;
  sync = createWhiteboardSync(stage as never);
  adapter = createBoardAdapter(stage as never);
};

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
    maximized: {},
    saveState: "idle",
    saveError: null,
  });
  state().setWorkspace(workspace);
  state().setDocument({ board, nodes: [], edges: [] } as BoardDocument);
});
afterEach(() => {
  adapter?.destroy();
  sync?.destroy();
  clearAllDrafts();
});

describe("白板对象 → 场景", () => {
  it("实体 id 带 wb: 前缀，种类带遮挡带，父子相对", () => {
    addItems([shape("a"), shape("b", { z: 5, parentId: "group-1" })]);
    start();
    expect(stage.scene.get("wb:a")).toMatchObject({
      kind: "wb.shape",
      x: 10,
      y: 20,
      w: 100,
      h: 60,
    });
    expect(stage.scene.get("wb:b")).toMatchObject({ parent: "group-1" });
  });

  it("身份保持：改一个对象，其它实体还是同一个", () => {
    addItems([shape("a"), shape("b", { x: 400 })]);
    start();
    const before = stage.scene.get("wb:b");
    useCanvasStore.getState().setWhiteboard({
      ...state().whiteboard,
      items: items().map((item) =>
        item.id === "a" ? { ...item, x: 50 } : item,
      ),
    });
    expect(stage.scene.get("wb:a")!.x).toBe(50);
    expect(stage.scene.get("wb:b")).toBe(before);
  });

  it("增删与置顶换带：上带对象换成 :over 种类", () => {
    addItems([shape("a")]);
    start();
    addItems([shape("b")]);
    expect(stage.scene.has("wb:b")).toBe(true);
    reorder(["a"], "front");
    expect(stage.scene.get("wb:a")!.kind).toBe("wb.shape:over");
    reorder(["a"], "back");
    expect(stage.scene.get("wb:a")!.kind).toBe("wb.shape");
    useCanvasStore.getState().setWhiteboard(emptyWhiteboard());
    expect(stage.scene.has("wb:a")).toBe(false);
  });

  it("场景同步不进引擎撤销栈", () => {
    addItems([shape("a")]);
    start();
    expect(stage.scene.canUndo()).toBe(false);
  });
});

describe("引擎事件 → 白板动作", () => {
  it("move：位置取整写回；换父级写 parentId；一次一条历史", () => {
    addItems([shape("a")]);
    start();
    stage.emit("move", {
      ids: ["wb:a"],
      positions: new Map([["wb:a", { x: 33.6, y: 44.2 }]]),
      reparent: new Map([["wb:a", "group-9"]]),
    });
    expect(items()[0]).toMatchObject({ x: 34, y: 44, parentId: "group-9" });
    state().undo();
    expect(items()[0]).toMatchObject({ x: 10, y: 20 });
  });

  it("move 拖出分组：parentId 清掉", () => {
    addItems([shape("a", { parentId: "g" })]);
    start();
    stage.emit("move", {
      ids: ["wb:a"],
      positions: new Map([["wb:a", { x: 1, y: 2 }]]),
      reparent: new Map([["wb:a", null]]),
    });
    expect(items()[0]!.parentId).toBeFalsy();
  });

  it("resize：取整并设最小边", () => {
    addItems([shape("a")]);
    start();
    stage.emit("resize", {
      id: "wb:a",
      box: { x: 5.4, y: 6.6, w: 3, h: 150.4 },
    });
    expect(items()[0]).toMatchObject({ x: 5, y: 7, w: 8, h: 150 });
  });

  it("非白板 id 的事件不碰白板", () => {
    addItems([shape("a")]);
    start();
    const before = items();
    stage.emit("resize", { id: "node-1", box: { x: 0, y: 0, w: 9, h: 9 } });
    stage.emit("move", {
      ids: ["node-1"],
      positions: new Map(),
      reparent: new Map(),
    });
    expect(items()).toBe(before);
  });
});

describe("选区", () => {
  it("引擎选区里的 wb: id 进 selectedItemIds，节点进 selectedNodeIds", () => {
    addItems([shape("a")]);
    start();
    stage.emit("select", { ids: ["wb:a"], additive: false });
    expect(state().selectedItemIds).toEqual(["wb:a"]);
    expect(state().selectedNodeIds).toEqual([]);
  });

  it("store 里选中白板对象 → 引擎选区", () => {
    addItems([shape("a")]);
    start();
    state().setSelection({ nodes: [], edges: [], items: ["wb:a"] });
    expect([...stage.selection()]).toEqual(["wb:a"]);
  });
});
