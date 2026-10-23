/**
 * 键盘触发的浮层不播动画（设计系统 §8.1）。
 *
 * 同一个面板，指针点开时按 §8.3 出场；快捷键 / 回车 / Tab 到触发器打开时直接渲染
 * 终态，Esc 关闭也是即时的。`ui/` 的对话框、Sheet、菜单、Popover、Tooltip 内容
 * 都带 `motion-*` 类，`styles/motion.css` 在 `[data-instant]` 下 `animation: none`——
 * 调用方不必各自判断「这次是不是键盘开的」，这里在全局记一份输入方式：
 *
 *  1. 最近一次输入是键盘（keydown）还是指针（pointerdown / 真的移动过的 pointermove）；
 *  2. 浮层挂进 `<body>` 的那一刻（Radix 的 Portal 都落在这里），输入方式是键盘就
 *     给它和它的遮罩打 `data-instant`——微任务里打，早于第一次样式计算，动画不会起；
 *  3. 按 Esc 时给所有已打开的浮层打 `data-instant`，Radix 随后关闭它们：没有退场
 *     动画可等，立刻卸载。
 *
 * 命令面板 / 快速打开自己就带 `data-instant`（`ui/command`），遮罩跟着它走。
 * 不改 `ui/`，也不要求每个调用点传 prop。
 */

/** 会播进出场动画的浮层层（遮罩、内容、Sheet、菜单类、Tooltip）。 */
const TARGETS =
  ".motion-pop, .motion-dialog, .motion-overlay, .motion-sheet, .motion-tip";

/** 已经打开（正在播或已播完入场）的浮层。 */
const OPEN =
  '[data-state="open"], [data-state="delayed-open"], [data-open]:not([data-open="false"])';

let keyboard = false;

/** 最近一次输入是不是键盘。 */
export function inputIsKeyboard(): boolean {
  return keyboard;
}

/** 只给测试用。 */
export function resetInputModality(): void {
  keyboard = false;
}

function instant(element: Element): void {
  if (!element.hasAttribute("data-instant"))
    element.setAttribute("data-instant", "true");
}

/** 一棵刚挂上的子树：键盘开的就打标；遮罩跟着紧邻的内容走。 */
function markSubtree(root: Element): void {
  const found = [
    ...(root.matches(TARGETS) ? [root] : []),
    ...root.querySelectorAll(TARGETS),
  ];
  if (keyboard) for (const element of found) instant(element);
  for (const element of found) {
    if (!element.classList.contains("motion-overlay")) continue;
    const next = element.nextElementSibling;
    if (next?.hasAttribute("data-instant")) instant(element);
  }
}

function markOpen(doc: Document): void {
  for (const element of doc.querySelectorAll(TARGETS))
    if (element.matches(OPEN)) instant(element);
}

/**
 * 装全局的输入方式追踪与挂载观察。返回卸载函数。App 挂一次。
 */
export function installInstantOverlays(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view) return () => undefined;

  const onKeyDown = (event: KeyboardEvent) => {
    keyboard = true;
    if (event.key === "Escape") markOpen(doc);
  };
  const onPointer = () => {
    keyboard = false;
  };
  const onPointerMove = (event: Event) => {
    // 布局变化后浏览器会补发一次位移为 0 的合成移动，那不算指针在用
    const { movementX, movementY } = event as PointerEvent;
    if ((movementX ?? 1) !== 0 || (movementY ?? 1) !== 0) keyboard = false;
  };
  view.addEventListener("keydown", onKeyDown, true);
  view.addEventListener("pointerdown", onPointer, true);
  view.addEventListener("pointermove", onPointerMove, true);

  let observer: MutationObserver | undefined;
  if (typeof MutationObserver === "function" && doc.body) {
    observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof view.Element) markSubtree(node);
    });
    observer.observe(doc.body, { childList: true });
  }

  return () => {
    view.removeEventListener("keydown", onKeyDown, true);
    view.removeEventListener("pointerdown", onPointer, true);
    view.removeEventListener("pointermove", onPointerMove, true);
    observer?.disconnect();
  };
}
