import { describe, expect, it } from "vitest";

import {
  normalize,
  parseQuery,
  pinyinInitials,
  prepare,
  scoreFields,
  scoreTerm,
  scoreText,
} from "./match";

describe("normalize", () => {
  it("小写、全半角归一、空白压成一个空格", () => {
    expect(normalize("  MacBook\tPro  ")).toBe("macbook pro");
    expect(normalize("ＡＢＣ１２")).toBe("abc12");
  });
});

describe("pinyinInitials", () => {
  it.each([
    ["画布", "hb"],
    ["默认", "mr"],
    ["节点", "jd"],
    ["工作空间", "gzkj"],
    ["白板内容", "bbnr"],
    ["画布 4", "hb4"],
    ["Agent 1", "agent1"],
    ["浏览器", "llq"],
    ["MacBookPro.local", "macbookprolocal"],
    ["AI 画布", "aihb"],
  ])("%s → %s", (text, expected) => {
    expect(pinyinInitials(text)).toBe(expected);
  });
});

describe("parseQuery", () => {
  it("按空白切词、归一化、去重", () => {
    expect(parseQuery("  Mac  mac 画布 ")).toEqual(["mac", "画布"]);
    expect(parseQuery("   ")).toEqual([]);
  });
});

describe("scoreTerm 的档位", () => {
  const score = (term: string, text: string) => scoreTerm(term, prepare(text));

  it("全等 > 前缀 > 词首 > 子串 > 拼音首字母 > 模糊 > 不命中", () => {
    const exact = score("画布", "画布");
    const prefix = score("画布", "画布 4");
    const wordStart = score("local", "macbookpro local");
    const inner = score("book", "macbookpro");
    const initials = score("hb", "产品画布");
    const fuzzy = score("mbp", "macbookpro.local");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(initials);
    expect(initials).toBeGreaterThan(fuzzy);
    expect(fuzzy).toBeGreaterThan(0);
    expect(score("xyz", "macbookpro")).toBe(0);
  });

  it("拼音首字母：hb 找得到画布，找不到不相干的", () => {
    expect(score("hb", "画布 3")).toBeGreaterThan(0);
    expect(score("hb", "终端")).toBe(0);
    expect(score("mr", "默认")).toBeGreaterThan(0);
  });

  it("拼音首字母至少两个字母，且不比对长正文", () => {
    expect(score("h", "画布")).toBe(0);
    const long =
      "拼音检索要支持首字母，比如用两个字母找到对应的内容并且继续往下写很长很长很长很长很长很长很长很长很长";
    expect(score("sy", long)).toBe(0);
  });

  it("子序列要求紧凑：两个字母散在一整段里不算", () => {
    expect(score("ab", "a".padEnd(30, "x") + "b")).toBe(0);
    expect(score("mbp", "macbookpro")).toBeGreaterThan(0);
  });
});

describe("scoreFields", () => {
  it("每个词都要命中，任何一个词落空就整体不命中", () => {
    const title = prepare("首页改版");
    expect(scoreFields(["首页", "改版"], title).score).toBeGreaterThan(0);
    expect(scoreFields(["首页", "组件"], title).score).toBe(0);
  });

  it("词可以分别命中标题与次要字段，标记 viaSecondary", () => {
    const hit = scoreFields(["待办", "导出"], prepare("待办"), [
      prepare("先修好保存队列，再看导出"),
    ]);
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.viaSecondary).toBe(true);
  });

  it("次要字段的权重低于标题", () => {
    const viaTitle = scoreFields(["tmux"], prepare("tmux 实验")).score;
    const viaBody = scoreFields(["tmux"], prepare("实验"), [
      prepare("tmux 降级"),
    ]).score;
    expect(viaTitle).toBeGreaterThan(viaBody);
  });

  it("次要字段不比对拼音首字母", () => {
    expect(scoreFields(["hb"], prepare("x"), [prepare("画布")]).score).toBe(0);
    expect(scoreFields(["hb"], prepare("画布")).score).toBeGreaterThan(0);
  });

  it("空词表命中一切", () => {
    expect(scoreFields([], prepare("x")).score).toBeGreaterThan(0);
    expect(scoreText(parseQuery(""), "x")).toBeGreaterThan(0);
  });
});
