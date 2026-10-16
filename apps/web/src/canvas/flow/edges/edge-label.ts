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

/** 一条线上的一段（别的线的线段，标签要躲开）。 */
export interface Stroke {
  /** 属于哪条边、第几段：宿主那一段不算。 */
  edge: string;
  k: number;
  /** 同一束（共用主干的派发线）里共线的段不算，它们就是宿主那条线。 */
  bundle: string;
  horizontal: boolean;
  /** 段所在的线（横段是 y，竖段是 x）。 */
  at: number;
  box: Box;
}

/** 一条候选折线：标签可以放在它的某一段上。 */
export interface LabelLine {
  edge: string;
  bundle: string;
  points: readonly Position[];
  /** 每个内部顶点的切入距离（曲线占掉的那一截不能放标签）。 */
  cuts?: readonly { before: number; after: number }[] | undefined;
}

export interface LabelPlacement extends LabelBox {
  /** 放在了哪条线上。 */
  edge: string;
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
  cuts?: LabelLine["cuts"],
): LabelBox | null {
  const placed = placeLabelOn(
    [{ edge: "", bundle: "", points, cuts }],
    text,
    fontSize,
    obstacles,
    [],
  );
  if (!placed) return null;
  const { edge: _edge, ...box } = placed;
  return box;
}

/**
 * 一组线（同一个主派出去的派发线）只摆**一枚**标签：在所有候选线的所有段
 * 里找一个位置，要求标签不压节点 / 箭头 / 别的标签（`obstacles`），也不被任何
 * 线穿过（`strokes`；宿主那一段与同束里与它共线的段除外）。
 *
 * 排序：放得下的段优先；其次是被多条线共用的段（主干）；再次是长的段。
 */
export function placeLabelOn(
  lines: readonly LabelLine[],
  text: string,
  fontSize: number,
  obstacles: readonly Box[],
  strokes: readonly Stroke[],
): LabelPlacement | null {
  const placed = placeAt(lines, text, fontSize, obstacles, strokes);
  if (placed) return placed;
  const smaller = (fontSize * LABEL_MIN_SCREEN_FONT) / LABEL_SCREEN_FONT;
  return placeAt(
    lines,
    text,
    Math.round(smaller * 10) / 10,
    obstacles,
    strokes,
  );
}

/** 横竖线段 `a→b` 与另一条共线的段（同束、同轴、同一条线）是否有重叠。 */
function shares(
  horizontal: boolean,
  at: number,
  lo: number,
  hi: number,
  other: Stroke,
): boolean {
  if (other.horizontal !== horizontal || Math.abs(other.at - at) > 1.5) {
    return false;
  }
  const oLo = horizontal ? other.box.x : other.box.y;
  const oHi = oLo + (horizontal ? other.box.width : other.box.height);
  return oLo < hi && oHi > lo;
}

function placeAt(
  lines: readonly LabelLine[],
  text: string,
  fontSize: number,
  obstacles: readonly Box[],
  strokes: readonly Stroke[],
): LabelPlacement | null {
  if (text === "") return null;
  const { width, height } = labelSize(text, fontSize);
  const gap = (LABEL_GAP * fontSize) / LABEL_SCREEN_FONT;
  interface Candidate {
    line: LabelLine;
    k: number;
    a: Position;
    b: Position;
    horizontal: boolean;
    at: number;
    /** 可放标签中心的区间（沿段的坐标）。 */
    from: number;
    to: number;
    length: number;
    fits: boolean;
    shared: number;
  }
  const candidates: Candidate[] = [];
  for (const line of lines) {
    const { points, cuts } = line;
    if (points.length < 2) continue;
    for (let k = 1; k < points.length; k += 1) {
      const a = points[k - 1]!;
      const b = points[k]!;
      const horizontal = a.y === b.y;
      const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
      const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
      const length = hi - lo;
      // 曲线占掉两头各一截；拐点按段的方向挨着 lo / hi 排。
      const forward = (horizontal ? b.x - a.x : b.y - a.y) > 0;
      const cutA = k >= 2 ? (cuts?.[k - 2]?.after ?? 0) : 0;
      const cutB = k <= points.length - 2 ? (cuts?.[k - 1]?.before ?? 0) : 0;
      const loCut = forward ? cutA : cutB;
      const hiCut = forward ? cutB : cutA;
      const half = (horizontal ? width : height) / 2;
      const from = lo + loCut + half + gap;
      const to = hi - hiCut - half - gap;
      const at = horizontal ? a.y : a.x;
      // 被共用的程度：别的线（同束）里与这一段共线重叠的段数。
      let shared = 0;
      for (const other of lines.length > 1 ? strokes : []) {
        if (
          other.bundle === line.bundle &&
          other.edge !== line.edge &&
          shares(horizontal, at, lo, hi, other)
        ) {
          shared += 1;
        }
      }
      candidates.push({
        line,
        k,
        a,
        b,
        horizontal,
        at,
        from,
        to,
        length,
        fits: to >= from,
        shared,
      });
    }
  }
  candidates.sort(
    (p, q) =>
      Number(q.fits) - Number(p.fits) ||
      q.shared - p.shared ||
      q.length - p.length,
  );
  for (const c of candidates) {
    // 放得下的段在可用区间里滑；放不下的只试中点（多半被拒，除非线很孤立）。
    const spots = c.fits
      ? SLIDE.map((t) => c.from + (c.to - c.from) * t)
      : [(c.horizontal ? c.a.x + c.b.x : c.a.y + c.b.y) / 2];
    for (const along of spots) {
      const x = c.horizontal ? along : c.at;
      const y = c.horizontal ? c.at : along;
      if (obstacles.some((box) => overlaps(x, y, width, height, box, gap))) {
        continue;
      }
      const lo = (c.horizontal ? x : y) - (c.horizontal ? width : height) / 2;
      const hi = lo + (c.horizontal ? width : height);
      const crossed = strokes.some((stroke) => {
        if (stroke.edge === c.line.edge && stroke.k === c.k) return false;
        if (
          stroke.bundle === c.line.bundle &&
          shares(c.horizontal, c.at, lo, hi, stroke)
        ) {
          return false;
        }
        return overlaps(x, y, width, height, stroke.box, 0);
      });
      if (crossed) continue;
      return { x, y, width, height, fontSize, edge: c.line.edge };
    }
  }
  return null;
}
