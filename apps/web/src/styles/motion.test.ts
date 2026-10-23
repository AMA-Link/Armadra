// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `motion.css` 的约定（设计系统 §8）：静态读源文件断言。组件侧用到的类名与这里
 * 的选择器是一对，改一边要改另一边。
 */
const source = readFileSync(
  fileURLToPath(new URL("./motion.css", import.meta.url)),
  "utf8",
);
/** 注释里会写「不用 ease-in」这类话，断言只看规则本身。 */
const css = source.replace(/\/\*[\s\S]*?\*\//g, "");

describe("motion.css", () => {
  it("键盘触发的面板与紧邻的第二个 Tooltip 渲染终态", () => {
    expect(css).toMatch(/\.motion-tip\[data-state="instant-open"\]/);
    for (const name of [
      "motion-pop",
      "motion-dialog",
      "motion-overlay",
      "motion-sheet",
      "motion-tip",
    ]) {
      expect(css, name).toContain(`.${name}[data-instant]`);
    }
  });

  it("入场用 --ease-out / --ease-drawer，退场比入场短，从不 ease-in", () => {
    expect(css).toMatch(/armadra-pop-in var\(--dur-slow\) var\(--ease-out\)/);
    expect(css).toMatch(/armadra-pop-out var\(--dur-fast\)/);
    expect(css).toMatch(/armadra-pop-in var\(--dur-page\) var\(--ease-out\)/);
    expect(css).toMatch(/var\(--dur-page\)\s+var\(--ease-drawer\)/);
    expect(css).toMatch(/armadra-slide-out-right|--sheet-out/);
    expect(css).not.toMatch(/ease-in(?!-out)/);
    expect(css).not.toContain("cubic-bezier(");
  });

  it("关键帧齐全：pop / fade / rise / shimmer / shake / spin / swap / check / tick / indeterminate", () => {
    for (const name of [
      "armadra-pop-in",
      "armadra-pop-out",
      "armadra-fade-out",
      "armadra-rise-in",
      "armadra-shimmer",
      "armadra-shake",
      "armadra-spin",
      "armadra-swap-in",
      "armadra-swap-out",
      "armadra-check-draw",
      "armadra-tick-in",
      "armadra-indeterminate",
    ]) {
      expect(css, name).toContain(`@keyframes ${name}`);
    }
  });

  it("入场缩放从 --pop-scale 起，错落步长取 --stagger 且最多前 6 项", () => {
    expect(css).toMatch(/scale\(var\(--pop-scale\)\)/);
    expect(css).toMatch(/min\(var\(--i, 0\), 6\) \* var\(--stagger\)/);
  });

  it("按下缩放 0.97 只在 :hover:active，static / 禁用 / 弹出触发钮不生效", () => {
    expect(css).toMatch(
      /:hover:active\s*\{\s*transform: scale\(var\(--press-scale\)\)/,
    );
    expect(css).toContain('[data-static="true"]');
    expect(css).toContain(":disabled");
  });

  it("校验失败的输入类控件抖两次（240ms 匀速）", () => {
    expect(css).toMatch(/armadra-shake 240ms linear/);
    expect(css).toContain('[aria-invalid="true"]');
  });

  it("减少动效：位移与缩放换成 120ms 淡入，转圈保留，文字替换直接换", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion"));
    expect(reduced).toContain("animation-name: armadra-fade-in !important");
    expect(reduced).toContain("animation-duration: var(--dur-fast) !important");
    expect(reduced).toMatch(/\.anim-spin\s*\{[^}]*infinite !important/);
    expect(reduced).toMatch(/\.anim-swap-out\s*\{\s*display: none/);
  });

  it("触屏不出 Tooltip", () => {
    expect(css).toMatch(
      /@media \(hover: none\)\s*\{\s*\[data-slot="tooltip-content"\]\s*\{\s*display: none/,
    );
  });
});
