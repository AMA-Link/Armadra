// 输入路由器：原生 Pointer Events 装在容器上，归一成 PointerInput，交给当前工具的手势。
import type { Vec } from "../../core";
import { createPinch } from "../gestures/pinch";
import type { GestureCtx, GestureDeps } from "../gestures/types";
import type {
  Board,
  Gesture,
  HitTarget,
  InputDevice,
  Modifiers,
  PointerInput,
  Tool,
} from "../types";
import { createTouchRecognizer, ECHO_WINDOW_MS } from "./recognizers";
import { createResolveTarget, type ResolveTarget } from "./target";
import { attachSafariGestures, createWheelHandler } from "./wheel";

export interface InputRouterDeps {
  board: Board;
  tool(): Tool;
  /** 外部维护的修饰键（空格由键盘层写入）；shift / alt / meta / ctrl 以事件为准。 */
  modifiers(): Modifiers;
  inputDevice(): InputDevice;
  /** 查 Canvas 对象（画布层没有 DOM 元素）；缺省全是空白。 */
  hitCanvas?(world: Vec): HitTarget | undefined | null;
  /** 整体替换按下目标的解析；缺省走 DOM 属性约定（见 target.ts）。 */
  resolveTarget?: ResolveTarget;
  gestureDeps?: GestureDeps;
}

export interface InputRouter {
  /** 取消进行中的手势（切换工具、卸载、失焦）。 */
  cancel(): void;
  destroy(): void;
}

export function createInputRouter(
  container: HTMLElement,
  deps: InputRouterDeps,
): InputRouter {
  const { board } = deps;
  const { camera } = board;
  const resolve = deps.resolveTarget ?? createResolveTarget(deps.hitCanvas);
  const ctx: GestureCtx = { board, deps: deps.gestureDeps ?? {} };
  let active: Gesture | null = null;
  /** 活动手势里的手指：id → 最近的输入（带按下时的目标；第二指接管时取首指位置）。 */
  const contacts = new Map<number, PointerInput>();
  /** 手势已结束但手指还没抬起的指针：它们的后续事件一律忽略。 */
  const orphans = new Set<number>();
  const previousStyle = container.style.touchAction;
  container.style.touchAction = "none";

  const local = (e: { clientX: number; clientY: number }): Vec => {
    const r = container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const mods = (e: MouseEvent | PointerEvent): Modifiers => ({
    ...deps.modifiers(),
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
    ctrl: e.ctrlKey,
  });
  const input = (e: PointerEvent, target?: HitTarget): PointerInput => {
    const screen = local(e);
    const world = camera.screenToWorld(screen);
    return {
      id: e.pointerId,
      type:
        e.pointerType === "touch" || e.pointerType === "pen"
          ? e.pointerType
          : "mouse",
      button: e.button,
      screen,
      world,
      pressure: e.pressure,
      mods: mods(e),
      target: target ?? resolve(e.target, world),
      time: e.timeStamp,
    };
  };

  const setActive = (gesture: Gesture | null) => {
    const changed = (active !== null) !== (gesture !== null);
    active = gesture;
    if (changed) board.emit("gesture", { active: gesture !== null });
  };
  /** 放开所有手指；`orphan` 时它们的后续事件被忽略（手势已结束但手指还按着）。 */
  const drop = (orphan: boolean) => {
    if (orphan) for (const id of contacts.keys()) orphans.add(id);
    contacts.clear();
    return active;
  };
  const cancel = () => {
    const gesture = drop(false);
    recognizer.reset();
    setActive(null);
    gesture?.cancel();
  };

  const recognizer = createTouchRecognizer({
    longPress(at) {
      if (active && !contacts.has(at.id)) return false;
      const gesture = drop(true);
      setActive(null);
      gesture?.cancel();
      const { target, screen, world } = at;
      board.emit("context-menu", { target, screen, world });
      return true;
    },
    doubleTap: ({ target, world }) =>
      board.emit("double-click", { target, world }),
  });

  const onDown = (e: PointerEvent) => {
    const p = input(e);
    if (p.type === "mouse") orphans.clear();
    if (orphans.size > 0) return void orphans.add(p.id);
    if (active) {
      if (contacts.has(p.id) || p.type === "mouse") return;
      const [firstId, first] = [...contacts.entries()][0]!;
      recognizer.reset();
      const next = active.add
        ? active.add(p)
        : (active.cancel(),
          createPinch(ctx, { id: firstId, ...first.screen }, p));
      if (!next) return;
      active = next;
      contacts.set(p.id, p);
    } else {
      const gesture = deps.tool().begin(p, board);
      if (p.type !== "mouse" && deps.tool().id === "select") recognizer.down(p);
      if (!gesture) return;
      contacts.set(p.id, p);
      setActive(gesture);
    }
    container.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    const down = contacts.get(e.pointerId);
    if (!down || !active) return;
    const p = input(e, down.target);
    contacts.set(p.id, p);
    recognizer.move(p);
    active.move(p);
  };
  const onUp = (e: PointerEvent) => {
    if (orphans.delete(e.pointerId)) return;
    const down = contacts.get(e.pointerId);
    if (!down || !active) return recognizer.reset();
    const p = input(e, down.target);
    recognizer.up(p);
    contacts.delete(p.id);
    const gesture = drop(true);
    gesture?.end(p);
    setActive(null);
  };
  const onCancel = (e: PointerEvent) => {
    if (orphans.delete(e.pointerId)) return;
    if (contacts.has(e.pointerId)) cancel();
  };
  /** 识别器刚触发过：随后原生的 contextmenu / dblclick / click 算同一下。 */
  const echo = (e: Event) =>
    recognizer.firedAt > 0 && e.timeStamp - recognizer.firedAt < ECHO_WINDOW_MS;
  const onMouse = (e: MouseEvent) => {
    const screen = local(e);
    const world = camera.screenToWorld(screen);
    const target = resolve(e.target, world);
    if (e.type === "click")
      return void (echo(e) && (e.stopPropagation(), e.preventDefault()));
    if (target.type === "editable") return;
    if (e.type === "contextmenu") e.preventDefault();
    if (echo(e)) return;
    if (e.type === "contextmenu")
      board.emit("context-menu", { target, screen, world });
    else board.emit("double-click", { target, world });
  };

  const wheel = createWheelHandler(container, camera, deps.inputDevice);
  const detachGestures = attachSafariGestures(container, camera);
  const on = <E extends Event>(
    target: EventTarget,
    name: string,
    fn: (e: E) => void,
    opts?: AddEventListenerOptions,
  ) => {
    target.addEventListener(name, fn as EventListener, opts);
    return () => target.removeEventListener(name, fn as EventListener, opts);
  };
  const offs = [
    on<PointerEvent>(container, "pointerdown", onDown),
    on<PointerEvent>(container, "pointermove", onMove),
    on<PointerEvent>(container, "pointerup", onUp),
    on<PointerEvent>(container, "pointercancel", onCancel),
    on<PointerEvent>(container, "lostpointercapture", onCancel),
    on<WheelEvent>(container, "wheel", wheel, { passive: false }),
    on<MouseEvent>(container, "contextmenu", onMouse),
    on<MouseEvent>(container, "dblclick", onMouse),
    on<MouseEvent>(container, "click", onMouse, { capture: true }),
    on(window, "blur", cancel),
  ];
  return {
    cancel,
    destroy() {
      cancel();
      offs.forEach((off) => off());
      detachGestures();
      container.style.touchAction = previousStyle;
    },
  };
}
