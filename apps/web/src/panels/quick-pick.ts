import { matchKeyboardEvent } from "../keybindings";

/**
 * ⌘1–⌘5 快选（设计系统 §11.2）：命令面板与快速打开里，按下修饰键 + 数字直接运行
 * 列表里第 N 行，不用先 ↓ 到它。读的是 cmdk 过滤、排序之后**实际渲染出来**的行，
 * 所以输入了查询词之后 ⌘1 就是现在排第一的那条。
 */
export const QUICK_PICK_COUNT = 5;

/** 这次按键是几号快选（1–5），不是就 `null`。修饰键要求完全一致，⌘⇧1 不算。 */
export function quickPickNumber(event: KeyboardEvent): number | null {
  for (let n = 1; n <= QUICK_PICK_COUNT; n += 1)
    if (matchKeyboardEvent(event, `Mod+${n}`)) return n;
  return null;
}

/**
 * 点第 `number` 行（从 1 起）。`input` 是命令输入框，从它往上找 cmdk 根，再取根里
 * 没被禁用的行；点击就是 cmdk 的 `onSelect`。返回是否真的点了。
 */
export function runQuickPick(input: Element, number: number): boolean {
  const root = input.closest("[cmdk-root]");
  if (!root) return false;
  const rows = [...root.querySelectorAll<HTMLElement>("[cmdk-item]")].filter(
    (row) => row.getAttribute("aria-disabled") !== "true",
  );
  const row = rows[number - 1];
  if (!row) return false;
  row.click();
  return true;
}

/** `CommandInput` 的 `onKeyDown`：命中就拦下事件并运行。 */
export function quickPickKeyDown(event: {
  nativeEvent: KeyboardEvent;
  currentTarget: Element;
  preventDefault: () => void;
}): void {
  const number = quickPickNumber(event.nativeEvent);
  if (number === null) return;
  if (runQuickPick(event.currentTarget, number)) event.preventDefault();
}
