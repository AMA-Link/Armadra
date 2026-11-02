// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COMPACT_QUERY } from "@/platform/layout";

/**
 * 手机竖屏下收起的小地图按钮不压底部导航（#697）。
 *
 * Node 里没有布局，这里读样式表：手机判据（`COMPACT_QUERY`）里 `.workspace-surface`
 * 的 `--navigation-bottom` 就是收起钮（`MinimapToggle`）与缩略图的底边，它必须
 * 高过「底部导航高度 + 安全区」，并且让到 Dock 之上。
 */
const STYLES = fileURLToPath(new URL("../../styles/", import.meta.url));
const read = (name: string): string =>
  readFileSync(`${STYLES}${name}`, "utf8").replace(/\s+/g, " ");

const CANVAS = read("canvas.css");
const TOKENS = read("tokens.css");

/** 手机判据那一块媒体查询的内容。 */
function compactBlock(): string {
  const head = `@media ${COMPACT_QUERY.replace(/\s+/g, " ")} {`;
  const start = CANVAS.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const body = start + head.length;
  let depth = 1;
  for (let i = body; i < CANVAS.length; i += 1) {
    if (CANVAS[i] === "{") depth += 1;
    if (CANVAS[i] === "}") depth -= 1;
    if (depth === 0) return CANVAS.slice(body, i);
  }
  throw new Error("手机媒体查询没有闭合");
}

/** `calc(...)` 里只有 px 的加法：把变量换成数后求值。 */
function px(expression: string, vars: Record<string, number>): number {
  const filled = expression
    .replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
      const value = vars[name];
      if (value === undefined) throw new Error(`缺少 ${name}`);
      return String(value);
    })
    .replace(/px/g, "")
    .replace(/calc/g, "");
  return Function(`"use strict"; return (${filled});`)() as number;
}

describe("手机布局里的小地图收起钮", () => {
  const rule =
    /\.workspace-surface \{ --navigation-bottom: (calc\([^;]+\)); \}/.exec(
      compactBlock(),
    );

  it("--navigation-bottom 写在缩略图与收起钮共同的祖先上", () => {
    expect(rule).not.toBeNull();
    // 缩略图本身不再单独覆盖：收起后它不渲染，收起钮读不到那个值。
    expect(compactBlock()).not.toMatch(
      /react-flow__minimap \{ --navigation-bottom/,
    );
  });

  it("竖屏手机（含刘海底边）收起钮高过导航与安全区", () => {
    const navigation = Number(/--mobile-nav-h: (\d+)px/.exec(TOKENS)![1]);
    const dock = Number(/--dock-h: (\d+)px/.exec(TOKENS)![1]);
    for (const safe of [0, 34]) {
      const bottom = px(rule![1]!, {
        "--mobile-nav-h": navigation,
        "--safe-bottom": safe,
        "--dock-h": dock,
      });
      expect(bottom).toBeGreaterThanOrEqual(navigation + safe + dock);
    }
  });

  it("矮屏的导航缩到 44px 时同一条公式照样让开", () => {
    expect(TOKENS).toMatch(
      /max-height: 500px\) \{ :root \{ --mobile-nav-h: 44px;/,
    );
    expect(rule![1]).toContain("var(--mobile-nav-h)");
    expect(rule![1]).toContain("var(--safe-bottom)");
  });
});
