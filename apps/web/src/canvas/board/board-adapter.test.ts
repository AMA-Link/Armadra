// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Board,
  BoardDocument,
  CanvasNode,
  Workspace,
} from "@armadra/shared";

/**
 * 真实的节点注册表拖着八个懒加载的节点体；适配器只读尺寸与最小尺寸，造一份最小的。
 */
vi.mock("@/nodes/registry", () => {
  const meta = (width: number, height: number) => ({
    labelKey: "x",
    icon: null,
    defaultSize: { width, height },
    minSize: { width: 160, height: 120 },
    defaultColor: "#0a84ff",
    hasBridgeHandles: false,
  });
  const table = {
    terminal: meta(640, 440),
    sticky: meta(240, 200),
    group: meta(520, 360),
    editor: meta(660, 460),
    diff: meta(860, 500),
    files: meta(340, 460),
    browser: meta(800, 560),
  };
  return {
    NODE_META: table,
    nodeMeta: (type: keyof typeof table) => table[type],
  };
});

const platform = vi.hoisted(() => ({ desktop: false }));
vi.mock("@/platform", async (original) => ({
  ...(await original<typeof import("@/platform")>()),
  isDesktop: () => platform.desktop,
}));

const { COLLAPSED_HEIGHT } = await import("@/store/defaults");
const { createBoard } = await import("@armadra/board/dom");
const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { emptyWhiteboard } = await import("../whiteboard/model");
const { hasDrafts, clearAllDrafts } = await import("../flow/drafts");
const { createBoardAdapter } = await import("./board-adapter");
const { nodeKinds, GHOST_KIND } = await import("./model");
const { frameBindingOf } = await import("../frame-binding");
const { useIsGhost } = await import("@/nodes/browser/pool");
const { usePreferencesStore } = await import("@/app/preferences-store");
const { act, renderHook } = await import("@testing-library/react");

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

let counter = 0;
const make = (
  type: CanvasNode["type"],
  patch: Partial<CanvasNode> = {},
): CanvasNode =>
  ({
    id: `019ff7d1-0000-7000-8000-${String(++counter).padStart(12, "0")}`,
    boardId: board.id,
    type,
    title: type,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 200, height: 150 },
    data: { kind: type },
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  }) as CanvasNode;

const state = () => useCanvasStore.getState();
const nodes = () => state().document?.nodes ?? [];
const byId = (id: string) => nodes().find((n) => n.id === id)!;
const load = (list: CanvasNode[]) => {
  state().setWorkspace(workspace);
  state().setDocument({ board, nodes: list, edges: [] } as BoardDocument);
};

let stage: ReturnType<typeof createBoard<CanvasNode>>;
let adapter: ReturnType<typeof createBoardAdapter>;
const start = () => {
  stage = createBoard<CanvasNode>({ kinds: nodeKinds() });
  adapter = createBoardAdapter(stage);
};

beforeEach(() => {
  counter = 0;
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
});
afterEach(() => {
  adapter?.destroy();
  clearAllDrafts();
});

describe("节点 → 场景", () => {
  it("首次同步：种类、几何、父子与层级", () => {
    const group = make("group", { position: { x: 100, y: 100 } });
    const card = make("terminal", {
      parentId: group.id,
      position: { x: 10, y: 20 },
      size: { width: 300, height: 200 },
    });
    const folded = make("sticky", { collapsed: true });
    load([card, group, folded]);
    start();
    expect(stage.scene.get(group.id)).toMatchObject({
      kind: "group",
      x: 100,
      y: 100,
      w: 200,
      h: 150,
    });
    expect(stage.scene.get(card.id)).toMatchObject({
      kind: "terminal",
      parent: group.id,
      x: 10,
      y: 20,
      w: 300,
      h: 200,
    });
    expect(stage.scene.get(card.id)!.z).toBeGreaterThan(
      stage.scene.get(group.id)!.z,
    );
    expect(stage.scene.get(folded.id)).toMatchObject({
      kind: "sticky:collapsed",
      h: COLLAPSED_HEIGHT,
    });
    expect(stage.scene.bounds(card.id)).toMatchObject({ x: 110, y: 120 });
  });

  it("没写 size 的节点按种类默认尺寸", () => {
    load([make("sticky", { size: undefined })]);
    start();
    expect(stage.scene.get(nodes()[0]!.id)).toMatchObject({ w: 240, h: 200 });
  });

  it("分组的 worktree 绑定跟着 data 进场景，一个字段不掉", () => {
    const binding = {
      worktreePath: ".armadra/worktrees/feature",
      branch: "feature/login",
      repositoryId: "repo-1",
      initScript: null,
      initScriptState: "none",
      initScriptNodeId: null,
    };
    const bound = make("group", {
      data: { kind: "group", binding },
    } as Partial<CanvasNode>);
    const plain = make("group");
    load([bound, plain]);
    start();
    const data = (id: string) => stage.scene.get(id)!.data as CanvasNode;
    expect(frameBindingOf(data(bound.id))).toEqual(binding);
    expect(data(plain.id).data).toEqual({ kind: "group" });
  });

  it("身份保持：改一个节点，其它实体还是同一个对象", () => {
    const a = make("sticky");
    const b = make("sticky", { position: { x: 400, y: 0 } });
    load([a, b]);
    start();
    const before = stage.scene.get(b.id);
    state().updateNode(a.id, { title: "renamed" });
    expect(stage.scene.get(a.id)!.data.title).toBe("renamed");
    expect(stage.scene.get(b.id)).toBe(before);
  });

  it("平移（只换 board.viewport）不碰场景", () => {
    load([make("sticky")]);
    start();
    const listener = vi.fn();
    stage.scene.subscribe(listener);
    state().setViewport({ x: 50, y: 50, zoom: 0.5 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("删除节点移除实体，选区里它也被去掉", () => {
    const a = make("sticky");
    const b = make("sticky");
    load([a, b]);
    start();
    state().selectNodes([a.id, b.id]);
    state().removeNodes([a.id]);
    expect(stage.scene.has(a.id)).toBe(false);
    expect([...stage.selection()]).toEqual([b.id]);
  });

  it("同步不进引擎自己的撤销栈", () => {
    load([make("sticky")]);
    start();
    state().addNode("sticky", { select: false });
    expect(stage.scene.canUndo()).toBe(false);
  });

  it("换板：旧实体全部移除，新实体进来", () => {
    const a = make("sticky");
    load([a]);
    start();
    const b = make("sticky");
    state().setDocument({ board, nodes: [b], edges: [] } as BoardDocument);
    expect(stage.scene.has(a.id)).toBe(false);
    expect(stage.scene.has(b.id)).toBe(true);
  });
});

describe("选区", () => {
  it("引擎 select 事件写进 store，并清掉连线与白板对象的选区", () => {
    const a = make("sticky");
    load([a]);
    start();
    state().setSelection({ edges: ["e"], items: ["wb:1"] });
    stage.emit("select", { ids: [a.id], additive: false });
    expect(state().selectedNodeIds).toEqual([a.id]);
    expect(state().selectedEdgeIds).toEqual([]);
    expect(state().selectedItemIds).toEqual([]);
  });

  it("store 选区推给引擎，不存在的 id 忽略", () => {
    const a = make("sticky");
    load([a]);
    start();
    state().selectNodes([a.id]);
    expect([...stage.selection()]).toEqual([a.id]);
    state().selectNodes([]);
    expect([...stage.selection()]).toEqual([]);
  });
});

describe("拖动写回", () => {
  it("move：位置写回 store，一次手势一条历史", () => {
    const a = make("sticky");
    const b = make("sticky", { position: { x: 300, y: 0 } });
    load([a, b]);
    start();
    stage.emit("move", {
      ids: [a.id, b.id],
      positions: new Map([
        [a.id, { x: 40, y: 50 }],
        [b.id, { x: 340, y: 50 }],
      ]),
      reparent: new Map(),
    });
    expect(byId(a.id).position).toEqual({ x: 40, y: 50 });
    expect(byId(b.id).position).toEqual({ x: 340, y: 50 });
    expect(stage.scene.get(a.id)).toMatchObject({ x: 40, y: 50 });
    state().undo();
    expect(byId(a.id).position).toEqual({ x: 0, y: 0 });
    expect(byId(b.id).position).toEqual({ x: 300, y: 0 });
  });

  it("拖进分组：父级换了、画布上的位置不变", () => {
    const group = make("group", { position: { x: 100, y: 100 } });
    const card = make("sticky", { position: { x: 0, y: 0 } });
    load([group, card]);
    start();
    // 引擎给的位置相对新父级：落在分组内 (30, 40)，即画布 (130, 140)
    stage.emit("move", {
      ids: [card.id],
      positions: new Map([[card.id, { x: 30, y: 40 }]]),
      reparent: new Map([[card.id, group.id]]),
    });
    expect(byId(card.id).parentId).toBe(group.id);
    expect(byId(card.id).position).toEqual({ x: 30, y: 40 });
    expect(stage.scene.bounds(card.id)).toMatchObject({ x: 130, y: 140 });
  });

  it("拖出分组：回到画布坐标", () => {
    const group = make("group", { position: { x: 100, y: 100 } });
    const card = make("sticky", {
      parentId: group.id,
      position: { x: 10, y: 10 },
    });
    load([group, card]);
    start();
    stage.emit("move", {
      ids: [card.id],
      positions: new Map([[card.id, { x: 700, y: 20 }]]),
      reparent: new Map([[card.id, null]]),
    });
    expect(byId(card.id).parentId).toBeUndefined();
    expect(byId(card.id).position).toEqual({ x: 700, y: 20 });
  });

  it("组不能进组：store 拒绝换父时仍按原父级落位", () => {
    const outer = make("group", { position: { x: 0, y: 0 } });
    const inner = make("group", { position: { x: 600, y: 600 } });
    load([outer, inner]);
    start();
    stage.emit("move", {
      ids: [inner.id],
      positions: new Map([[inner.id, { x: 50, y: 60 }]]),
      reparent: new Map([[inner.id, outer.id]]),
    });
    expect(byId(inner.id).parentId).toBeUndefined();
    // 想去的位置是外层分组内 (50, 60) = 画布 (50, 60)
    expect(byId(inner.id).position).toEqual({ x: 50, y: 60 });
  });

  it("手势起止同步 flow/drafts 的「有手势」判定", () => {
    load([make("sticky")]);
    start();
    stage.emit("gesture", { active: true });
    expect(hasDrafts()).toBe(true);
    stage.emit("gesture", { active: false });
    expect(hasDrafts()).toBe(false);
  });
});

describe("缩放写回", () => {
  it("取整并夹在最小尺寸之上", () => {
    const a = make("sticky");
    load([a]);
    start();
    stage.emit("resize", {
      id: a.id,
      box: { x: 10.4, y: 20.6, w: 100.2, h: 400.7 },
    });
    expect(byId(a.id).size).toEqual({ width: 160, height: 401 });
    expect(byId(a.id).position).toEqual({ x: 10, y: 21 });
  });

  it("折叠的节点高度钉死", () => {
    const a = make("sticky", { collapsed: true });
    load([a]);
    start();
    stage.emit("resize", { id: a.id, box: { x: 0, y: 0, w: 300, h: 500 } });
    expect(byId(a.id).size).toMatchObject({
      width: 300,
      height: COLLAPSED_HEIGHT,
    });
  });
});

describe("销毁", () => {
  it("销毁后不再响应 store 与引擎事件", () => {
    const a = make("sticky");
    load([a]);
    start();
    adapter.destroy();
    state().addNode("sticky", { select: false });
    expect(stage.scene.size).toBe(1);
    stage.emit("select", { ids: [], additive: false });
    expect(state().selectedNodeIds).toEqual([]);
  });
});

describe("网页节点保活（桌面壳）", () => {
  const otherBoard = { ...board, id: "019ff7d1-7419-74df-89e2-b1619d36ea7e" };
  const openOther = (list: CanvasNode[]) =>
    state().setDocument({
      board: otherBoard,
      nodes: list,
      edges: [],
    } as BoardDocument);

  beforeEach(() => {
    platform.desktop = true;
  });
  afterEach(() => {
    platform.desktop = false;
  });

  it("换板：网页节点留成 ghost（同一个 id、零面积、不可命中），换回来原条目复活", () => {
    const page = make("browser", { position: { x: 30, y: 40 } });
    const card = make("sticky", { position: { x: 5, y: 6 } });
    load([page, card]);
    start();
    const ghost = renderHook(() => useIsGhost(page.id));
    expect(ghost.result.current).toBe(false);

    const next = make("sticky", { boardId: otherBoard.id });
    act(() => openOther([next]));
    expect(stage.scene.has(card.id)).toBe(false);
    expect(stage.scene.get(page.id)).toMatchObject({
      kind: GHOST_KIND,
      w: 0,
      h: 0,
      x: next.position.x,
      y: next.position.y,
    });
    expect(stage.scene.hit({ x: 0, y: 0 }, { tolerance: 20 })?.id).not.toBe(
      page.id,
    );
    expect(ghost.result.current).toBe(true);

    act(() => load([page, card]));
    expect(stage.scene.get(page.id)).toMatchObject({
      kind: "browser",
      x: 30,
      y: 40,
    });
    expect(ghost.result.current).toBe(false);
  });

  it("同一块板里删网页节点：条目直接拆掉，不留 ghost", () => {
    const page = make("browser");
    load([page, make("sticky")]);
    start();
    state().removeNodes([page.id]);
    expect(stage.scene.has(page.id)).toBe(false);
  });

  it("非桌面壳：换板照常拆掉", () => {
    platform.desktop = false;
    const page = make("browser");
    load([page]);
    start();
    openOther([]);
    expect(stage.scene.has(page.id)).toBe(false);
  });

  it("ghost 不进选区；超过上限逐出最先退休的", () => {
    usePreferencesStore.setState((current) => ({
      browser: { ...current.browser, backgroundMax: 0 },
    }));
    const pages = Array.from({ length: 10 }, (_, index) =>
      make("browser", { position: { x: index, y: 0 } }),
    );
    load(pages);
    start();
    openOther([]);
    const alive = pages.filter((page) => stage.scene.has(page.id));
    // 上限 = 后台页数 0 + 条目余量 8，最先退休（先消失）的两个被逐出
    expect(alive.map((page) => page.id)).toEqual(
      pages.slice(2).map((page) => page.id),
    );
    stage.emit("select", { ids: [pages[9]!.id], additive: false });
    expect(state().selectedNodeIds).toEqual([]);
  });
});
