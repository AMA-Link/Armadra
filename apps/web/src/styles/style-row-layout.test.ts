// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COMPACT_QUERY, PHONE_LANDSCAPE_QUERY } from "@/platform/layout";

/**
 * 样式条（`.canvas-style-row`，#714）坐在 Dock 正上方。手机竖屏的 Dock 是两行
 * （`--dock-stack-h`，#715），样式条必须让到两行之上，不压在第二行的工具上；
 * 桌面与手机横屏仍是一行 `--dock-h`。Node 里没有布局，读样式表求值。
 */
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ");

const CANVAS = read("canvas.css");
const TOKENS = read("tokens.css");

/** 某条媒体查询下所有块的内容（同一判据可能写了几块）。 */
function blocks(query: string | null): string[] {
  if (query === null) {
    // 顶层：去掉所有 @media / @container 块。
    let out = "";
    let depth = 0;
    let skipping = 0;
    for (let i = 0; i < CANVAS.length; i += 1) {
      const rest = CANVAS.slice(i);
      if (depth === 0 && /^@(media|container)\b/.test(rest)) skipping = 1;
      const ch = CANVAS[i];
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
      if (!skipping) out += ch;
      if (skipping && depth === 0 && ch === "}") skipping = 0;
    }
    return [out];
  }
  const head = `@media ${query} {`;
  const found: string[] = [];
  let start = CANVAS.indexOf(head);
  while (start !== -1) {
    const body = start + head.length;
    let depth = 1;
    let i = body;
    for (; i < CANVAS.length && depth > 0; i += 1) {
      if (CANVAS[i] === "{") depth += 1;
      if (CANVAS[i] === "}") depth -= 1;
    }
    found.push(CANVAS.slice(body, i - 1));
    start = CANVAS.indexOf(head, i);
  }
  return found;
}

/** 某组块里 `selector { ... }` 的声明，后写的覆盖先写的。 */
function declarations(scope: string[], selector: string): Map<string, string> {
  const result = new Map<string, string>();
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|[}\\s])${escaped} \\{([^}]*)\\}`, "g");
  for (const block of scope) {
    for (const match of block.matchAll(rule)) {
      for (const part of match[1]!.split(";")) {
        const colon = part.indexOf(":");
        if (colon < 0) continue;
        result.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
      }
    }
  }
  return result;
}

function px(expression: string, vars: Record<string, string>): number {
  let filled = expression;
  for (let guard = 0; guard < 10 && filled.includes("var("); guard += 1) {
    filled = filled.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
      const value = vars[name];
      if (value === undefined) throw new Error(`缺少 ${name}`);
      return `(${value})`;
    });
  }
  const arithmetic = filled.replace(/calc/g, "").replace(/px/g, "");
  return Function(`"use strict"; return (${arithmetic});`)() as number;
}

const token = (name: string) =>
  new RegExp(`${name}: (\\d+)px`).exec(TOKENS)![1]! + "px";

function bottoms(query: string | null, safe: number) {
  const scope =
    query === null ? blocks(null) : [...blocks(null), ...blocks(query)];
  const surface = declarations(scope, ".workspace-surface");
  const dockRow = declarations(scope, ".canvas-dock-row");
  const styleRow = declarations(scope, ".canvas-style-row");
  const vars: Record<string, string> = {
    "--safe-bottom": `${safe}px`,
    "--mobile-nav-h": token("--mobile-nav-h"),
    "--dock-h": token("--dock-h"),
  };
  for (const [name, value] of [...surface, ...dockRow, ...styleRow])
    if (name.startsWith("--")) vars[name] = value;
  // `.canvas-dock-row` 的 `bottom: var(--dock-bottom, <缺省>)`：没覆盖时取缺省。
  const fallback = /^var\(--dock-bottom, (.+)\)$/.exec(dockRow.get("bottom")!);
  const dockBottom = px(vars["--dock-bottom"] ?? fallback![1]!, vars);
  const dockHeight = px(
    query === COMPACT_QUERY ? "var(--dock-stack-h)" : "var(--dock-h)",
    vars,
  );
  return {
    dockTop: dockBottom + dockHeight,
    styleRow: px(styleRow.get("bottom")!, vars),
  };
}

describe("样式条坐在 Dock 之上", () => {
  it.each([
    ["桌面", null],
    ["手机竖屏（两行 Dock）", COMPACT_QUERY],
    ["手机横屏（一行 Dock）", PHONE_LANDSCAPE_QUERY],
  ] as const)("%s：样式条底边高过 Dock 顶边", (_name, query) => {
    for (const safe of [0, 34]) {
      const { dockTop, styleRow } = bottoms(query, safe);
      expect(styleRow).toBeGreaterThanOrEqual(dockTop);
      // 不远离 Dock：间隙不超过 16px。
      expect(styleRow - dockTop).toBeLessThanOrEqual(16);
    }
  });

  it("竖屏用两行 Dock 的高度，横屏与桌面用一行", () => {
    const portrait = declarations(blocks(COMPACT_QUERY), ".canvas-style-row");
    expect(portrait.get("bottom")).toContain("var(--dock-stack-h)");
    const landscape = declarations(
      blocks(PHONE_LANDSCAPE_QUERY),
      ".canvas-style-row",
    );
    expect(landscape.has("bottom")).toBe(false);
    expect(
      declarations(blocks(null), ".canvas-style-row").get("bottom"),
    ).toContain("var(--dock-h)");
  });
});

describe("宽不到 768 的矮屏手机（#732）", () => {
  it("Dock 合成一行，样式条与缩略图按一行的高度让到 Dock 之上", () => {
    const short = declarations(
      blocks("(max-width: 767px) and (max-height: 500px)"),
      ".workspace-surface",
    );
    expect(short.get("--dock-stack-h")).toBe("var(--dock-h)");
  });
});
