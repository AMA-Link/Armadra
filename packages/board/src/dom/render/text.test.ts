import { describe, expect, it } from "vitest";

import { layoutText } from "./text";

/** 西文字符 10 宽，汉字 20 宽。 */
const measure = (text: string): number =>
  [...text].reduce((sum, ch) => sum + (/[一-鿿，。]/.test(ch) ? 20 : 10), 0);
const font = "20px sans-serif";

describe("layoutText", () => {
  it("西文按单词折行，行尾空白不计入", () => {
    const out = layoutText("aaa bbb ccc", 70, font, measure);
    expect(out.lines).toEqual(["aaa bbb", "ccc"]);
    expect(out.width).toBe(70);
  });

  it("行高缺省取字号 1.4 倍，高度 = 行数 × 行高", () => {
    const out = layoutText("a\nb\nc", 100, font, measure);
    expect(out.lineHeight).toBe(28);
    expect(out.height).toBe(84);
    expect(layoutText("a", 100, font, measure, { lineHeight: 10 }).height).toBe(
      10,
    );
  });

  it("CJK 按字可断，避头标点不落在行首", () => {
    const out = layoutText("你好世界。再见", 100, font, measure);
    expect(out.lines).toEqual(["你好世界。", "再见"]);
    // 宽度只够四个字：「。」跟着「界」一起落到下一行，不单独出现在行首。
    expect(layoutText("你好世界。再见", 80, font, measure).lines).toEqual([
      "你好世",
      "界。再见",
    ]);
  });

  it("超长单词硬断，显式换行与空行保留", () => {
    expect(layoutText("abcdefgh", 30, font, measure).lines).toEqual([
      "abc",
      "def",
      "gh",
    ]);
    expect(layoutText("a\n\nb", 100, font, measure).lines).toEqual([
      "a",
      "",
      "b",
    ]);
  });

  it("空串一行零宽", () => {
    const out = layoutText("", 100, font, measure);
    expect(out.lines).toEqual([""]);
    expect(out.width).toBe(0);
  });
});
