import * as React from "react";

/**
 * 列表的 roving tabindex（设计系统 §11.2）：侧栏树、会话列表、通知面板、表格行、设置
 * 导航、搜索结果、Dock 工具组共用同一套键盘——Tab 只进列表一次（落在一项上），↑↓
 * （横排用 ←→）在项之间移动，Home / End 跳首尾，Esc 退出，回车由项本身（按钮 / 链接）
 * 激活。同一时刻只有一项 `tabIndex=0`，其余 `-1`。
 *
 * ```tsx
 * const roving = useRoving<HTMLUListElement>({ onEscape: close });
 * <ul {...roving}>
 *   {rows.map((row) => <li key={row.id}><button data-roving-item …/></li>)}
 * </ul>
 * ```
 *
 * 项用 `data-roving-item` 标记（可改 `itemSelector`）；`aria-disabled` / `disabled`
 * 的项被跳过；`aria-selected="true"` / `aria-current` / `data-active="true"` 的项在没有
 * 焦点时作为 Tab 的落点。
 */
export type RovingOrientation = "vertical" | "horizontal" | "both";

export interface RovingOptions {
  orientation?: RovingOrientation;
  /** 到头后是否绕回另一头，默认 true。 */
  loop?: boolean;
  itemSelector?: string;
  /** Esc：退出列表（关面板、把焦点还给触发元素）。 */
  onEscape?: () => void;
}

export const ROVING_ITEM_SELECTOR = "[data-roving-item]";

/**
 * 从 `current` 出发按键盘键算下一项的下标；不是导航键返回 `null`。纯函数，测试直接用。
 * `current` 为 -1 表示焦点不在任何项上（↓ / Home 落首项，↑ / End 落末项）。
 */
export function nextRovingIndex(
  count: number,
  current: number,
  key: string,
  orientation: RovingOrientation = "vertical",
  loop = true,
): number | null {
  if (count <= 0) return null;
  const forward =
    (orientation !== "horizontal" && key === "ArrowDown") ||
    (orientation !== "vertical" && key === "ArrowRight");
  const backward =
    (orientation !== "horizontal" && key === "ArrowUp") ||
    (orientation !== "vertical" && key === "ArrowLeft");
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (forward) {
    if (current < 0) return 0;
    return current + 1 < count ? current + 1 : loop ? 0 : current;
  }
  if (backward) {
    if (current < 0) return count - 1;
    return current > 0 ? current - 1 : loop ? count - 1 : current;
  }
  return null;
}

function enabledItems(root: HTMLElement, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (item) =>
      !item.hasAttribute("disabled") &&
      item.getAttribute("aria-disabled") !== "true",
  );
}

function isCurrent(item: HTMLElement): boolean {
  return (
    item.getAttribute("aria-selected") === "true" ||
    item.hasAttribute("aria-current") ||
    item.dataset.active === "true"
  );
}

/** 让且只让 `target` 是 Tab 停靠点。 */
function setStop(items: HTMLElement[], target: HTMLElement | undefined) {
  for (const item of items) item.tabIndex = item === target ? 0 : -1;
}

export function useRoving<T extends HTMLElement = HTMLElement>({
  orientation = "vertical",
  loop = true,
  itemSelector = ROVING_ITEM_SELECTOR,
  onEscape,
}: RovingOptions = {}) {
  const ref = React.useRef<T>(null);

  // 每次渲染后把 tabindex 规整一遍：保持焦点所在项，其次当前项，最后第一项
  React.useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = enabledItems(root, itemSelector);
    const focused = items.find((item) => item === document.activeElement);
    setStop(items, focused ?? items.find(isCurrent) ?? items[0]);
  });

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<T>) => {
      const root = ref.current;
      if (!root) return;
      if (event.key === "Escape" && onEscape) {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const items = enabledItems(root, itemSelector);
      const current = items.findIndex(
        (item) =>
          item === document.activeElement ||
          item.contains(document.activeElement),
      );
      const next = nextRovingIndex(
        items.length,
        current,
        event.key,
        orientation,
        loop,
      );
      if (next === null) return;
      event.preventDefault();
      const target = items[next];
      if (!target) return;
      setStop(items, target);
      target.focus();
    },
    [itemSelector, loop, onEscape, orientation],
  );

  // 鼠标 / 程序把焦点放到某一项上时，Tab 停靠点跟过去
  const onFocusCapture = React.useCallback(
    (event: React.FocusEvent<T>) => {
      const root = ref.current;
      if (!root) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        itemSelector,
      );
      if (target) setStop(enabledItems(root, itemSelector), target);
    },
    [itemSelector],
  );

  return { ref, onKeyDown, onFocusCapture };
}
