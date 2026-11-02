import { useSyncExternalStore } from "react";

/**
 * 手机布局的唯一判据：宽度 ≤ 767px（手机竖屏、窄窗口）。
 *
 * 手机横过来（宽 870 上下、高 400 上下）走**电脑布局**（#715 推翻了 #683 的
 * 「矮的触屏横屏也算手机」）：侧栏、右上工具簇、整排 Dock 与桌面一致，只按
 * 矮屏与左右安全区收紧——那几处判据是 {@link PHONE_LANDSCAPE_QUERY}。宽度不到
 * 768 的横屏（iPhone SE 一类）仍是手机布局。
 *
 * 样式侧不另写阈值：Tailwind 的 `compact:` 变体（`styles/app.css`）与几处
 * 手写的 `@media` 都照抄这一条，`platform/layout.test.ts` 逐文件核对。
 */
export const COMPACT_QUERY = "(max-width: 767px)";

/**
 * 手机横屏：主指针是手指、高度 ≤ 500px、宽度 < 1024px。宽度上限挡住键盘弹起
 * 后变矮的平板。它不改布局形态（那是 {@link COMPACT_QUERY} 的事），只决定电脑
 * 布局在手机横屏上的几处默认值：侧栏与缩略图默认收起、Dock 工具组不折叠、
 * 输入框保持 16px（`desktop:` 变体，防 iOS 聚焦缩放）。
 */
export const PHONE_LANDSCAPE_QUERY =
  "(pointer: coarse) and (max-height: 500px) and (max-width: 1023px)";

function matches(query: string): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches
  );
}

export function isCompactLayout(): boolean {
  return matches(COMPACT_QUERY);
}

/** 手机横屏（电脑布局）；见 {@link PHONE_LANDSCAPE_QUERY}。 */
export function isPhoneLandscape(): boolean {
  return matches(PHONE_LANDSCAPE_QUERY);
}

/**
 * 手机屏幕，不论横竖：竖屏（手机布局）或横屏（电脑布局）。给只看「屏幕小、手指
 * 操作」而不看布局形态的规则用，例如新建节点装不进视口时缩小（#684）。
 */
export function isPhoneScreen(): boolean {
  return isCompactLayout() || isPhoneLandscape();
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
