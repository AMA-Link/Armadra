// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 开屏样式的守卫（设计系统 §8.7）：颜色只读根令牌，淡出读 `--dur-page`；
 * `Splash.tsx` 的 `splashFadeMs` 读同一个令牌，行为在 `Splash.test.tsx`。
 */
describe("splash.css", () => {
  const css = readFileSync(
    fileURLToPath(new URL("./splash.css", import.meta.url)),
    "utf8",
  );
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("没有字面色值：颜色全部读根令牌", () => {
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab)\(/);
    for (const token of ["--bg", "--text", "--brand", "--brand-text"])
      expect(code).toContain(`var(${token})`);
  });

  it("只保留两个开屏专用值（透明度 / 描边，不是色）", () => {
    const own = [...code.matchAll(/(--splash-[a-z-]+)\s*:/g)].map(
      (match) => match[1],
    );
    expect(new Set(own)).toEqual(
      new Set([
        "--splash-halo-opacity",
        "--splash-walker-rim",
        "--splash-tip-core",
      ]),
    );
  });

  it("淡出过渡读 --dur-page，减少动效下读 --dur-fast", () => {
    expect(code).toMatch(
      /transition:\s*opacity var\(--dur-page\) var\(--ease-out\)/,
    );
    expect(code).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.splash\s*\{\s*transition-duration:\s*var\(--dur-fast\)/,
    );
  });
});
