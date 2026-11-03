// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COMPACT_QUERY, PHONE_LANDSCAPE_QUERY } from "@/platform/layout";

/**
 * 样式条（`.canvas-style-row`，#714）坐在 Dock 正上方。Dock 在桌面、手机竖屏与
 * 手机横屏都是一行 `--dock-h`（#766 推翻 #715 的竖屏两行），样式条按一行的高度
 * 让位。Node 里没有布局，读样式表求值。
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
    filled = filled.replace(
      /var\((--[\w-]+)(?:, ([^()]+))?\)/g,
      (_, name: string, fallback?: string) => {
        const value = vars[name] ?? fallback;
        if (value === undefined) throw new Error(`缺少 ${name}`);
        return `(${value})`;
      },
    );
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
  const dockHeight = px("var(--dock-h)", vars);
  return {
    dockTop: dockBottom + dockHeight,
    styleRow: px(styleRow.get("bottom")!, vars),
  };
}

describe("样式条坐在 Dock 之上", () => {
  it.each([
    ["桌面", null],
    ["手机竖屏", COMPACT_QUERY],
    ["手机横屏（一行 Dock）", PHONE_LANDSCAPE_QUERY],
  ] as const)("%s：样式条底边高过 Dock 顶边", (_name, query) => {
    for (const safe of [0, 34]) {
      const { dockTop, styleRow } = bottoms(query, safe);
      expect(styleRow).toBeGreaterThanOrEqual(dockTop);
      // 不远离 Dock：间隙不超过 16px。
      expect(styleRow - dockTop).toBeLessThanOrEqual(16);
    }
  });

  it("竖屏、横屏与桌面都按一行 --dock-h 让位，不再有 --dock-stack-h（#766）", () => {
    expect(CANVAS).not.toContain("--dock-stack-h");
    for (const query of [COMPACT_QUERY, PHONE_LANDSCAPE_QUERY]) {
      // 各断点只改基线，底边公式沿用顶层那条（按 `--dock-h`）。
      expect(
        declarations(blocks(query), ".canvas-style-row").has("bottom"),
      ).toBe(false);
    }
    expect(
      declarations(blocks(null), ".canvas-style-row").get("bottom"),
    ).toContain("var(--dock-h)");
  });
});

describe("矮屏手机不再有合成一行的特例（#766）", () => {
  it("宽不到 768 的矮屏与竖屏同一条规则", () => {
    expect(blocks("(max-width: 767px) and (max-height: 500px)")).toEqual([]);
  });
});

/** 手机横屏的整排 Dock（WebKit 874×402 实测约 627px，留一点余量）。 */
const LANDSCAPE_DOCK_ROW = 640;

describe("左右安全区：画布铺满，浮层各自让开（#766）", () => {
  it("画布面的内缩取安全区，停靠侧栏开着时左边归零", () => {
    // 顶层那条 `.workspace-surface { ... }`（`:has()` 那条另算，后面单独核对）。
    const surface = /(?:^|\}) \.workspace-surface \{([^}]*)\}/.exec(
      blocks(null)[0]!,
    )![1]!;
    expect(surface).toContain("--surface-inset-left: var(--safe-left);");
    expect(surface).toContain("--surface-inset-right: var(--safe-right);");
    expect(CANVAS).toContain(
      '.app-shell:has(> aside[data-state="open"]) > .workspace-surface { --surface-inset-left: 0px; }',
    );
  });

  it.each([
    ["桌面", null],
    ["手机竖屏", COMPACT_QUERY],
  ] as const)("%s：Dock 行与样式条的左右边距都加上内缩", (_name, query) => {
    const scope =
      query === null ? blocks(null) : [...blocks(null), ...blocks(query)];
    for (const selector of [".canvas-dock-row", ".canvas-style-row"]) {
      const rule = declarations(scope, selector);
      expect(rule.get("left")).toContain("var(--surface-inset-left, 0px)");
      expect(rule.get("right")).toContain("var(--surface-inset-right, 0px)");
    }
    expect(
      declarations(blocks(null), ".canvas-stage .react-flow__minimap").get(
        "right",
      ),
    ).toContain("var(--surface-inset-right, 0px)");
  });

  it("手机横屏 874 宽、刘海 62：收起缩略图时整排 Dock 放得下", () => {
    const scope = [...blocks(null), ...blocks(PHONE_LANDSCAPE_QUERY)];
    const row = declarations(scope, ".canvas-dock-row");
    const vars = {
      "--surface-inset-left": "62px",
      "--surface-inset-right": "62px",
    };
    const width =
      874 - px(row.get("left")!, vars) - px(row.get("right")!, vars);
    // 右格给缩略图（收起后 36px）留的下限；左格可以是 0。
    const columns = row.get("grid-template-columns")!;
    expect(columns).toContain("calc(var(--minimap-w) + 14px)");
    const reserved = 36 + 14;
    expect(width - reserved).toBeGreaterThanOrEqual(LANDSCAPE_DOCK_ROW);
  });

  it("放不下时 Dock 那一行横向滚动并渐隐两端，滚动条不画", () => {
    const scroll = declarations(
      blocks(null),
      '.canvas-dock [data-slot="dock-scroll"]',
    );
    expect(scroll.get("overflow-x")).toBe("auto");
    expect(scroll.get("scrollbar-width")).toBe("none");
    expect(CANVAS).toContain('[data-slot="dock-scroll"][data-fade-start]');
    expect(CANVAS).toContain('[data-slot="dock-scroll"][data-fade-end]');
  });
});
