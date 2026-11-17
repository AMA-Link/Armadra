import {
  colorHex,
  DOT_COLORS,
  type ColorScheme,
} from "../../whiteboard/palette";
import { canvasScheme } from "../../whiteboard/scheme";
import { peekImage } from "./images";

/**
 * 引擎绘制环境里的颜色与位图（屏幕与导出共用）：颜色名按画布底色取那一套色值
 * （`scheme.ts`：判据是画布底色，不是应用主题）；点阵色叫 `dot`。
 */
export function boardColor(name: string): string {
  const scheme = canvasScheme();
  if (name === "dot") return canvasDot(scheme);
  return colorHex(name, scheme);
}

/**
 * 点阵色取 `--canvas-dot` 令牌（与旧画布的 `<Background color="var(--canvas-dot)">` 同一个值，
 * 深浅色与「画布背景」偏好都跟着走）。Canvas 吃不了 CSS 变量，所以读出来用；
 * 绘制每帧都要它，而计算样式在平移的每一帧都会逼出一次整页样式重算，所以按
 * 「配色 + 偏好写在根元素上的行内值」缓存，两者变了才重读。
 */
let dotCache: { key: string; value: string } | null = null;
function canvasDot(scheme: ColorScheme): string {
  if (typeof document === "undefined") return DOT_COLORS[scheme];
  const root = document.documentElement;
  const key = `${scheme}|${root.style.getPropertyValue("--canvas-dot")}`;
  if (dotCache?.key === key) return dotCache.value;
  const token = getComputedStyle(root).getPropertyValue("--canvas-dot").trim();
  dotCache = { key, value: token || DOT_COLORS[scheme] };
  return dotCache.value;
}

export const boardImage = (key: string) => peekImage(key);
