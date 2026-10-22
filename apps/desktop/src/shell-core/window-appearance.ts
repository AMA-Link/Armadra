/**
 * 窗口外观（`window:appearance`，AMA-Link/Armadra#474）收什么。
 *
 * 页面把主题偏好与「半透明窗口」开关交给壳：主题写进 `nativeTheme.themeSource`，
 * 侧栏底下的系统材质才跟着应用主题走，而不是跟着系统；半透明决定 macOS 窗口
 * 挂不挂 vibrancy。送的是偏好（`system` 也照送），不是解析后的明暗——
 * `themeSource` 本身会改页面里 `prefers-color-scheme` 的答案，送解析值就再也
 * 跟不回系统了。认不出的一律 `null`，壳什么都不改。
 */

export type ThemeSource = "system" | "light" | "dark";

export interface WindowAppearance {
  readonly theme: ThemeSource;
  readonly translucent: boolean;
}

const THEMES: readonly ThemeSource[] = ["system", "light", "dark"];

/** 页面还没说话之前：跟随系统、半透明（与改动之前的窗口一致）。 */
export const DEFAULT_APPEARANCE: WindowAppearance = {
  theme: "system",
  translucent: true,
};

/** PURE. 页面交来的 `{ theme, translucent }`；不像样的答 `null`。 */
export function windowAppearance(value: unknown): WindowAppearance | null {
  if (typeof value !== "object" || value === null) return null;
  const { theme, translucent } = value as {
    theme?: unknown;
    translucent?: unknown;
  };
  if (!THEMES.includes(theme as ThemeSource)) return null;
  if (typeof translucent !== "boolean") return null;
  return { theme: theme as ThemeSource, translucent };
}

/** PURE. 这个平台的窗口该挂哪种材质；只有 macOS 有 vibrancy。 */
export function vibrancyFor(
  appearance: WindowAppearance,
  platform: string,
): "sidebar" | null {
  return platform === "darwin" && appearance.translucent ? "sidebar" : null;
}
