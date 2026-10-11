import type { Position } from "@armadra/shared";

import type { Box } from "../../geometry";

/**
 * 连线上那枚关系标签放在哪（纯函数，#318）。
 *
 * 字号按**屏幕**恒定（缩小画布时标签不跟着缩成墨点），所以它在画布坐标里的
 * 大小随缩放变；位置在折线某一段的中点，挑的顺序是：
 *
 *  1. 放得下标签的线段（横段比标签宽、竖段比标签高），长的优先；
 *  2. 其余线段，长的优先；
 *
 * 每段先试中点，再往两头挪。每个候选都要求标签矩形（外扩一点）不压任何
 * 节点（调用方还会把箭头、别的标签、别的线段一并传进来）；正常字号哪儿都放不下时
 * 退到 {@link LABEL_MIN_SCREEN_FONT} 再试一轮（两排节点之间只剩一道窄缝时
 * 常见），还不行就不画——关系仍在悬停提示里，压住终端标题栏的标签比没有更糟。
 */

/** 屏幕上的字号（px）。 */
export const LABEL_SCREEN_FONT = 11;
/** 窄缝里退到的最小屏幕字号（px）。 */
export const LABEL_MIN_SCREEN_FONT = 8;
/** 小于这个缩放就不画标签：那时一屏几十条线，字只会糊成一片。 */
export const LABEL_MIN_ZOOM = 0.3;
/** 一段上依次试的位置（0 与 1 是两端）。 */
const SLIDE = [0.5, 0.35, 0.65, 0.2, 0.8];
/** 标签矩形与节点之间至少留的空（画布单位，按屏幕像素换算前）。 */
const LABEL_GAP = 1;

export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

/**
 * 当前缩放下标签的字号（画布单位）：放大时随画布变大，缩小时保持屏幕可读。
 * 取整：缩放手势每一帧都在变，标签只在字号跨过一个整数时才重新摆。
 */
export function labelFontSize(zoom: number): number {
  const safe = zoom > 0 ? zoom : 1;
  return Math.round(LABEL_SCREEN_FONT / Math.min(safe, 1));
}

/** 文字宽度的估算：CJK 与符号按一个字宽，其余按 0.6。 */
export function textWidth(text: string, fontSize: number): number {
  let ems = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    ems += code >= 0x2e80 ? 1 : char === " " ? 0.3 : 0.6;
  }
  return ems * fontSize;
}

/** 标签外框（含左右内边距）的宽高。 */
export function labelSize(
  text: string,
  fontSize: number,
): { width: number; height: number } {
  return {
    width: textWidth(text, fontSize) + fontSize * 1.2,
    height: fontSize * 1.4,
  };
}

function overlaps(
  cx: number,
  cy: number,
  width: number,
  height: number,
  box: Box,
  gap: number,
): boolean {
  const l = cx - width / 2 - gap;
  const r = cx + width / 2 + gap;
  const t = cy - height / 2 - gap;
  const b = cy + height / 2 + gap;
  return (
    l < box.x + box.width && r > box.x && t < box.y + box.height && b > box.y
  );
}

/**
 * 在折线上给标签找一个不压节点的位置；找不到返回 `null`。
 *
 * `obstacles` 要包括两端自己：标签挂在端点附近时最容易压住的就是它们。
 */
export function placeLabel(
  points: readonly Position[],
  text: string,
  fontSize: number,
  obstacles: readonly Box[],
): LabelBox | null {
  const placed = placeAt(points, text, fontSize, obstacles);
  if (placed) return placed;
  const smaller = (fontSize * LABEL_MIN_SCREEN_FONT) / LABEL_SCREEN_FONT;
  return placeAt(points, text, Math.round(smaller * 10) / 10, obstacles);
}

function placeAt(
  points: readonly Position[],
  text: string,
  fontSize: number,
  obstacles: readonly Box[],
): LabelBox | null {
  if (points.length < 2 || text === "") return null;
  const { width, height } = labelSize(text, fontSize);
  const gap = (LABEL_GAP * fontSize) / LABEL_SCREEN_FONT;
  const segments = [];
  for (let k = 1; k < points.length; k += 1) {
    const a = points[k - 1]!;
    const b = points[k]!;
    const horizontal = a.y === b.y;
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const room = horizontal ? width : height;
    segments.push({ a, b, length, fits: length >= room + gap * 2 });
  }
  segments.sort((p, q) =>
    p.fits === q.fits ? q.length - p.length : p.fits ? -1 : 1,
  );
  // 每段先试中点，再往两头挪：中点被别的线或标签占了时还有地方。
  for (const segment of segments) {
    for (const t of SLIDE) {
      const x = segment.a.x + (segment.b.x - segment.a.x) * t;
      const y = segment.a.y + (segment.b.y - segment.a.y) * t;
      if (obstacles.some((box) => overlaps(x, y, width, height, box, gap))) {
        continue;
      }
      return { x, y, width, height, fontSize };
    }
  }
  return null;
}
