// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// vitest 把 CSS stub 成空串，所以按文件读源文本（同 `tokens.test.ts`）。
const canvasCss = readFileSync(
  fileURLToPath(new URL("./canvas.css", import.meta.url)),
  "utf8",
);

/** 选择器列表 → 它那一块声明（取第一处）。 */
function block(selector: string): string {
  const at = canvasCss.indexOf(selector);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const open = canvasCss.indexOf("{", at);
  return canvasCss.slice(open + 1, canvasCss.indexOf("}", open));
}

describe("缩略图收起钮：悬停才显示（#216）", () => {
  it("展开时平时不显示、不接指针", () => {
    const hidden = block('.minimap-toggle[aria-expanded="true"] {');
    expect(hidden).toMatch(/opacity:\s*0/);
    expect(hidden).toMatch(/pointer-events:\s*none/);
  });

  it("悬停缩略图、悬停钮本身、键盘聚焦与收起后的展开钮都显示", () => {
    const marker = '.minimap-toggle[data-reveal="true"] {';
    const shown = block(marker);
    expect(shown).toMatch(/opacity:\s*1/);
    expect(shown).toMatch(/pointer-events:\s*auto/);
    const at = canvasCss.indexOf(marker);
    // prettier 会把长选择器拆成几行，比较前把空白压成一个空格。
    const selectors = canvasCss
      .slice(canvasCss.lastIndexOf("}", at) + 1, at)
      .replace(/\s+/g, " ");
    expect(selectors).toContain('.minimap-toggle[aria-expanded="false"]');
    expect(selectors).toContain(".minimap-toggle:focus-visible");
    expect(selectors).toContain(
      ".react-flow__minimap:hover ~ .minimap-toggle-panel .minimap-toggle",
    );
    expect(selectors).toContain(".minimap-toggle-panel:hover .minimap-toggle");
  });

  it("触屏没有悬停：常显", () => {
    const at = canvasCss.indexOf("@media (hover: none), (any-pointer: coarse)");
    expect(at).toBeGreaterThanOrEqual(0);
    const media = canvasCss.slice(at, canvasCss.indexOf("}\n}", at));
    expect(media).toContain('.minimap-toggle[aria-expanded="true"]');
    expect(media).toMatch(/opacity:\s*1/);
  });
});

describe("canvas.css 令牌（设计系统 §2.8 / §2.9 / §8）", () => {
  it("没有字面时长与曲线：过渡和动画只读 --dur-* / --ease-* 令牌", () => {
    const decls = canvasCss.match(/(?:transition|animation)[\w-]*\s*:[^;]+;/g);
    expect(decls?.length ?? 0).toBeGreaterThan(0);
    for (const decl of decls ?? []) {
      // 令牌引用先抹掉，剩下的里不许有字面时长或缓动关键字
      const literal = decl.replace(/var\([^)]*\)/g, "");
      expect(literal, decl).not.toMatch(/\b\d*\.?\d+m?s\b/);
      expect(literal, decl).not.toMatch(/\bease(?:-in|-out|-in-out)?\b/);
    }
    expect(canvasCss).not.toMatch(/cubic-bezier\(/);
  });

  it("小地图：12 圆角、1px 强边、浮层阴影", () => {
    const minimap = block(".canvas-stage .react-flow__minimap {");
    expect(minimap).toContain("border: 1px solid var(--border-strong)");
    expect(minimap).toContain("border-radius: var(--r-panel)");
    expect(minimap).toContain("box-shadow: var(--shadow-overlay)");
  });

  it("不再用旧别名 --shadow-pill / --r-sm / --r-xl", () => {
    expect(canvasCss).not.toMatch(/--shadow-pill|--r-sm\b|--r-xl\b/);
  });

  it("Dock 行让位面板用 --dur-base --ease-out", () => {
    const row = block(".canvas-dock-row {\n  transition");
    expect(row).toContain("transition: right var(--dur-base) var(--ease-out)");
  });

  it("拖线终点圆点吸附：只在 data-snapped 时过渡 cx / cy", () => {
    const snap = block(
      '.canvas-stage [data-slot="connection-line"] circle[data-snapped="true"] {',
    );
    expect(snap).toContain("cx var(--dur-slow) var(--ease-in-out)");
    expect(snap).toContain("cy var(--dur-slow) var(--ease-in-out)");
  });

  it("减少动效下缩略图与收起钮不过渡（全局压制不归零，位置一变会被拖着走）", () => {
    const at = canvasCss.indexOf(
      "@media (prefers-reduced-motion: reduce) {\n  .canvas-stage .react-flow__minimap",
    );
    expect(at).toBeGreaterThanOrEqual(0);
    const media = canvasCss.slice(at, canvasCss.indexOf("}\n}", at));
    expect(media).toContain(".canvas-stage .minimap-toggle-panel");
    expect(media).toMatch(/transition:\s*none\s*!important/);
  });
});
