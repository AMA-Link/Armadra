import { create } from "zustand";

import { isCompactLayout, isPhoneLandscape } from "../platform/layout";

const STORAGE_KEY = "armadra.minimapCollapsed";
/**
 * 没存过偏好时，手机默认收起：竖屏展开的缩略图要占掉约三分之一屏；横屏（电脑
 * 布局，#715）高只有 400 上下，展开的缩略图与整排 Dock 挤在同一条底边上。
 */
function defaultCollapsed(): boolean {
  return isCompactLayout() || isPhoneLandscape();
}
function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? defaultCollapsed() : stored === "true";
  } catch {
    return defaultCollapsed();
  }
}

/** Shared by the minimap and shell so the usage orb follows the collapsed edge. */
export const useMinimapPreferences = create<{
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}>((set) => ({
  collapsed: readCollapsed(),
  setCollapsed: (collapsed) => {
    set({ collapsed });
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      /* Optional persistence. */
    }
  },
}));
