import { layoutText, type TextLayout } from "@armadra/board/dom";

import { fontSize } from "../../whiteboard/palette";
import type { Item } from "../../whiteboard/model";

/**
 * 白板文字的排版（设计 §2.7 / §8 Q6）：屏幕、导出、自适应高度、编辑覆盖层共用
 * 同一个 `layoutText`，度量由 2D 上下文的 `measureText` 给。
 */

export const TEXT_PAD = 4;
export const TEXT_LINE = 1.35;
export const MIN_TEXT_HEIGHT = 24;

const FALLBACK_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';
let family: string | null = null;

/** 应用字体栈（`--font-ui`）；Canvas 吃不了 `var()`，运行时读一次。 */
export function fontFamily(): string {
  if (family) return family;
  if (typeof document === "undefined") return FALLBACK_FAMILY;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-ui")
    .trim();
  family = value || FALLBACK_FAMILY;
  return family;
}

/**
 * 字体晚到（`document.fonts.ready`，以及之后任何一次字体加载完成）后丢掉缓存的
 * 字体栈与排版并通知重绘 / 重排。
 */
export function onFontsReady(callback: () => void): () => void {
  if (typeof document === "undefined" || !document.fonts) return () => {};
  let live = true;
  const refresh = () => {
    if (!live) return;
    family = null;
    layouts = new WeakMap();
    callback();
  };
  void document.fonts.ready.then(refresh);
  document.fonts.addEventListener("loadingdone", refresh);
  return () => {
    live = false;
    document.fonts.removeEventListener("loadingdone", refresh);
  };
}

export const fontOf = (size: number): string => `${size}px ${fontFamily()}`;

type Measure = (text: string, font: string) => number;

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** 没有 2D 上下文的环境（jsdom）按字符数估：只为不崩，不为准。 */
function defaultMeasure(): Measure {
  if (measureCtx === undefined && typeof document !== "undefined") {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  const ctx = measureCtx;
  if (!ctx) return (text, font) => text.length * (fontPx(font) * 0.6);
  return (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

const fontPx = (font: string): number =>
  Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);

let layouts = new WeakMap<
  object,
  { key: string; layout: TextLayout; measure: Measure }
>();

/** 一段文字在宽 `w` 的框里的排版；按（对象、文字、宽、字号）缓存。 */
export function layoutFor(
  owner: object,
  text: string,
  w: number,
  size: number,
  measure: Measure = defaultMeasure(),
): TextLayout {
  const key = `${text}\u0000${Math.round(w)}\u0000${size}`;
  const hit = layouts.get(owner);
  if (hit && hit.key === key && hit.measure === measure) return hit.layout;
  const font = fontOf(size);
  const layout = layoutText(text, w - TEXT_PAD * 2, font, measure, {
    lineHeight: size * TEXT_LINE,
  });
  layouts.set(owner, { key, layout, measure });
  return layout;
}

/** 文字对象应有的高度：内容行数 × 行高 + 上下内边距。 */
export function textHeight(item: Extract<Item, { kind: "text" }>): number {
  const size = fontSize(item.style.size);
  const { lines } = layoutFor({}, item.text || " ", item.w, size);
  return Math.max(
    MIN_TEXT_HEIGHT,
    Math.ceil(lines.length * size * TEXT_LINE) + TEXT_PAD * 2,
  );
}
