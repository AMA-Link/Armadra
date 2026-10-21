/* eslint-disable no-control-regex -- 转义序列本来就含控制字符 */
/**
 * 终端输出的 SGR 解析（设计 §3.1）：只认 16 色与 256 色的前景、背景，加粗、
 * 变暗、斜体、下划线；真彩色的参数读掉但不上色；其余控制序列一律丢弃。
 * 不加依赖。
 */

export interface AnsiSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** 16 色：两套主题下都读得清的中等明度。 */
const BASE_16_RGB = [
  0x5c5c5c, 0xd6453d, 0x2f9e5b, 0xb8860b, 0x3b7dd8, 0xb05fc2, 0x1f9fae,
  0xc9c9c9, 0x8a8a8a, 0xef6b63, 0x4cc27a, 0xd9a62b, 0x62a0f2, 0xcf86e0,
  0x45bccb, 0xf2f2f2,
] as const;

const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function css(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

const BASE_16 = BASE_16_RGB.map(css);

/** xterm 256 色：0–15 同 16 色，16–231 是 6×6×6 色立方，232–255 是灰阶。 */
export function ansi256(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return BASE_16[index];
  if (index < 232) {
    const n = index - 16;
    const r = CUBE_STEPS[Math.floor(n / 36)] as number;
    const g = CUBE_STEPS[Math.floor(n / 6) % 6] as number;
    const b = CUBE_STEPS[n % 6] as number;
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  const gray = 8 + (index - 232) * 10;
  return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
}

interface Style {
  fg?: string | undefined;
  bg?: string | undefined;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

const PLAIN: Style = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

function applySgr(style: Style, params: number[]): Style {
  let next = { ...style };
  const list = params.length === 0 ? [0] : params;
  for (let i = 0; i < list.length; i++) {
    const code = list[i] as number;
    if (code === 0) next = { ...PLAIN };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code >= 30 && code <= 37) next.fg = BASE_16[code - 30];
    else if (code >= 90 && code <= 97) next.fg = BASE_16[code - 90 + 8];
    else if (code >= 40 && code <= 47) next.bg = BASE_16[code - 40];
    else if (code >= 100 && code <= 107) next.bg = BASE_16[code - 100 + 8];
    else if (code === 39) next.fg = undefined;
    else if (code === 49) next.bg = undefined;
    else if (code === 38 || code === 48) {
      const mode = list[i + 1];
      if (mode === 5) {
        const color = ansi256(list[i + 2] ?? -1);
        if (code === 38) next.fg = color;
        else next.bg = color;
        i += 2;
      } else if (mode === 2) {
        // 真彩色不上色，只把三个分量读掉。
        i += 4;
      }
    }
  }
  return next;
}

/** 回车覆盖：进度条一类的输出只留每行最后一次写入的内容。 */
function collapseCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      const cut = trimmed.lastIndexOf("\r");
      return cut < 0 ? trimmed : trimmed.slice(cut + 1);
    })
    .join("\n");
}

const ESCAPE =
  /\u001b(?:\[([0-9;:?<=>]*)([ -/]*[@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

export function parseAnsi(input: string): AnsiSpan[] {
  const text = collapseCarriageReturns(input);
  const spans: AnsiSpan[] = [];
  let style: Style = { ...PLAIN };
  let last = 0;
  const push = (chunk: string): void => {
    if (chunk === "") return;
    const span: AnsiSpan = { text: chunk };
    if (style.fg) span.fg = style.fg;
    if (style.bg) span.bg = style.bg;
    if (style.bold) span.bold = true;
    if (style.dim) span.dim = true;
    if (style.italic) span.italic = true;
    if (style.underline) span.underline = true;
    const previous = spans[spans.length - 1];
    if (
      previous !== undefined &&
      previous.fg === span.fg &&
      previous.bg === span.bg &&
      previous.bold === span.bold &&
      previous.dim === span.dim &&
      previous.italic === span.italic &&
      previous.underline === span.underline
    ) {
      previous.text += chunk;
    } else {
      spans.push(span);
    }
  };
  for (const match of text.matchAll(ESCAPE)) {
    push(text.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;
    if (match[2] === "m") {
      const params = (match[1] ?? "")
        .split(/[;:]/)
        .filter((part) => part !== "")
        .map(Number)
        .filter((n) => Number.isFinite(n));
      style = applySgr(style, params);
    }
  }
  push(text.slice(last));
  return spans;
}
