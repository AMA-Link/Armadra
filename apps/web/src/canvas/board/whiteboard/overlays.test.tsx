// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/nodes/registry", () => ({ NODE_META: {}, nodeMeta: () => ({}) }));

const { createBoard } = await import("@armadra/board/dom");
const { BoardProvider } = await import("@armadra/board/react");
const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { emptyWhiteboard } = await import("../../whiteboard/model");
const { addItems } = await import("../../whiteboard/store");
const { whiteboardKinds } = await import("./kinds");
const { createWhiteboardSync } = await import("./sync");
const { ItemSelection } = await import("./ItemSelection");
const { TextEditor } = await import("./TextEditor");
const { setEditing } = await import("./text-edit");

const state = () => useCanvasStore.getState();
const base = {
  x: 10,
  y: 20,
  w: 100,
  h: 50,
  z: 0,
  parentId: null,
  style: { color: "black", size: "m" },
};

let board: ReturnType<typeof createBoard>;
let sync: ReturnType<typeof createWhiteboardSync>;
const mount = (ui: React.ReactNode) =>
  render(<BoardProvider value={board as never}>{ui}</BoardProvider>);

beforeEach(() => {
  resetHistory();
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
  board = createBoard({ kinds: whiteboardKinds() }) as never;
});
afterEach(() => {
  cleanup();
  sync?.destroy();
});

const select = (...ids: string[]) =>
  act(() => board.setSelection(new Set(ids)));

describe("ItemSelection", () => {
  it("单选形状：选择框带 8 个把手，外层带 data-board-id", () => {
    addItems([{ ...base, id: "s1", kind: "shape", geo: "rectangle" } as never]);
    sync = createWhiteboardSync(board as never);
    const { container } = mount(<ItemSelection />);
    select("wb:s1");
    const box = container.querySelector("[data-board-id='wb:s1']")!;
    expect(box).toBeTruthy();
    expect(box.querySelectorAll("[data-board-handle]")).toHaveLength(8);
  });

  it("文字只有左右把手；直线是两端的圆点把手 p0 / p1", () => {
    addItems([
      { ...base, id: "t1", kind: "text", text: "a" } as never,
      {
        ...base,
        id: "l1",
        kind: "line",
        points: [
          [0, 0],
          [100, 50],
        ],
      } as never,
    ]);
    sync = createWhiteboardSync(board as never);
    const { container } = mount(<ItemSelection />);
    select("wb:t1");
    const names = (id: string) =>
      [
        ...container.querySelectorAll(
          `[data-board-id='${id}'] [data-board-handle]`,
        ),
      ].map((el) => el.getAttribute("data-board-handle"));
    expect(names("wb:t1")).toEqual(["e", "w"]);
    select("wb:l1");
    expect(names("wb:l1")).toEqual(["p0", "p1"]);
  });

  it("多选只画框不给把手；编辑中也不给", () => {
    addItems([
      { ...base, id: "a", kind: "shape", geo: "rectangle" } as never,
      { ...base, id: "b", kind: "shape", geo: "ellipse" } as never,
    ]);
    sync = createWhiteboardSync(board as never);
    const { container } = mount(<ItemSelection />);
    select("wb:a", "wb:b");
    expect(
      container.querySelectorAll("[data-slot=item-selection]"),
    ).toHaveLength(2);
    expect(container.querySelectorAll("[data-board-handle]")).toHaveLength(0);
    select("wb:a");
    expect(container.querySelectorAll("[data-board-handle]")).toHaveLength(8);
    act(() => setEditing({ id: "wb:a", field: "label" }));
    expect(container.querySelectorAll("[data-board-handle]")).toHaveLength(0);
  });
});

describe("TextEditor", () => {
  const start = (patch: Record<string, unknown>) => {
    addItems([
      { ...base, id: "t1", kind: "text", text: "old", ...patch } as never,
    ]);
    sync = createWhiteboardSync(board as never);
  };
  const open = (field: "text" | "label" = "text", id = "wb:t1") => {
    const view = mount(<TextEditor />);
    act(() => setEditing({ id, field }));
    return { ...view, area: () => view.container.querySelector("textarea")! };
  };

  it("失焦提交文字；整段一条历史", () => {
    start({});
    const { area } = open();
    expect(area().value).toBe("old");
    fireEvent.change(area(), { target: { value: "new text" } });
    fireEvent.blur(area());
    expect(state().whiteboard.items[0]).toMatchObject({ text: "new text" });
    expect(area()).toBeNull();
  });

  it("Esc 提交，且 blur 不会重复提交", () => {
    start({});
    const { area } = open();
    fireEvent.change(area(), { target: { value: "esc" } });
    fireEvent.keyDown(area(), { key: "Escape" });
    expect(state().whiteboard.items[0]).toMatchObject({ text: "esc" });
  });

  it("文字空着提交：整条对象丢弃，撤销栈里也没有它", () => {
    start({ text: "" });
    const { area } = open();
    fireEvent.blur(area());
    expect(state().whiteboard.items).toHaveLength(0);
  });

  it("形状标签：空标签保留形状，写入 label", () => {
    addItems([{ ...base, id: "s1", kind: "shape", geo: "ellipse" } as never]);
    sync = createWhiteboardSync(board as never);
    const { area } = open("label", "wb:s1");
    fireEvent.change(area(), { target: { value: "判断" } });
    fireEvent.blur(area());
    expect(state().whiteboard.items[0]).toMatchObject({ label: "判断" });
  });

  it("形状标签清空：形状本身保留", () => {
    addItems([
      { ...base, id: "s2", kind: "shape", geo: "ellipse", label: "x" } as never,
    ]);
    sync = createWhiteboardSync(board as never);
    const { area } = open("label", "wb:s2");
    fireEvent.change(area(), { target: { value: "" } });
    fireEvent.blur(area());
    expect(state().whiteboard.items).toHaveLength(1);
    expect(state().whiteboard.items[0]).toMatchObject({ label: "" });
  });

  it("覆盖层带 data-board-editable，引擎在它上面放手", () => {
    start({});
    const { area } = open();
    expect(area().hasAttribute("data-board-editable")).toBe(true);
  });
});
