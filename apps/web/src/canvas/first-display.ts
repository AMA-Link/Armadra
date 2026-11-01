import { GOLDEN_RATIO, scaleGoldenSize, type Size } from "@armadra/shared";

import { clampZoom } from "./zoom";

/**
 * 新建节点第一次出现在屏幕上的大小（#684）。只有数学，没有 React。
 *
 * 两条规则，手动新建、Agent 新建与「导出到画布」共用：
 *
 *  1. **占比**：节点在视口里占「主方向」的 1/φ ≈ 61.8%（宽比与高比里更紧的那
 *     一个），居中。桌面、手机竖屏、手机横屏同一条规则。
 *  2. **字号下限**：屏幕上的实际字号（字号 × 缩放）不低于 `--text-meta`
 *     （12px）。字号档本身不动，达不到时抬缩放；手机上抬完缩放装不下，就把
 *     新节点的尺寸按黄金比例缩小到装得下（{@link fitNewNodeSize}）。
 *
 * 已保存的节点从不被这里改写：尺寸只在新建那一刻定。
 */

/** `--text-meta`：屏幕上文字不许小于它（`styles/tokens.css`，`first-display.test.ts` 校对）。 */
export const FONT_FLOOR_PX = 12;

/**
 * 节点里最小的正文字号 = `--text-code` = `--text-meta`，也是终端的默认字号。
 * 徽标一类的 `--text-caption`（11px）是壳上的装饰，不参与下限。
 */
export const NODE_TEXT_PX = 12;

/** 占主方向的比例：1/φ。 */
export const FIRST_DISPLAY_FRACTION = 1 / GOLDEN_RATIO;

/** 手机上新建的节点四周至少留出的边（屏幕像素）。 */
export const PHONE_NODE_MARGIN = 24;

/** 字号下限对应的最小缩放：字号 × 缩放 ≥ {@link FONT_FLOOR_PX}。 */
export function fontFloorZoom(fontPx: number = NODE_TEXT_PX): number {
  const font = Number.isFinite(fontPx) && fontPx > 0 ? fontPx : NODE_TEXT_PX;
  return clampZoom(FONT_FLOOR_PX / font);
}

/** 让节点占主方向 1/φ 的缩放（还没夹进字号下限）。 */
export function fractionZoom(
  node: Size,
  container: { width: number; height: number },
): number {
  if (node.width <= 0 || node.height <= 0) return 0;
  if (container.width <= 0 || container.height <= 0) return 0;
  const fit = Math.min(
    container.width / node.width,
    container.height / node.height,
  );
  return fit * FIRST_DISPLAY_FRACTION;
}

/** 首次显示的缩放：占比缩放，但不低于字号下限。 */
export function firstDisplayZoom(input: {
  node: Size;
  container: { width: number; height: number };
  fontPx?: number;
}): number {
  const floor = fontFloorZoom(input.fontPx);
  return clampZoom(Math.max(floor, fractionZoom(input.node, input.container)));
}

/**
 * 手机（紧凑布局，横竖屏）上新建的节点装不进视口时的尺寸。
 *
 * 在字号下限给出的缩放下，节点既要不超过视口的 1/φ，也不能小于该种类的最小
 * 尺寸，更不能超出视口（留 {@link PHONE_NODE_MARGIN}）——三者冲突时以「不超出
 * 视口」为准。结果仍是黄金比例（等比缩放后重新取整）。装得下就原样返回。
 */
export function fitNewNodeSize(input: {
  size: Size;
  min: Size;
  container: { width: number; height: number };
  fontPx?: number;
}): Size {
  const { size, min, container } = input;
  if (container.width <= 0 || container.height <= 0) return size;
  if (size.width <= 0 || size.height <= 0) return size;
  const zoom = fontFloorZoom(input.fontPx);
  const target = Math.min(
    (container.width * FIRST_DISPLAY_FRACTION) / zoom / size.width,
    (container.height * FIRST_DISPLAY_FRACTION) / zoom / size.height,
  );
  const floor = Math.max(min.width / size.width, min.height / size.height);
  const cap = Math.min(
    (container.width - PHONE_NODE_MARGIN * 2) / zoom / size.width,
    (container.height - PHONE_NODE_MARGIN * 2) / zoom / size.height,
  );
  const scale = Math.min(1, cap, Math.max(target, floor));
  if (!(scale > 0) || scale >= 1) return size;
  return scaleGoldenSize(size, scale);
}
