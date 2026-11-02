import { isDrawingTool, getTool } from "./tool-store";

/**
 * 触屏上在画布空白处新建（#715）。
 *
 * 桌面上新建有三条路：空白处右键出新建菜单（`menus/CanvasMenus` 经 React Flow
 * 的 `onPaneContextMenu`，落点是指针处）、空白处双击（`whiteboard/tools/
 * use-double-click-text`）、Dock 的「+」（落点是视口中心）。手机上前两条都
 * 不通：
 *
 *  - iOS WebKit 长按不发 `contextmenu`；Radix `ContextMenuTrigger` 自带的 700ms
 *    长按只要手指抖一下（`pointermove`）就取消，而且它不经过 React Flow，菜单
 *    的目标与落点是上一次右键留下的；
 *  - 手指双击没有对应的桌面行为可接。
 *
 * 这里把两种触屏手势都翻译成「在这一点右键」：在手指下的空白画布上派发一次
 * `contextmenu`。React Flow 照常分流（`onPaneContextMenu` 记下落点、目标是
 * 空白），Radix 照常在该点展开，出的就是桌面右键的同一个新建菜单，新节点落在
 * 手指处。
 *
 *  - **长按** {@link LONG_PRESS_MS}，单指、移动不超过 {@link TAP_SLOP_PX}；
 *  - **双击**：两下都是短按（≤ {@link TAP_MAX_MS}、不移动），间隔不超过
 *    {@link DOUBLE_TAP_MS}、相距不超过 {@link DOUBLE_TAP_DISTANCE_PX}；落点是第
 *    二下。之后那次由触屏合成的 `dblclick` 被拦下，不再另外新建一条文字。
 *
 * 长按落在节点、白板对象或连线上时同样等于右键，出它们自己的菜单（打字与选字的
 * 地方除外）。第二根手指按下（捏合）、手指移动、绘图工具都不触发。Android 会在长按时自己
 * 发 `contextmenu`：等待中的长按让给它；刚由这里打开过菜单时再来的那一次被拦下，
 * 不重复弹。只认 `pointerType` 为 touch / pen，鼠标与触控板的路径一点不变。
 */

export const LONG_PRESS_MS = 500;
export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 250;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_DISTANCE_PX = 30;
/** 打开菜单之后这么久里再来的原生 `contextmenu` / 触屏 `dblclick` 算同一下。 */
export const ECHO_WINDOW_MS = 800;

interface Point {
  x: number;
  y: number;
}

/** 手势识别要的那几个字段；测试里不必造整个 `PointerEvent`。 */
export interface TouchPointer {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

export interface TouchCreateOptions {
  /** 双击这一点该不该出新建菜单：手指下必须是空白画布，当前工具不是绘图工具。 */
  canOpen: (target: EventTarget | null) => boolean;
  /**
   * 长按这一点该不该「右键」；缺省同 `canOpen`。画布上用的是
   * {@link canLongPress}：空白处出新建菜单，节点与连线上出它们自己的菜单。
   */
  canLongPress?: (target: EventTarget | null) => boolean;
  /** 在这一点「右键」。 */
  open: (target: EventTarget, point: Point) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface TouchCreateRecognizer {
  down: (event: TouchPointer) => void;
  move: (event: TouchPointer) => void;
  up: (event: TouchPointer) => void;
  cancel: (event: TouchPointer) => void;
  /** 原生 `contextmenu` 来了；返回 true 表示它是重复的那一次，调用方要拦下。 */
  nativeContextMenu: () => boolean;
  /** 触屏合成的 `dblclick` 来了；返回 true 表示刚由双击开过菜单，调用方要拦下。 */
  nativeDoubleClick: () => boolean;
  dispose: () => void;
}

function isTouch(event: TouchPointer): boolean {
  return event.pointerType === "touch" || event.pointerType === "pen";
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function createTouchCreateRecognizer(
  options: TouchCreateOptions,
): TouchCreateRecognizer {
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  /** 屏幕上按着的触点；多于一个就是捏合或两指平移。 */
  const active = new Set<number>();
  let press: {
    id: number;
    start: Point;
    at: number;
    target: EventTarget | null;
    eligible: boolean;
    moved: boolean;
    fired: boolean;
  } | null = null;
  let timer: unknown = null;
  let lastTap: { at: number; point: Point } | null = null;
  let openedAt = Number.NEGATIVE_INFINITY;

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const fire = (target: EventTarget | null, point: Point) => {
    if (!target) return;
    openedAt = now();
    lastTap = null;
    options.open(target, point);
  };

  return {
    down(event) {
      if (!isTouch(event)) return;
      active.add(event.pointerId);
      stopTimer();
      if (active.size > 1) {
        // 第二根手指：捏合或两指平移，这一下不是新建。
        press = null;
        lastTap = null;
        return;
      }
      const eligible = options.canOpen(event.target);
      const holdable = (options.canLongPress ?? options.canOpen)(event.target);
      press = {
        id: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        at: now(),
        target: event.target,
        eligible,
        moved: false,
        fired: false,
      };
      if (!holdable) return;
      const current = press;
      timer = setTimer(() => {
        timer = null;
        if (press !== current || current.moved) return;
        current.fired = true;
        fire(current.target, current.start);
      }, LONG_PRESS_MS);
    },

    move(event) {
      if (!isTouch(event) || !press || press.id !== event.pointerId) return;
      if (press.moved) return;
      if (
        distance(press.start, { x: event.clientX, y: event.clientY }) >
        TAP_SLOP_PX
      ) {
        press.moved = true;
        lastTap = null;
        stopTimer();
      }
    },

    up(event) {
      if (!isTouch(event)) return;
      active.delete(event.pointerId);
      const current = press;
      if (!current || current.id !== event.pointerId) return;
      press = null;
      stopTimer();
      if (current.fired || current.moved || !current.eligible) {
        lastTap = null;
        return;
      }
      const at = now();
      if (at - current.at > TAP_MAX_MS) {
        lastTap = null;
        return;
      }
      const point = { x: event.clientX, y: event.clientY };
      if (
        lastTap &&
        at - lastTap.at <= DOUBLE_TAP_MS &&
        distance(lastTap.point, point) <= DOUBLE_TAP_DISTANCE_PX
      ) {
        fire(current.target, point);
        return;
      }
      lastTap = { at, point };
    },

    cancel(event) {
      if (!isTouch(event)) return;
      active.delete(event.pointerId);
      if (press?.id === event.pointerId) press = null;
      lastTap = null;
      stopTimer();
    },

    nativeContextMenu() {
      if (now() - openedAt <= ECHO_WINDOW_MS) return true;
      // 系统自己认出了长按（Android）：让它走，这里不再补一次。
      if (press && timer !== null) {
        stopTimer();
        press.fired = true;
      }
      return false;
    },

    nativeDoubleClick() {
      return now() - openedAt <= ECHO_WINDOW_MS;
    },

    dispose() {
      stopTimer();
      active.clear();
      press = null;
      lastTap = null;
    },
  };
}

/** 手指下是不是空白画布：React Flow 的 pane 本身，不是节点、连线或浮层。 */
export function isEmptyCanvas(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.classList.contains("react-flow__pane")
  );
}

/** 绘图工具下那一下归工具层，空白处长按 / 双击也不出菜单。 */
export function canOpenCreateMenu(target: EventTarget | null): boolean {
  return isEmptyCanvas(target) && !isDrawingTool(getTool());
}

/** 手指下在打字或选字的地方：长按留给系统的光标与选字，不弹菜单。 */
const TEXT_SURFACE =
  'input, textarea, select, [contenteditable="true"], .xterm, .cm-editor, iframe';

/**
 * 长按：空白处同 {@link canOpenCreateMenu}；节点、白板对象与连线上也等于在那
 * 一点右键，React Flow 分流到节点 / 对象 / 连线菜单（与桌面右键一致）——否则
 * Radix 自带的 700ms 长按会抢先，用上一次右键留下的目标与落点（初始是 0,0）
 * 弹出新建菜单。打字与选字的地方不接管。
 */
export function canLongPress(target: EventTarget | null): boolean {
  if (isDrawingTool(getTool())) return false;
  if (isEmptyCanvas(target)) return true;
  if (!(target instanceof Element)) return false;
  if (target.closest(TEXT_SURFACE)) return false;
  return Boolean(target.closest(".react-flow__node, .react-flow__edge"));
}

/** 在这一点「右键」：React Flow 与 Radix 把它当成一次真的右键处理。 */
export function dispatchContextMenu(target: EventTarget, point: Point): void {
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      buttons: 0,
      clientX: point.x,
      clientY: point.y,
    }),
  );
}

/**
 * 装在画布容器上（捕获相位，React Flow 与 Radix 之前看到）。返回卸载函数。
 */
export function installTouchCreate(
  container: HTMLElement,
  options: Partial<
    Pick<TouchCreateOptions, "canOpen" | "canLongPress" | "open">
  > = {},
): () => void {
  const recognizer = createTouchCreateRecognizer({
    canOpen: options.canOpen ?? canOpenCreateMenu,
    canLongPress: options.canLongPress ?? canLongPress,
    open: options.open ?? dispatchContextMenu,
  });
  const onDown = (event: PointerEvent) => recognizer.down(event);
  const onMove = (event: PointerEvent) => recognizer.move(event);
  const onUp = (event: PointerEvent) => recognizer.up(event);
  const onCancel = (event: PointerEvent) => recognizer.cancel(event);
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onContextMenu = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if (recognizer.nativeContextMenu()) swallow(event);
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (recognizer.nativeDoubleClick()) swallow(event);
  };
  const capture = { capture: true } as const;
  container.addEventListener("pointerdown", onDown, capture);
  container.addEventListener("pointermove", onMove, capture);
  container.addEventListener("pointerup", onUp, capture);
  container.addEventListener("pointercancel", onCancel, capture);
  container.addEventListener("contextmenu", onContextMenu, capture);
  container.addEventListener("dblclick", onDoubleClick, capture);
  return () => {
    recognizer.dispose();
    container.removeEventListener("pointerdown", onDown, capture);
    container.removeEventListener("pointermove", onMove, capture);
    container.removeEventListener("pointerup", onUp, capture);
    container.removeEventListener("pointercancel", onCancel, capture);
    container.removeEventListener("contextmenu", onContextMenu, capture);
    container.removeEventListener("dblclick", onDoubleClick, capture);
  };
}
