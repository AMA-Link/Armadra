import { useSyncExternalStore } from "react";

/**
 * 手机布局的唯一判据。两种情况都算：
 * - 窄屏：宽度 ≤ 767px（手机竖屏、窄窗口）；
 * - 矮的触屏横屏：主指针是手指、高度 ≤ 500px、宽度 < 1024px（手机横过来
 *   宽 870 以上、高只有 400 上下）。宽度上限挡住键盘弹起后变矮的平板，
 *   横屏平板不会因为键盘切成手机布局。
 *
 * 样式侧不另写阈值：Tailwind 的 `compact:` 变体（`styles/app.css`）与几处
 * 手写的 `@media` 都照抄这一条，`platform/layout.test.ts` 逐文件核对。
 */
export const COMPACT_QUERY =
  "(max-width: 767px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)";

export function isCompactLayout(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(COMPACT_QUERY).matches
  );
}
function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => undefined;
  const media = window.matchMedia(COMPACT_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, isCompactLayout, () => false);
}
