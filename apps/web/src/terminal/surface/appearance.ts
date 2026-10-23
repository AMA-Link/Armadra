import type { ITerminalOptions } from "@xterm/xterm";

import type { TerminalPreferences } from "@/app/preferences-store";

/** 偏好 → xterm 的外观 options（§18.3 设置项行）。 */
export function terminalAppearance(
  preferences: TerminalPreferences,
  element: HTMLElement,
): ITerminalOptions {
  return {
    fontFamily: preferences.fontFamily.trim() || terminalFontFamily(element),
    fontSize: preferences.fontSize,
    lineHeight: preferences.lineHeight,
    letterSpacing: preferences.letterSpacing,
    cursorStyle: preferences.cursorStyle,
    cursorBlink: preferences.cursorBlink,
    macOptionIsMeta: preferences.macOptionIsMeta,
    theme: terminalTheme(element),
  };
}

/* -------------------------------- 主题读取 -------------------------------- */

function cssValue(
  element: HTMLElement,
  name: string,
  fallback: string,
): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
}

function terminalFontFamily(element: HTMLElement): string {
  return cssValue(
    element,
    "--font-code",
    "ui-monospace, Menlo, Consolas, monospace",
  );
}

/**
 * 终端偏好 → `data-term-scheme` 属性值。「始终深色」时终端容器与终端节点外框
 * 带 `dark`，CSS 在这棵子树上把深色那一套令牌重新声明回来（`styles/tokens.css`），
 * `terminalTheme` 读容器的计算样式自然拿到深色值；跟随主题时不写属性。
 */
export function terminalSchemeAttribute(
  scheme: TerminalPreferences["colorScheme"],
): "dark" | undefined {
  return scheme === "dark" ? "dark" : undefined;
}

/**
 * 应用的深浅色主题（`<html data-theme>`）变化时，调用 `apply` 重设 xterm 的
 * `options.theme`。只换调色板，不重建实例（否则整屏内容会没）。返回解除函数。
 *
 * 终端偏好里的「配色」不走这里：它是偏好依赖，经 `terminalAppearance` 重设。
 */
export function watchAppTheme(apply: () => void): () => void {
  const watcher = new MutationObserver(apply);
  watcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => watcher.disconnect();
}

/**
 * 整张调色板都从 token 取（§4.3 规则一：功能代码里不出现字面色值）。
 *
 * `--term-*` 在 `tokens.css` 里按主题各一套（#501）：深色主题用深色那套，浅色
 * 主题整组覆盖成浅底调色板；终端偏好选了「始终深色」时，容器的祖先带
 * `data-term-scheme="dark"`，读到的仍是深色那套。所以这里必须读**容器**的
 * 计算样式，而不是 `<html>` 的。
 * 兜底值只在 `getComputedStyle` 拿不到时用（jsdom、样式表还没加载）。
 */
export function terminalTheme(element: HTMLElement) {
  const token = (name: string, fallback: string) =>
    cssValue(element, name, fallback);
  const background = token("--term-bg", "#0a0a0a");
  return {
    background,
    foreground: token("--term-fg", "#e6e6e6"),
    cursor: token("--brand", "#0a84ff"),
    cursorAccent: background,
    selectionBackground: token("--term-selection", "#3a5a8c66"),
    black: token("--term-ansi-black", "#151515"),
    red: token("--term-ansi-red", "#ff453a"),
    green: token("--term-ansi-green", "#32d74b"),
    yellow: token("--term-ansi-yellow", "#ffd60a"),
    blue: token("--term-ansi-blue", "#0a84ff"),
    magenta: token("--term-ansi-magenta", "#bf5af2"),
    cyan: token("--term-ansi-cyan", "#6ac4dc"),
    white: token("--term-ansi-white", "#e6e6e6"),
    brightBlack: token("--term-ansi-bright-black", "#6b6b6b"),
    brightRed: token("--term-ansi-bright-red", "#ff6f66"),
    brightGreen: token("--term-ansi-bright-green", "#5ee07a"),
    brightYellow: token("--term-ansi-bright-yellow", "#ffe45e"),
    brightBlue: token("--term-ansi-bright-blue", "#4fa3ff"),
    brightMagenta: token("--term-ansi-bright-magenta", "#d18bf7"),
    brightCyan: token("--term-ansi-bright-cyan", "#8fd8e8"),
    brightWhite: token("--term-ansi-bright-white", "#ffffff"),
  };
}
