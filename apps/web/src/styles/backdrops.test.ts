// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CONTRAST_THRESHOLD, contrastOver } from "@/lib/contrast";
import { BACKDROPS } from "../app/backdrops";

/**
 * 窗口背景色板（AMA-Link/Armadra#474）：每个色板在深浅两套主题下都给齐三个
 * 停点与画布底，且正文、次要文字、品牌文字叠在每个停点与画布上 ≥ 4.5。
 */

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

const tokensCss = read("./tokens.css");
const backdropsCss = read("./backdrops.css").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`未找到选择器：${selector}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

function properties(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.trim().replace(/\s+/g, " "));
  }
  return out;
}

type Theme = "dark" | "light";
const dark = properties(ruleBody(tokensCss, ":root {"));
const TOKENS: Record<Theme, Map<string, string>> = {
  dark,
  light: new Map([
    ...dark,
    ...properties(ruleBody(tokensCss, ':root[data-theme="light"]')),
  ]),
};

function token(theme: Theme, name: string): string {
  const raw = TOKENS[theme].get(name);
  if (raw === undefined) throw new Error(`${theme} 缺少 ${name}`);
  return raw.replace(/var\((--[\w-]+)\)/g, (_, ref: string) =>
    token(theme, ref),
  );
}

function palette(theme: Theme, id: string): Map<string, string> {
  const selector =
    theme === "dark"
      ? `:root[data-backdrop="${id}"],`
      : `:root[data-theme="light"][data-backdrop="${id}"],`;
  return properties(ruleBody(backdropsCss, selector));
}

const STOPS = ["--backdrop-a", "--backdrop-b", "--backdrop-c", "--canvas-bg"];
const TEXTS = ["--text", "--muted-foreground", "--brand-text"];
const COLORED = BACKDROPS.filter((id) => id !== "plain");

describe("窗口背景色板", () => {
  it("plain 是第一档，也是默认", () => {
    expect(BACKDROPS[0]).toBe("plain");
  });

  it.each(["dark", "light"] as const)(
    "%s 主题下每个色板给齐三个停点与画布底，都是实色",
    (theme) => {
      for (const id of COLORED) {
        const table = palette(theme, id);
        for (const name of STOPS)
          expect(table.get(name), `${id} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    },
  );

  it.each(["dark", "light"] as const)(
    "%s 主题下文字叠在每个停点与画布上 ≥ 4.5",
    (theme) => {
      for (const id of COLORED) {
        const table = palette(theme, id);
        for (const stop of STOPS) {
          for (const text of TEXTS) {
            expect(
              contrastOver(token(theme, text), table.get(stop)!),
              `${theme} ${id} ${text} on ${stop}`,
            ).toBeGreaterThanOrEqual(CONTRAST_THRESHOLD.text);
          }
        }
      }
    },
  );
});
