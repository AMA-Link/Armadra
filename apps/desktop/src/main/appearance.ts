import { BrowserWindow, nativeTheme } from "electron";

import {
  DEFAULT_APPEARANCE,
  vibrancyFor,
  type WindowAppearance,
  windowAppearance,
} from "../shell-core/window-appearance";

/**
 * `window:appearance`（AMA-Link/Armadra#474）：主题偏好写进
 * `nativeTheme.themeSource`，半透明开关落到每扇窗口的 vibrancy 上。
 *
 * 记住最后一次的值：新开的窗口（`openSourceWindow`、从 Dock 重建的主窗口）
 * 经 `applyToNewWindow` 套上同一套，不必等它的页面再送一次。
 */
let current: WindowAppearance = DEFAULT_APPEARANCE;

export function setWindowAppearance(
  value: unknown,
  platform: string = process.platform,
): { ok: boolean } {
  const appearance = windowAppearance(value);
  if (appearance === null) return { ok: false };
  current = appearance;
  nativeTheme.themeSource = appearance.theme;
  for (const window of BrowserWindow.getAllWindows())
    applyVibrancy(window, platform);
  return { ok: true };
}

/** `onWindowCreated` 的钩子：新窗口按最后一次的半透明开关挂材质。 */
export function applyToNewWindow(
  window: BrowserWindow,
  platform: string = process.platform,
): void {
  applyVibrancy(window, platform);
}

/** 测试用：回到页面还没说话之前。 */
export function resetWindowAppearance(): void {
  current = DEFAULT_APPEARANCE;
}

function applyVibrancy(window: BrowserWindow, platform: string): void {
  if (platform !== "darwin" || window.isDestroyed()) return;
  window.setVibrancy(vibrancyFor(current, platform));
}
