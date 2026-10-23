/**
 * 最近一次输入是键盘还是指针（设计系统 §8.1：键盘触发的面板不动画）。
 *
 * 设置对话框由 ⌘, 或菜单打开：⌘, 渲染终态（`data-instant`），菜单点开按对话框出场。
 * 全局只挂一对捕获监听，模块首次被引用时安装。
 */
let keyboard = false;
let installed = false;

function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "keydown",
    () => {
      keyboard = true;
    },
    true,
  );
  for (const type of ["pointerdown", "mousedown", "touchstart"]) {
    document.addEventListener(
      type,
      () => {
        keyboard = false;
      },
      true,
    );
  }
}

install();

/** 最近一次输入事件是不是键盘。 */
export function lastInputWasKeyboard(): boolean {
  return keyboard;
}
