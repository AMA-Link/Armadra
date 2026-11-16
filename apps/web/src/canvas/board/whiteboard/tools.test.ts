// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PointerInput } from "@armadra/board/dom";

vi.mock("@/nodes/registry", () => ({ NODE_META: {}, nodeMeta: () => ({}) }));

const { createBoard } = await import("@armadra/board/dom");
const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { emptyWhiteboard } = await import("../../whiteboard/model");
const { setNextStyle, resetToolStore } =
  await import("../../interaction/tool-store");
const { setCanvasLocked } = await import("../../canvas-lock");
const { whiteboardKinds } = await import("./kinds");
const { createBoardTool, DRAFT_ID, pressureOf } = await import("./tools");
const { getEditing, setEditing } = await import("./text-edit");
const { addItems } = await import("../../whiteboard/store");

const state = () => useCanvasStore.getState();
const items = () => state().whiteboard.items;

const input = (
  x: number,
  y: number,
  patch: Partial<PointerInput> = {},
): PointerInput => ({
  id: 1,
  type: "mouse",
  button: 0,
  screen: { x, y },
  world: { x, y },
  pressure: 0.5,
  mods: { shift: false, alt: false, meta: false, ctrl: false, space: false },
  target: { type: "blank" },
  time: 0,
  ...patch,
});

let board: ReturnType<typeof createBoard>;
beforeEach(() => {
  resetHistory();
  resetToolStore();
  setCanvasLocked(false);
  setEditing(null);
  useCanvasStore.setState({
    whiteboard: emptyWhiteboard(),
    selectedNodeIds: [],
    selectedEdgeIds: [],
    selectedItemIds: [],
  });
  state().setWorkspace({ id: "w", name: "w" } as never);
  state().setDocument({
    board: { id: "b", workspaceId: "w", viewport: { x: 0, y: 0, zoom: 1 } },
    nodes: [],
    edges: [],
  } as never);
  board = createBoard({ kinds: whiteboardKinds() }) as never;
});

const drive = (
  tool: Parameters<typeof createBoardTool>[0],
  points: [number, number][],
  patch: Partial<PointerInput> = {},
) => {
  const gesture = createBoardTool(tool, board as never).begin(
    input(...points[0]!, patch),
    board as never,
  );
  for (const [x, y] of points.slice(1, -1)) gesture?.move(input(x, y, patch));
  const [lx, ly] = points.at(-1)!;
  gesture?.end(input(lx, ly, patch));
  return gesture;
};

describe("画笔 / 高亮", () => {
  it("拖一笔：落成一条墨迹并选中；鼠标压力恒 0.5", () => {
    drive("draw", [
      [10, 10],
      [30, 40],
      [60, 30],
    ]);
    expect(items()).toHaveLength(1);
    const ink = items()[0]!;
    expect(ink.kind).toBe("ink");
    expect(
      (ink as { points: number[][] }).points.every((p) => p[2] === 0.5),
    ).toBe(true);
    expect(state().selectedItemIds).toEqual([`wb:${ink.id}`]);
  });

  it("进行中画在 wb:~draft 临时实体上，松手后移除且不进撤销栈", () => {
    const gesture = createBoardTool("draw", board as never).begin(
      input(0, 0),
      board as never,
    )!;
    gesture.move(input(30, 10));
    expect(board.scene.has(DRAFT_ID)).toBe(true);
    expect(board.scene.get(DRAFT_ID)!.kind).toBe("wb.ink");
    gesture.end(input(40, 10));
    expect(board.scene.has(DRAFT_ID)).toBe(false);
    expect(board.scene.canUndo()).toBe(false);
  });

  it("高亮笔落成 highlight 墨迹；触屏取真实压力", () => {
    drive("highlight", [
      [0, 0],
      [80, 0],
    ]);
    expect((items()[0] as { highlight?: boolean }).highlight).toBe(true);
    expect(pressureOf({ type: "pen", pressure: 0.8 })).toBe(0.8);
    expect(pressureOf({ type: "touch", pressure: 0 })).toBe(0.5);
    expect(pressureOf({ type: "mouse", pressure: 0.9 })).toBe(0.5);
  });

  it("取消（第二根手指）丢掉这一笔", () => {
    const g = createBoardTool("draw", board as never).begin(
      input(0, 0, { type: "touch" }),
      board as never,
    )!;
    g.move(input(20, 20, { type: "touch" }));
    g.cancel();
    expect(items()).toHaveLength(0);
    expect(board.scene.has(DRAFT_ID)).toBe(false);
  });
});

describe("形状 / 直线 / 箭头", () => {
  it("形状按当前样式的几何，拖出的矩形四个方向都成立", () => {
    setNextStyle({ geo: "star" });
    drive("geo", [
      [100, 100],
      [40, 30],
    ]);
    expect(items()[0]).toMatchObject({
      kind: "shape",
      geo: "star",
      x: 40,
      y: 30,
      w: 60,
      h: 70,
    });
  });

  it("点一下放默认尺寸的形状；直线点一下不落成", () => {
    drive("geo", [
      [50, 50],
      [50, 50],
    ]);
    expect(items()[0]).toMatchObject({ w: 160, h: 120 });
    drive("line", [
      [0, 0],
      [1, 1],
    ]);
    expect(items()).toHaveLength(1);
  });

  it("箭头带 arrowEnd", () => {
    drive("arrow", [
      [0, 0],
      [100, 50],
    ]);
    expect(items()[0]).toMatchObject({ kind: "line", arrowEnd: true });
  });
});

describe("文字工具", () => {
  it("鼠标按下就建空文字并进编辑", () => {
    createBoardTool("text", board as never).begin(
      input(70, 80),
      board as never,
    );
    expect(items()[0]).toMatchObject({ kind: "text", x: 70, y: 80, text: "" });
    expect(getEditing()).toEqual({
      id: `wb:${items()[0]!.id}`,
      field: "text",
    });
  });

  it("手指抬起才建；移动超过阈值或取消都不建", () => {
    const touch = { type: "touch" as const };
    drive(
      "text",
      [
        [10, 10],
        [10, 10],
      ],
      touch,
    );
    expect(items()).toHaveLength(1);
    drive(
      "text",
      [
        [10, 10],
        [60, 60],
        [60, 60],
      ],
      touch,
    );
    expect(items()).toHaveLength(1);
    const g = createBoardTool("text", board as never).begin(
      input(0, 0, touch),
      board as never,
    )!;
    g.cancel();
    g.end(input(0, 0, touch));
    expect(items()).toHaveLength(1);
  });
});

describe("拒绝进入手势", () => {
  it("输入区、锁定、只读、非左键", () => {
    const tool = createBoardTool("draw", board as never);
    expect(
      tool.begin(input(0, 0, { target: { type: "editable" } }), board as never),
    ).toBeNull();
    expect(tool.begin(input(0, 0, { button: 2 }), board as never)).toBeNull();
    setCanvasLocked(true);
    expect(tool.begin(input(0, 0), board as never)).toBeNull();
    setCanvasLocked(false);
    board.setOptions({ readOnly: true });
    expect(tool.begin(input(0, 0), board as never)).toBeNull();
  });
});

describe("直线端点", () => {
  it("选择工具上拖 p1 把手：端点跟手，包围盒重算，整段一条历史", () => {
    addItems([
      {
        id: "line00000001",
        kind: "line",
        x: 0,
        y: 0,
        w: 100,
        h: 50,
        z: 0,
        parentId: undefined,
        style: { color: "black", size: "m" },
        points: [
          [0, 0],
          [100, 50],
        ],
      } as never,
    ]);
    const tool = createBoardTool("select", board as never);
    const g = tool.begin(
      input(100, 50, {
        target: {
          type: "handle",
          id: "wb:line00000001",
          handle: "p1" as never,
        },
      }),
      board as never,
    )!;
    g.move(input(150, 100));
    g.move(input(200, 120));
    g.end(input(200, 120));
    const line = items()[0] as { w: number; h: number; points: number[][] };
    expect(line.points).toEqual([
      [0, 0],
      [200, 120],
    ]);
    expect(line).toMatchObject({ w: 200, h: 120 });
    state().undo();
    expect((items()[0] as { w: number }).w).toBe(100);
  });
});
