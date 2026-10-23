// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CONTRAST_THRESHOLD, contrastOver } from "@/lib/contrast";

/**
 * 终端调色板守卫（Issue #501）：
 *  - 浅色主题整组覆盖 `--term-*`，每个前景色（默认前景 + ANSI 十六色）对终端底
 *    ≥ 4.5:1，光标对底 ≥ 3:1，选区看得出来；
 *  - 深色值只写一处：`:root` 与 `[data-term-scheme="dark"]` 共用一个选择器列表，
 *    「始终深色」的子树在浅色主题里拿到的就是同一份。
 */

const css = readFileSync(
  fileURLToPath(new URL("./tokens.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`未找到选择器：${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`规则体没有闭合：${selector}`);
}

function termTokens(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of body.matchAll(/(--term-[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.trim());
  }
  return out;
}

const dark = termTokens(ruleBody(":root {"));
const lightBody = ruleBody(':root[data-theme="light"]');
const light = termTokens(lightBody);

const FOREGROUNDS = [
  "--term-fg",
  "--term-ansi-black",
  "--term-ansi-red",
  "--term-ansi-green",
  "--term-ansi-yellow",
  "--term-ansi-blue",
  "--term-ansi-magenta",
  "--term-ansi-cyan",
  "--term-ansi-white",
  "--term-ansi-bright-black",
  "--term-ansi-bright-red",
  "--term-ansi-bright-green",
  "--term-ansi-bright-yellow",
  "--term-ansi-bright-blue",
  "--term-ansi-bright-magenta",
  "--term-ansi-bright-cyan",
  "--term-ansi-bright-white",
] as const;

describe("终端调色板：浅色（#501）", () => {
  it("浅色主题块覆盖深色那一组的每一个 --term-*，一个不漏", () => {
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
    expect(dark.size).toBe(FOREGROUNDS.length + 2);
  });

  it("浅色与深色的底不同，且浅色底是浅色", () => {
    expect(light.get("--term-bg")).toBe("#fafafa");
    expect(light.get("--term-bg")).not.toBe(dark.get("--term-bg"));
  });

  it.each(FOREGROUNDS)("%s 对终端底 ≥ 4.5:1", (name) => {
    const value = light.get(name)!;
    expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    const ratio = contrastOver(value, light.get("--term-bg")!);
    expect(
      ratio,
      `${name} ${value} → ${ratio.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(CONTRAST_THRESHOLD.text);
  });

  it("光标（品牌蓝）对终端底 ≥ 3:1", () => {
    const brand = /--brand\s*:\s*(#[0-9a-f]{6})/i.exec(lightBody)![1]!;
    expect(contrastOver(brand, light.get("--term-bg")!)).toBeGreaterThanOrEqual(
      CONTRAST_THRESHOLD.graphic,
    );
  });

  it("选区是品牌蓝约 20% 透明，叠上去之后默认前景仍 ≥ 4.5:1", () => {
    const selection = light.get("--term-selection")!;
    expect(selection).toMatch(/^#[0-9a-f]{6}[0-9a-f]{2}$/i);
    const rgb = selection.slice(0, 7);
    const alpha = Number.parseInt(selection.slice(7), 16) / 255;
    expect(alpha).toBeGreaterThan(0.15);
    expect(alpha).toBeLessThan(0.3);
    const brand = /--brand\s*:\s*(#[0-9a-f]{6})/i.exec(lightBody)![1]!;
    expect(rgb.toLowerCase()).toBe(brand.toLowerCase());
    const background = Number.parseInt(light.get("--term-bg")!.slice(1), 16);
    const tint = Number.parseInt(rgb.slice(1), 16);
    const blended = [16, 8, 0]
      .map((shift) => {
        const base = (background >> shift) & 255;
        const over = (tint >> shift) & 255;
        return Math.round(over * alpha + base * (1 - alpha));
      })
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("");
    expect(
      contrastOver(light.get("--term-fg")!, `#${blended}`),
    ).toBeGreaterThanOrEqual(CONTRAST_THRESHOLD.text);
    // 选区本身要看得出来：和底之间有可辨的亮度差
    expect(
      contrastOver(`#${blended}`, light.get("--term-bg")!),
    ).toBeGreaterThan(1.2);
  });
});

describe("终端调色板：始终深色（#501）", () => {
  it("深色值只写一处：:root 与 [data-term-scheme=dark] 共用一个选择器列表", () => {
    expect(css).toMatch(
      /\[data-term-scheme="dark"\]\s*,\s*:root\s*\{[\s\S]*?color-scheme:\s*dark/,
    );
    // 整个文件里 `--term-bg` 只有深色一处、浅色一处声明
    expect(css.match(/--term-bg\s*:/g)).toHaveLength(2);
  });

  it("文档级声明（color / background / font-family）不在共享选择器里，不会落到节点外框上", () => {
    const sharedBody = ruleBody(":root {");
    expect(sharedBody).not.toMatch(/^\s*background\s*:/m);
    expect(sharedBody).not.toMatch(/^\s*font-family\s*:/m);
    expect(css).toMatch(
      /\n:root\s*\{\s*color:\s*var\(--text\);\s*background:\s*var\(--bg\);\s*font-family:\s*var\(--font-ui\);\s*\}/,
    );
  });
});
