import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetToolStore, setTool } from "./tool-store";
import {
  DOUBLE_TAP_MS,
  ECHO_WINDOW_MS,
  LONG_PRESS_MS,
  TAP_MAX_MS,
  canLongPress,
  canOpenCreateMenu,
  createTouchCreateRecognizer,
  installTouchCreate,
  type TouchPointer,
} from "./touch-create";

/**
 * 触屏新建（#715）：空白处长按或双击 = 在那一点右键。识别器只看时间与位移，
 * 这里用假时钟逐条走。
 */

const PANE = { pane: true } as unknown as EventTarget;
const NODE = { node: true } as unknown as EventTarget;

function setup() {
  vi.useFakeTimers();
  const open = vi.fn();
  const recognizer = createTouchCreateRecognizer({
    canOpen: (target) => target === PANE,
    open,
  });
  return { open, recognizer };
}

function at(
  x: number,
  y: number,
  extra: Partial<TouchPointer> = {},
): TouchPointer {
  return {
    pointerId: 1,
    pointerType: "touch",
    clientX: x,
    clientY: y,
    target: PANE,
    ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("长按", () => {
  it("空白处按住 500ms 在按下的那一点打开", () => {
    const { open, recognizer } = setup();
    recognizer.down(at(100, 200));
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledWith(PANE, { x: 100, y: 200 });
    // 松手不再算一次点按。
    recognizer.up(at(100, 200));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("手指抖几个像素不取消，移动超过 10px 取消", () => {
    const { open, recognizer } = setup();
    recognizer.down(at(100, 200));
    recognizer.move(at(104, 203));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(open).toHaveBeenCalledTimes(1);

    recognizer.up(at(104, 203));
    vi.advanceTimersByTime(ECHO_WINDOW_MS + 1);
    recognizer.down(at(100, 200));
    recognizer.move(at(115, 200));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("提前松手、第二根手指按下（捏合）都不打开", () => {
    const { open, recognizer } = setup();
    recognizer.down(at(100, 200));
    vi.advanceTimersByTime(LONG_PRESS_MS - 100);
    recognizer.up(at(100, 200));
    vi.advanceTimersByTime(LONG_PRESS_MS);

    recognizer.down(at(100, 200));
    recognizer.down(at(160, 260, { pointerId: 2 }));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(open).not.toHaveBeenCalled();
  });

  it("按在节点上、或者是鼠标，不接管", () => {
    const { open, recognizer } = setup();
    recognizer.down(at(100, 200, { target: NODE }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    recognizer.up(at(100, 200, { target: NODE }));

    recognizer.down(at(100, 200, { pointerType: "mouse" }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(open).not.toHaveBeenCalled();
  });

  it("系统自己发了 contextmenu（Android 长按）：让给它，不再补一次", () => {
    const { open, recognizer } = setup();
    recognizer.down(at(100, 200));
    vi.advanceTimersByTime(LONG_PRESS_MS - 50);
    expect(recognizer.nativeContextMenu()).toBe(false);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(open).not.toHaveBeenCalled();
  });

  it("这里先开了菜单，随后系统那一次被认作重复", () => {
    const { recognizer } = setup();
    recognizer.down(at(100, 200));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(recognizer.nativeContextMenu()).toBe(true);
    vi.advanceTimersByTime(ECHO_WINDOW_MS + 1);
    expect(recognizer.nativeContextMenu()).toBe(false);
  });
});

describe("长按与双击各认各的目标", () => {
  it("canLongPress 放行的节点上长按打开，双击不打开", () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const recognizer = createTouchCreateRecognizer({
      canOpen: (target) => target === PANE,
      canLongPress: (target) => target === PANE || target === NODE,
      open,
    });
    recognizer.down(at(10, 10, { target: NODE }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(open).toHaveBeenCalledWith(NODE, { x: 10, y: 10 });
    recognizer.up(at(10, 10, { target: NODE }));
    vi.advanceTimersByTime(ECHO_WINDOW_MS + 1);

    for (let i = 0; i < 2; i += 1) {
      recognizer.down(at(10, 10, { target: NODE }));
      vi.advanceTimersByTime(40);
      recognizer.up(at(10, 10, { target: NODE }));
    }
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("双击", () => {
  function tap(recognizer: ReturnType<typeof setup>["recognizer"], x = 100) {
    recognizer.down(at(x, 200));
    vi.advanceTimersByTime(60);
    recognizer.up(at(x, 200));
  }

  it("两下短按在第二下的位置打开，随后那次触屏 dblclick 被拦下", () => {
    const { open, recognizer } = setup();
    tap(recognizer, 100);
    vi.advanceTimersByTime(120);
    tap(recognizer, 112);
    expect(open).toHaveBeenCalledWith(PANE, { x: 112, y: 200 });
    expect(recognizer.nativeDoubleClick()).toBe(true);
  });

  it("单击不打开，也不拦 dblclick", () => {
    const { open, recognizer } = setup();
    tap(recognizer);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(open).not.toHaveBeenCalled();
    expect(recognizer.nativeDoubleClick()).toBe(false);
  });

  it("两下间隔太久、相距太远、或其中一下按得太久，都不算双击", () => {
    const { open, recognizer } = setup();
    tap(recognizer);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);
    tap(recognizer);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);

    tap(recognizer, 100);
    vi.advanceTimersByTime(100);
    tap(recognizer, 200);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);

    tap(recognizer);
    vi.advanceTimersByTime(100);
    recognizer.down(at(100, 200));
    vi.advanceTimersByTime(TAP_MAX_MS + 1);
    recognizer.up(at(100, 200));
    expect(open).not.toHaveBeenCalled();
  });

  it("第二下落在节点上不算", () => {
    const { open, recognizer } = setup();
    tap(recognizer);
    vi.advanceTimersByTime(100);
    recognizer.down(at(100, 200, { target: NODE }));
    recognizer.up(at(100, 200, { target: NODE }));
    expect(open).not.toHaveBeenCalled();
  });
});

describe("挂到画布容器上", () => {
  beforeEach(() => resetToolStore());
  afterEach(() => {
    resetToolStore();
    document.body.innerHTML = "";
  });

  function mount() {
    const stage = document.createElement("div");
    const pane = document.createElement("div");
    pane.className = "react-flow__pane";
    stage.append(pane);
    document.body.append(stage);
    const menus: { x: number; y: number; target: EventTarget | null }[] = [];
    stage.addEventListener("contextmenu", (event) =>
      menus.push({ x: event.clientX, y: event.clientY, target: event.target }),
    );
    return { stage, pane, menus };
  }

  function pointer(type: string, target: Element, x: number, y: number) {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
    });
    Object.assign(event, { pointerId: 1, pointerType: "touch" });
    target.dispatchEvent(event);
  }

  it("长按空白处在手指下派发一次 contextmenu，React Flow 与 Radix 照右键处理", () => {
    vi.useFakeTimers();
    const { stage, pane, menus } = mount();
    const off = installTouchCreate(stage);
    pointer("pointerdown", pane, 40, 60);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menus).toEqual([{ x: 40, y: 60, target: pane }]);
    pointer("pointerup", pane, 40, 60);
    off();
  });

  it("双击空白处之后那次 dblclick 不再往下传（不另建文字）", () => {
    vi.useFakeTimers();
    const { stage, pane, menus } = mount();
    const off = installTouchCreate(stage);
    const dblclicks = vi.fn();
    pane.addEventListener("dblclick", dblclicks);
    for (let i = 0; i < 2; i += 1) {
      pointer("pointerdown", pane, 40, 60);
      vi.advanceTimersByTime(50);
      pointer("pointerup", pane, 40, 60);
      vi.advanceTimersByTime(80);
    }
    expect(menus).toHaveLength(1);
    pane.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(dblclicks).not.toHaveBeenCalled();
    off();
  });

  it("长按节点或连线等于在那里右键；打字与选字的地方不接管", () => {
    const { pane } = mount();
    const node = document.createElement("div");
    node.className = "react-flow__node";
    const header = document.createElement("span");
    const editor = document.createElement("textarea");
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const screen = document.createElement("span");
    terminal.append(screen);
    node.append(header, editor, terminal);
    const edge = document.createElement("div");
    edge.className = "react-flow__edge";
    pane.parentElement!.append(node, edge);

    expect(canLongPress(pane)).toBe(true);
    expect(canLongPress(header)).toBe(true);
    expect(canLongPress(edge)).toBe(true);
    expect(canLongPress(editor)).toBe(false);
    expect(canLongPress(screen)).toBe(false);
    expect(canLongPress(document.body)).toBe(false);
    // 双击只认空白处。
    expect(canOpenCreateMenu(header)).toBe(false);
    setTool("draw");
    expect(canLongPress(header)).toBe(false);
  });

  it("绘图工具下不出菜单", () => {
    const { pane } = mount();
    expect(canOpenCreateMenu(pane)).toBe(true);
    setTool("draw");
    expect(canOpenCreateMenu(pane)).toBe(false);
    setTool("hand");
    expect(canOpenCreateMenu(pane)).toBe(true);
    expect(canOpenCreateMenu(document.body)).toBe(false);
  });
});
