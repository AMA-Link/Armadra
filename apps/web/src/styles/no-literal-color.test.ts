// @vitest-environment node
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  blankComments,
  featureSources,
  lineOf,
  posix,
  readSource,
} from "../lib/scan-source";

/**
 * 颜色只从 `tokens.css` 取（设计系统 §1、§2）：功能代码里不写死色值，也不写
 * `dark:` 分支——主题切换靠 token 换值，不靠每处各写一遍。
 *
 *  - 字面十六进制色与 `rgb()` / `hsl()` / `oklch()` 等函数式色值；
 *  - Tailwind 的 `dark:` 变体（`ui/` 是生成文件，不扫）。
 *
 * 只放过「颜色数据」与计算用途（`DATA_FILES` 等）：用户可选的底色、品牌色回退值、
 *   导出图底色、提交图泳道色、showcase / 样例数据。存量登记表已在批次 3 清空，
 *   其余位置新增字面色直接失败。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

const DATA_FILES = [
  "canvas/whiteboard/palette.ts",
  "terminal/surface/appearance.ts",
  "lib/contrast.ts",
  // 用户可选的画板底色（纯黑 / 纯白 / 纸张 / 石板）
  "app/use-canvas-preferences.ts",
  // 导出图的底色（贴进别的文档，不跟主题走）
  "canvas/content-links.ts",
  // 便签与 Agent 的品牌色回退值（节点颜色数据）
  "nodes/registry.ts",
  "agent/launch.ts",
  // 提交图的泳道色环
  "panels/git/CommitGraph.tsx",
  "panels/git/log/graph.ts",
];
const DATA_PREFIXES = ["showcase/", "canvas/test-support/"];
const DATA_SUFFIXES = [".fixture.ts", ".fixture.tsx", "fixtures.ts"];

/**
 * 另外扫的 CSS（设计系统 §10）：动效文件一个字面色也不许有；开屏样式的存量在
 * 动效与开屏包里改读根令牌后归零。登记个数，只减不增。
 */
const CSS_SOURCES: Readonly<Record<string, number>> = {
  "styles/motion.css": 0,
  "splash/splash.css": 0,
};

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const COLOR_FN = /\b(?:rgba?|hsla?|oklch|oklab|hwb|lch|lab)\(/g;
const DARK_VARIANT = /\bdark:(?=[A-Za-z[!*-])/g;

interface ColorHits {
  readonly literals: number;
  readonly dark: number;
  readonly lines: number[];
}

function colorHits(source: string): ColorHits {
  const code = blankComments(source);
  const literals = [...code.matchAll(HEX), ...code.matchAll(COLOR_FN)];
  const dark = [...code.matchAll(DARK_VARIANT)];
  return {
    literals: literals.length,
    dark: dark.length,
    lines: [...literals, ...dark]
      .map((match) => lineOf(code, match.index ?? 0))
      .sort((a, b) => a - b),
  };
}

function isData(file: string): boolean {
  return (
    DATA_FILES.includes(file) ||
    DATA_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    DATA_SUFFIXES.some((suffix) => file.endsWith(suffix))
  );
}

let cache: Map<string, ColorHits> | undefined;

/** 扫整个 src/ 要读几百个文件，只扫一次。 */
function scanned(): Map<string, ColorHits> {
  cache ??= new Map(
    featureSources(SRC).map((file) => [
      posix(SRC, file),
      colorHits(readSource(file)),
    ]),
  );
  return cache;
}

describe("字面色值与 dark: 守卫", () => {
  it("真的扫到了功能代码，而不是空跑", () => {
    const files = [...scanned().keys()];
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("canvas/whiteboard/palette.ts");
    expect(files.some((file) => file.startsWith("ui/"))).toBe(false);
  });

  it("功能代码里没有 dark: 变体", () => {
    const offenders = [...scanned()]
      .filter(([, hits]) => hits.dark > 0)
      .map(([file, hits]) => `${file} ×${hits.dark}`);
    expect(offenders).toEqual([]);
  });

  it("字面色值只出现在数据文件里", () => {
    const offenders = [...scanned()].flatMap(([file, hits]) => {
      if (isData(file) || hits.literals === 0) return [];
      return [`${file}: ${hits.literals} 处`];
    });
    expect(offenders).toEqual([]);
  });
});

describe("CSS 里的字面色值", () => {
  it.each(Object.entries(CSS_SOURCES))(
    "%s 的字面色值个数等于登记（%d）",
    (file, budget) => {
      const css = blankComments(
        readSource(fileURLToPath(new URL(file, `file://${SRC}`))),
      );
      const hits = [...css.matchAll(HEX), ...css.matchAll(COLOR_FN)];
      expect(hits.length).toBe(budget);
    },
  );
});

describe("扫描器真的扫得到违规", () => {
  it("抓得到十六进制与函数式色值，各种长度都算", () => {
    expect(
      colorHits('const a = "#fff"; const b = "#1a2b3c"; const c = "#11223344";')
        .literals,
    ).toBe(3);
    expect(
      colorHits(
        'x = "rgb(0 0 0)"; y = `hsl(${h} 50% 50%)`; z = "oklch(0.5 0.1 20)";',
      ).literals,
    ).toBe(3);
  });

  it("抓得到 Tailwind 的 dark: 变体，对象里的 dark: 键不算", () => {
    expect(
      colorHits('className="bg-card dark:bg-black dark:hover:bg-x"').dark,
    ).toBe(2);
    expect(colorHits('const scheme = { dark: "x" };').dark).toBe(0);
  });

  it("注释里的例子与 CSS 变量不算", () => {
    expect(colorHits("// 比如 #ff0000\n/* rgb(1 2 3) */").literals).toBe(0);
    expect(colorHits('color: "var(--brand)"; id="#root"').literals).toBe(0);
  });

  it("命中行号对得上", () => {
    expect(colorHits('a\n\nconst c = "#abcdef";').lines).toEqual([3]);
  });
});
