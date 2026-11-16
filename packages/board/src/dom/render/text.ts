// 文字排版：折行与高度同一个函数，显示、导出、自适应高度共用。
// 度量函数由调用方注入（`ctx.measureText` 或测试里的假实现）。

export interface TextLayout {
  lines: string[];
  lineHeight: number;
  /** 行数 × 行高。 */
  height: number;
  /** 最宽一行的宽度。 */
  width: number;
}

export type MeasureText = (text: string, font: string) => number;

/** 不能出现在行首的标点（避头）。 */
const NO_LINE_START = /^[，。、；：！？）】」』》〉”’,.;:!?)\]}%]/;
/** 汉字、假名、谚文等：每个字都可以断。 */
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/;

/** 拆成可断单元：西文单词连着后面的空白，CJK 每字一个，避头标点并进前一个。 */
function segments(paragraph: string): string[] {
  const out: string[] = [];
  for (const match of paragraph.matchAll(/\s+|[^\s⺀-鿿가-힯豈-﫿＀-￯]+|./gsu)) {
    const piece = match[0];
    const last = out.length - 1;
    if (/^\s+$/.test(piece) && last >= 0) out[last] += piece;
    else if (last >= 0 && NO_LINE_START.test(piece)) out[last] += piece;
    else out.push(piece);
  }
  return out;
}

function fontSizeOf(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match ? Number(match[1]) : 16;
}

export function layoutText(
  text: string,
  width: number,
  font: string,
  measure: MeasureText,
  options: { lineHeight?: number } = {},
): TextLayout {
  const lineHeight = options.lineHeight ?? Math.round(fontSizeOf(font) * 1.4);
  const lines: string[] = [];
  const limit = Math.max(width, 1);
  for (const paragraph of text.split("\n")) {
    let line = "";
    const push = (): void => {
      lines.push(line.trimEnd());
      line = "";
    };
    for (const segment of segments(paragraph)) {
      if (line !== "" && measure((line + segment).trimEnd(), font) > limit) {
        push();
      }
      if (measure(segment.trimEnd(), font) <= limit || CJK.test(segment)) {
        line += line === "" ? segment.trimStart() : segment;
        continue;
      }
      // 单个超长单词：逐字符硬断。
      for (const char of segment) {
        if (line !== "" && measure(line + char, font) > limit) push();
        line += char;
      }
    }
    push();
  }
  return {
    lines,
    lineHeight,
    height: lines.length * lineHeight,
    width: Math.max(0, ...lines.map((line) => measure(line, font))),
  };
}
