// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 首屏错落入场的样式（设计系统 §8.7）：三块（侧栏、画布、Dock / 工具簇）各带延迟，
 * 只动 opacity 与独立的 `translate`，数值全读令牌，减少动效下不动。
 */
const css = readFileSync(
  fileURLToPath(new URL("./first-screen.css", import.meta.url)),
  "utf8",
);
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("first-screen.css", () => {
  it("三块依次入场：侧栏无延迟，画布 1 步，Dock 与工具簇 2 步", () => {
    expect(code).toMatch(/\[data-enter="play"\] > aside\.material-sidebar/);
    expect(code).toMatch(
      /\[data-enter="play"\] > main\s*\{\s*animation-delay:\s*var\(--first-step\)/,
    );
    expect(code).toMatch(/animation-delay:\s*calc\(var\(--first-step\) \* 2\)/);
    expect(code).toContain('[data-slot="dock"]');
    expect(code).toContain('[data-slot="controls-cluster"]');
  });

  it("起播前三块是透明的，免得露出一帧终态再消失", () => {
    expect(code).toMatch(/\[data-enter="wait"\][^{]*\{[^}]*opacity:\s*0/);
  });

  it("时长和曲线读令牌，位移用独立的 translate，不碰 transform", () => {
    expect(code).toContain("var(--dur-slow) var(--ease-out)");
    expect(code).toMatch(/translate:\s*0 4px/);
    expect(code).not.toMatch(/transform\s*:/);
    expect(code).not.toMatch(/cubic-bezier\(|#[0-9a-fA-F]{3,8}\b/);
  });

  it("减少动效下兜底：不透明、不动画", () => {
    expect(code).toMatch(
      /prefers-reduced-motion: reduce\)[\s\S]*opacity:\s*1;\s*animation:\s*none/,
    );
  });
});
