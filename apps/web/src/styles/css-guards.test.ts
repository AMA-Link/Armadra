// @vitest-environment node
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lineOf, posix, readSource } from "../lib/scan-source";

/**
 * CSS 守卫（设计系统 §10）：`src/` 下的样式表只引用 `tokens.css` 里的令牌，
 * 不写死下面这些值：
 *
 *  - 字号、行高的 px；
 *  - padding / margin / gap 里 0、1px、2px 以外的 px；
 *  - 字面颜色（十六进制、`rgb()` / `hsl()` / `oklch()` 等函数式色值，遮罩除外）；
 *  - `transition: all`；
 *  - 非零的字面圆角；
 *  - `ease-in` 缓动（`ease-in-out` 不算）；
 *  - 从 `scale(0)` 起的缩放；
 *  - 超过 300ms 的字面时长（开屏 `--dur-hero` 与循环的 `--dur-loop-*` 是令牌）；
 *  - 带模糊或超过 2px 扩散的字面投影（`var(--shadow-*)`、`none` 与无模糊的
 *    1–2px 细线允许）。
 *
 * 令牌文件（`tokens.css`、`backdrops.css`）就是这些值的出处，不扫。确有必要的
 * 例外在同一条声明里写注释 `design-ok` 并说明原因；现在一处也没有。
 *
 * 按声明而不是按行扫：prettier 会把多值的 `box-shadow` / `transition` 折成多行。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

const TOKEN_FILES = ["styles/tokens.css", "styles/backdrops.css"];

function cssSources(root: string): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return walk(path);
      return name.endsWith(".css") ? [path] : [];
    });
  return walk(root);
}

/** CSS 只有块注释；换成等长空白，行号与偏移不变。 */
function blankCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
}

/** 按顶层逗号拆分（括号里的逗号不算）。 */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim());
}

/** 去掉所有函数调用（含嵌套），只留顶层的词。 */
function stripCalls(value: string): string {
  let out = "";
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0) out += char;
  }
  return out.replace(/[\w-]+(?=\s|$)/g, (word) =>
    /^-?[\d.]/.test(word) ? word : " ",
  );
}

function pxOf(length: string): number {
  const match = /^-?(\d*\.?\d+)(px)?$/.exec(length);
  return match ? Math.abs(Number(match[1])) : Number.NaN;
}

/** 字面投影：每一层要么是 `var(--shadow-*)` / `none`，要么是无模糊、各长度不超过 2px 的细线。 */
function literalShadow(value: string): boolean {
  return splitTopLevel(value, ",").some((layer) => {
    if (layer === "none" || /^var\(--shadow-[\w-]+\)$/.test(layer))
      return false;
    const lengths = stripCalls(layer.replace(/\binset\b/g, ""))
      .split(/\s+/)
      .filter((word) => /^-?[\d.]/.test(word));
    const [, , blur = "0", ...rest] = lengths;
    if (pxOf(blur) !== 0) return true;
    return [...lengths.slice(0, 2), ...rest].some(
      (length) => !(pxOf(length) <= 2),
    );
  });
}

/** 圆角：去掉 `var()` 与零值之后不能再剩下数字。 */
function literalRadius(value: string): boolean {
  let rest = value;
  while (/var\([^()]*\)/.test(rest)) rest = rest.replace(/var\([^()]*\)/g, "");
  return /[1-9]/.test(
    rest.replace(/\b0+(?:\.0+)?(?:px|r?em|%)?(?![\w.])/g, ""),
  );
}

function msOf(time: string): number {
  return time.endsWith("ms")
    ? Number.parseFloat(time)
    : Number.parseFloat(time) * 1000;
}

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;
const COLOR_FN = /\b(?:rgba?|hsla?|oklch|oklab|hwb|lch|lab)\(/;

interface Rule {
  readonly id: string;
  readonly test: (property: string, value: string) => boolean;
}

const RULES: readonly Rule[] = [
  {
    id: "字号或行高写死",
    test: (property, value) =>
      (/(?:^|-)(?:font-size|line-height)$/.test(property) ||
        property === "font") &&
      /\b\d+(?:\.\d+)?px\b/.test(value),
  },
  {
    id: "间距写死（用 --space-*）",
    test: (property, value) =>
      /(?:^|-)(?:padding|margin|gap|column-gap|row-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$/.test(
        property,
      ) &&
      (value.match(/\b\d+(?:\.\d+)?px\b/g) ?? []).some(
        (px) => !["0px", "1px", "2px"].includes(px),
      ),
  },
  {
    id: "字面颜色（用颜色令牌）",
    test: (property, value) =>
      !/(?:^|-)mask(?:-image)?$/.test(property) &&
      (HEX.test(value) || COLOR_FN.test(value)),
  },
  {
    id: "transition: all",
    test: (property, value) =>
      /^transition(?:-property)?$/.test(property) && /\ball\b/.test(value),
  },
  {
    id: "非零字面圆角（用 --r-*）",
    test: (property, value) =>
      /^border(?:-[a-z]+)*-radius$/.test(property) && literalRadius(value),
  },
  {
    id: "ease-in 缓动（用 --ease-out / --ease-in-out）",
    test: (property, value) =>
      /^(?:transition|animation)(?:-timing-function)?$/.test(property) &&
      /\bease-in\b(?!-)/.test(value),
  },
  {
    id: "scale(0) 起步（起点不小于 0.9）",
    test: (property, value) =>
      /\bscale(?:3d|X|Y)?\(\s*0(?:\.0+)?\s*[,)]/.test(value) ||
      (property === "scale" && /^0(?:\.0+)?$/.test(value)),
  },
  {
    id: "字面时长超过 300ms（用 --dur-*）",
    test: (property, value) =>
      /^(?:transition|animation)(?:-duration)?$/.test(property) &&
      (stripCalls(value).match(/(?<![\w.-])\d*\.?\d+m?s(?![\w-])/g) ?? []).some(
        (time) => msOf(time) > 300,
      ),
  },
  {
    id: "字面投影（用 --shadow-*；无模糊的 1–2px 细线除外）",
    test: (property, value) =>
      /^(?:-webkit-)?box-shadow$/.test(property) && literalShadow(value),
  },
];

const DECLARATION =
  /(?<![\w-])(-{0,2}[a-zA-Z][\w-]*)\s*:\s*([^;{}]+?)\s*(?=[;}])/g;

/** 一份样式表里的违规：`行号  规则  声明`。 */
function cssViolations(source: string): string[] {
  const code = blankCssComments(source);
  const rawLines = source.split("\n");
  const out: string[] = [];
  for (const match of code.matchAll(DECLARATION)) {
    const property = match[1]!;
    const value = match[2]!.replace(/\s+/g, " ").replace(/\s*!important$/, "");
    const first = lineOf(code, match.index ?? 0);
    const last = first + (match[0].match(/\n/g)?.length ?? 0);
    if (
      rawLines.slice(first - 1, last).some((line) => line.includes("design-ok"))
    )
      continue;
    for (const rule of RULES)
      if (rule.test(property, value))
        out.push(`${first}  ${rule.id}  ${property}: ${value}`);
  }
  return out;
}

const scanned = cssSources(SRC)
  .map((file) => posix(SRC, file))
  .filter((file) => !TOKEN_FILES.includes(file))
  .sort();

describe("CSS 守卫", () => {
  it("真的扫到了样式表，令牌文件不在里面", () => {
    expect(scanned).toContain("styles/app.css");
    expect(scanned).toContain("styles/nodes.css");
    expect(scanned).toContain("splash/splash.css");
    expect(scanned.length).toBeGreaterThanOrEqual(8);
    for (const file of TOKEN_FILES) expect(scanned).not.toContain(file);
  });

  it.each(scanned)("%s 没有写死的值", (file) => {
    const source = readSource(fileURLToPath(new URL(file, `file://${SRC}`)));
    expect(cssViolations(source)).toEqual([]);
  });

  it("没有 design-ok 例外", () => {
    const exempted = scanned.filter((file) =>
      readSource(fileURLToPath(new URL(file, `file://${SRC}`))).includes(
        "design-ok",
      ),
    );
    expect(exempted).toEqual([]);
  });
});

describe("扫描器真的扫得到违规", () => {
  const hits = (css: string) =>
    cssViolations(css).map((line) => line.split("  ")[1]);

  it("写死的字号、行高与 @theme 里的行高", () => {
    expect(hits("a { font-size: 13px; }")).toHaveLength(1);
    expect(hits("@theme { --text-body--line-height: 19px; }")).toHaveLength(1);
    expect(hits("a { line-height: var(--leading-body); }")).toEqual([]);
    expect(hits("a { --port-size: 14px; }")).toEqual([]);
  });

  it("间距只放过 0 / 1px / 2px", () => {
    expect(
      hits("a { padding: 16px; gap: 3px; margin-left: -8px; }"),
    ).toHaveLength(3);
    expect(
      hits("a { padding: 0 2px; margin: 1px; gap: var(--space-item); }"),
    ).toEqual([]);
    expect(
      hits("a { padding-left: calc(var(--space-section) + 1px); }"),
    ).toEqual([]);
  });

  it("字面颜色，遮罩与令牌不算", () => {
    expect(
      hits("a { color: #fff; background: rgb(var(--tint-rgb) / 8%); }"),
    ).toHaveLength(2);
    expect(
      hits("a { mask-image: linear-gradient(rgb(0 0 0), transparent); }"),
    ).toEqual([]);
    expect(hits("a { color: var(--text); }")).toEqual([]);
  });

  it("transition: all、ease-in、scale(0)", () => {
    expect(hits("a { transition: all var(--dur-fast); }")).toHaveLength(1);
    expect(
      hits("a { transition: opacity var(--dur-fast) ease-in; }"),
    ).toHaveLength(1);
    expect(
      hits("a { transition: opacity var(--dur-fast) ease-in-out; }"),
    ).toEqual([]);
    expect(hits("to { transform: scale(0); }")).toHaveLength(1);
    expect(hits("to { transform: scale(0.96); }")).toEqual([]);
  });

  it("圆角只认令牌与 0", () => {
    expect(hits("a { border-radius: 999px; }")).toHaveLength(1);
    expect(hits("a { border-top-left-radius: 50%; }")).toHaveLength(1);
    expect(
      hits("a { border-radius: calc(var(--r-card) + 4px); }"),
    ).toHaveLength(1);
    expect(
      hits("a { border-radius: 0 var(--r-card) var(--r-card) 0; }"),
    ).toEqual([]);
  });

  it("字面时长超过 300ms，多行声明也算", () => {
    expect(hits("a { animation: spin 0.8s linear infinite; }")).toHaveLength(1);
    expect(
      hits("a {\n  transition:\n    opacity 120ms,\n    transform 400ms;\n}"),
    ).toHaveLength(1);
    expect(
      hits("a { animation: x var(--dur-loop-spin) linear 40ms; }"),
    ).toEqual([]);
    expect(hits("a { animation-duration: 240ms; }")).toEqual([]);
  });

  it("投影：令牌、none 与无模糊的 1–2px 细线放过", () => {
    expect(hits("a { box-shadow: 0 4px 12px rgb(0 0 0 / 20%); }")).toContain(
      "字面投影（用 --shadow-*；无模糊的 1–2px 细线除外）",
    );
    expect(hits("a { box-shadow: 0 0 0 3px var(--ring); }")).toHaveLength(1);
    expect(
      hits(
        "a {\n  box-shadow:\n    0 0 0 2px var(--brand),\n    0 0 18px 2px var(--brand);\n}",
      ),
    ).toHaveLength(1);
    expect(
      hits(
        "a { box-shadow: 0 0 0 1px var(--border-strong), inset 0 1px 0 var(--hover); }",
      ),
    ).toEqual([]);
    expect(hits("a { box-shadow: var(--shadow-overlay); }")).toEqual([]);
    expect(hits("a { box-shadow: none !important; }")).toEqual([]);
  });

  it("同一条声明里写 design-ok 就跳过，行号对得上", () => {
    expect(hits("a { padding: 16px; /* design-ok: 原因 */ }")).toEqual([]);
    expect(cssViolations("a {\n\n  padding: 16px;\n}")[0]).toMatch(/^3 {2}/);
    expect(hits("/* padding: 16px; */")).toEqual([]);
  });
});
