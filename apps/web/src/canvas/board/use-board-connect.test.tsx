// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  Workspace,
} from "@armadra/shared";

vi.mock("@/nodes/registry", () => {
  const meta = (hasBridgeHandles: boolean) => ({
    labelKey: "x",
    icon: null,
    defaultSize: { width: 200, height: 150 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#0a84ff",
    hasBridgeHandles,
  });
  const table = {
    terminal: meta(true),
    sticky: meta(true),
    group: meta(false),
    editor: meta(true),
    diff: meta(true),
    files: meta(true),
    browser: meta(true),
  };
  return {
    NODE_DRAG_HANDLE: ".drag-handle",
    NODE_META: table,
    nodeMeta: (type: keyof typeof table) => table[type],
  };
});
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("@/ui/toast", () => ({ toast }));
vi.mock("@/nodes/node-names", () => ({ requestNodeNames: vi.fn() }));

const { createBoard } = await import("@armadra/board/dom");
const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { emptyWhiteboard } = await import("../whiteboard/model");
const { nodeKinds } = await import("./model");
const { useBoardConnect } = await import("./use-board-connect");
const { getConnectPreview } = await import("./connect-preview");

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
const node = (n: number, type: CanvasNode["type"] = "terminal"): CanvasNode =>
  ({
    id: `019ff7d1-0000-7000-8000-${String(n).padStart(12, "0")}`,
    boardId: board.id,
    type,
    title: type,
    color: "#0a84ff",
    position: { x: n * 300, y: 0 },
    size: { width: 200, height: 150 },
    data: { kind: type },
    createdAt: stamp,
    updatedAt: stamp,
  }) as CanvasNode;
const state = () => useCanvasStore.getState();

beforeEach(() => {
  resetHistory();
  toast.error.mockClear();
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
    nodes: [node(1), node(2), node(3, "group")],
    edges: [],
  } as BoardDocument);
});
afterEach(() => vi.restoreAllMocks());

function mount() {
  const stage = createBoard<CanvasNode>({ kinds: nodeKinds() });
  const ref = { current: document.createElement("div") };
  const view = renderHook(() => useBoardConnect(stage, ref));
  return { stage, view };
}

describe("连线资格", () => {
  it("带桥接把手的节点能起笔，分组只作落点", () => {
    const { stage } = mount();
    const spec = (kind: string) => {
      stage.scene.transact(
        (draft) =>
          draft.set({
            id: "x",
            kind,
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            z: 1,
            data: {} as CanvasNode,
          }),
        { history: "ignore" },
      );
      return stage.gestureDeps.kind?.(kind)?.connect;
    };
    expect(spec("terminal")).toEqual({ start: true, end: true });
    expect(spec("terminal:collapsed")).toEqual({ start: true, end: true });
    expect(spec("group")).toEqual({ start: false, end: true });
  });
});

describe("connect 事件", () => {
  it("落在另一个节点上：建一条边", () => {
    const { stage } = mount();
    const [a, b] = state().document!.nodes;
    stage.emit("connect", {
      from: a!.id,
      side: "right",
      to: b!.id,
      at: { x: 0, y: 0 },
    });
    expect(state().document!.edges).toHaveLength(1);
    expect(state().document!.edges[0]).toMatchObject({
      source: a!.id,
      target: b!.id,
    });
  });

  it("落在分组上也能连；重复连线被拒绝并提示", () => {
    const { stage } = mount();
    const [a, b, group] = state().document!.nodes;
    stage.emit("connect", {
      from: a!.id,
      side: "right",
      to: group!.id,
      at: { x: 0, y: 0 },
    });
    expect(state().document!.edges).toHaveLength(1);
    stage.emit("connect", {
      from: a!.id,
      side: "right",
      to: b!.id,
      at: { x: 0, y: 0 },
    });
    stage.emit("connect", {
      from: b!.id,
      side: "left",
      to: a!.id,
      at: { x: 0, y: 0 },
    });
    expect(state().document!.edges).toHaveLength(2);
    expect(toast.error).toHaveBeenCalled();
  });

  it("自连被拒绝并提示，不建边", () => {
    const { stage } = mount();
    const [a] = state().document!.nodes;
    stage.emit("connect", {
      from: a!.id,
      side: "right",
      to: a!.id,
      at: { x: 0, y: 0 },
    });
    expect(state().document!.edges).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("落回起笔节点自己身上（引擎给的是空白）：提示自连，不建边", () => {
    const { stage } = mount();
    const [a] = state().document!.nodes;
    stage.scene.transact(
      (draft) =>
        draft.set({
          id: a!.id,
          kind: "terminal",
          x: 0,
          y: 0,
          w: 200,
          h: 150,
          z: 1,
          data: a!,
        }),
      { history: "ignore" },
    );
    stage.emit("connect", {
      from: a!.id,
      side: "right",
      to: null,
      at: { x: 100, y: 75 },
    });
    expect(state().document!.edges).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledTimes(1);
    // 落在节点外面的空白处不提示
    toast.error.mockClear();
    stage.emit("connect", {
      from: a!.id,
      side: "right",
      to: null,
      at: { x: 900, y: 900 },
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("落在空白处、起笔不是 Agent 终端：什么都不发生", () => {
    const { stage } = mount();
    const [a] = state().document!.nodes;
    stage.emit("connect", {
      from: a!.id,
      side: "right",
      to: null,
      at: { x: 0, y: 0 },
    });
    expect(state().document!.edges).toHaveLength(0);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("预览线反馈", () => {
  it("接管连线反馈：悬停的宿主按判定表标记，结束时清掉", () => {
    const { stage } = mount();
    const [a, b] = state().document!.nodes;
    const host = document.createElement("div");
    vi.spyOn(stage, "hostOf").mockReturnValue(host);
    stage.gestureDeps.feedback?.({
      type: "connect",
      from: a!.id,
      side: "right",
      to: { x: 5, y: 5 },
      over: b!.id,
    });
    expect(host.getAttribute("data-connect-target")).toBe("valid");
    expect(getConnectPreview()).toMatchObject({ from: a!.id, over: b!.id });

    stage.gestureDeps.feedback?.({
      type: "connect",
      from: a!.id,
      side: "right",
      to: { x: 5, y: 5 },
      over: a!.id,
    });
    expect(host.getAttribute("data-connect-target")).toBe("invalid");

    stage.gestureDeps.feedback?.(null);
    expect(host.hasAttribute("data-connect-target")).toBe(false);
    expect(getConnectPreview()).toBeNull();
  });
});
