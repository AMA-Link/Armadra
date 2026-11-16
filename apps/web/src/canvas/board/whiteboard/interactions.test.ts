// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/nodes/registry", () => ({ NODE_META: {}, nodeMeta: () => ({}) }));

const { createBoard } = await import("@armadra/board/dom");
const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { emptyWhiteboard } = await import("../../whiteboard/model");
const { resetToolStore, setTool } =
  await import("../../interaction/tool-store");
const { setCanvasLocked } = await import("../../canvas-lock");
const { addItems } = await import("../../whiteboard/store");
const { whiteboardKinds, wbKindOf } = await import("./kinds");
const { createWhiteboardSync } = await import("./sync");
const { itemAtEvent, installWhiteboardInteractions } =
  await import("./interactions");
const { getEditing, setEditing } = await import("./text-edit");

const state = () => useCanvasStore.getState();
const item = (id: string, patch: Record<string, unknown> = {}) =>
  ({
    id,
    kind: "shape",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    z: 0,
    parentId: undefined,
    style: { color: "black", size: "m", fill: "solid" },
    geo: "rectangle",
    ...patch,
  }) as never;

let board: ReturnType<typeof createBoard>;
let container: HTMLElement;
beforeEach(() => {
  resetHistory();
  resetToolStore();
  setCanvasLocked(false);
  setEditing(null);
  useCanvasStore.setState({
    whiteboard: emptyWhiteboard(),
    selectedItemIds: [],
    selectedNodeIds: [],
    selectedEdgeIds: [],
  });
  state().setWorkspace({ id: "w", name: "w" } as never);
  state().setDocument({
    board: { id: "b", workspaceId: "w", viewport: { x: 0, y: 0, zoom: 1 } },
    nodes: [],
    edges: [],
  } as never);
  document.body.innerHTML = "";
  container = document.createElement("div");
  container.dataset.boardStage = "";
  document.body.append(container);
  board = createBoard({ kinds: whiteboardKinds() }) as never;
});

describe("itemAtEvent", () => {
  it("置顶对象先于节点宿主；置底对象在宿主之下", () => {
    addItems([item("under"), item("over", { z: 1_000_000, x: 50 })]);
    const sync = createWhiteboardSync(board as never);
    const host = document.createElement("div");
    host.dataset.boardId = "node-1";
    container.append(host);
    const at = (x: number, target: EventTarget | null) =>
      itemAtEvent(
        board as never,
        { clientX: x, clientY: 10, target },
        container,
      );
    // 命中置顶对象，即便指针下是节点宿主
    expect(at(80, host)).toBe("wb:over");
    // 只命中置底对象：宿主在上面就归宿主
    expect(at(10, host)).toBeNull();
    // 指针下是空白画布：置底对象归它
    expect(at(10, container)).toBe("wb:under");
    expect(wbKindOf(state().whiteboard.items[1]!)).toBe("wb.shape:over");
    sync.destroy();
  });
});

describe("双击与长按", () => {
  it("双击文字进编辑、双击形状编辑标签、空白处建文字", () => {
    addItems([
      item("t", { kind: "text", text: "hi", x: 300 }),
      item("s", { y: 300 }),
    ]);
    const sync = createWhiteboardSync(board as never);
    const off = installWhiteboardInteractions(
      board as never,
      container,
      () => false,
    );
    board.emit("double-click", {
      target: { type: "entity", id: "wb:t", part: "body" },
      world: { x: 0, y: 0 },
    });
    expect(getEditing()).toEqual({ id: "wb:t", field: "text" });
    board.emit("double-click", {
      target: { type: "entity", id: "wb:s", part: "body" },
      world: { x: 0, y: 0 },
    });
    expect(getEditing()).toEqual({ id: "wb:s", field: "label" });
    setEditing(null);
    board.emit("double-click", {
      target: { type: "blank" },
      world: { x: 500, y: 600 },
    });
    const created = state().whiteboard.items.at(-1)!;
    expect(created).toMatchObject({ kind: "text", x: 500, y: 600 });
    expect(getEditing()?.id).toBe(`wb:${created.id}`);
    off();
    sync.destroy();
  });

  it("绘图工具、锁定、只读下空白双击不建文字", () => {
    const off = installWhiteboardInteractions(
      board as never,
      container,
      () => false,
    );
    const blank = { target: { type: "blank" as const }, world: { x: 1, y: 1 } };
    setTool("draw");
    board.emit("double-click", blank);
    setTool("select");
    setCanvasLocked(true);
    board.emit("double-click", blank);
    setCanvasLocked(false);
    expect(state().whiteboard.items).toHaveLength(0);
    off();
    const readOnly = installWhiteboardInteractions(
      board as never,
      container,
      () => true,
    );
    board.emit("double-click", blank);
    expect(state().whiteboard.items).toHaveLength(0);
    readOnly();
  });

  it("触屏长按（引擎的 context-menu 事件）合成一次 contextmenu；原生的不重复", () => {
    const off = installWhiteboardInteractions(
      board as never,
      container,
      () => false,
    );
    document.elementFromPoint = () => container;
    const seen: MouseEvent[] = [];
    container.addEventListener("contextmenu", (e) => seen.push(e));
    board.emit("context-menu", {
      target: { type: "blank" },
      screen: { x: 12, y: 34 },
      world: { x: 12, y: 34 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ clientX: 12, clientY: 34 });
    // 紧随其后的引擎事件若伴随原生 contextmenu（鼠标右键）：不再合成
    container.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    seen.length = 0;
    board.emit("context-menu", {
      target: { type: "blank" },
      screen: { x: 1, y: 1 },
      world: { x: 1, y: 1 },
    });
    expect(seen).toHaveLength(0);
    off();
  });
});
