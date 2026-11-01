// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COMPACT_QUERY } from "./layout";
import {
  DESKTOP,
  DESKTOP_NARROW,
  DESKTOP_SHORT,
  PHONE_LANDSCAPE,
  PHONE_MAX_LANDSCAPE,
  PHONE_PORTRAIT,
  TABLET_LANDSCAPE,
  TABLET_LANDSCAPE_KEYBOARD,
  TABLET_PORTRAIT,
  evaluate,
  type Viewport,
} from "./layout.testkit";

/**
 * 手机布局判据（#683）：竖屏手机、横屏手机、平板、电脑窗口四种尺寸下的取值，
 * 以及样式表里抄写这条判据的几处与 `COMPACT_QUERY` 一致。
 *
 * Node 里没有 `matchMedia`，这里用一个只认本判据用到的几个特性的小解释器
 * （`max-width`、`min-width`、`max-height`、`pointer`、`and`、逗号）求值。
 */
describe("COMPACT_QUERY", () => {
  it("竖屏手机是手机布局", () => {
    expect(evaluate(COMPACT_QUERY, PHONE_PORTRAIT)).toBe(true);
  });

  it("横屏手机（含最大的机型）仍是手机布局", () => {
    expect(evaluate(COMPACT_QUERY, PHONE_LANDSCAPE)).toBe(true);
    expect(evaluate(COMPACT_QUERY, PHONE_MAX_LANDSCAPE)).toBe(true);
  });

  it("平板竖横屏都是电脑布局，横屏弹出键盘变矮也不切换", () => {
    expect(evaluate(COMPACT_QUERY, TABLET_PORTRAIT)).toBe(false);
    expect(evaluate(COMPACT_QUERY, TABLET_LANDSCAPE)).toBe(false);
    expect(evaluate(COMPACT_QUERY, TABLET_LANDSCAPE_KEYBOARD)).toBe(false);
  });

  it("电脑窗口是电脑布局；窗口压窄到 767 以下才换手机布局", () => {
    expect(evaluate(COMPACT_QUERY, DESKTOP)).toBe(false);
    // 鼠标主指针的矮窗口不是触屏，不换。
    expect(evaluate(COMPACT_QUERY, DESKTOP_SHORT)).toBe(false);
    expect(evaluate(COMPACT_QUERY, DESKTOP_NARROW)).toBe(true);
  });

  it("边界：767 宽、500 高、1023 宽都算手机，768 / 501 / 1024 不算", () => {
    const coarse = (width: number, height: number): Viewport => ({
      width,
      height,
      pointer: "coarse",
    });
    expect(evaluate(COMPACT_QUERY, coarse(767, 2000))).toBe(true);
    expect(evaluate(COMPACT_QUERY, coarse(768, 2000))).toBe(false);
    expect(evaluate(COMPACT_QUERY, coarse(1023, 500))).toBe(true);
    expect(evaluate(COMPACT_QUERY, coarse(1023, 501))).toBe(false);
    expect(evaluate(COMPACT_QUERY, coarse(1024, 500))).toBe(false);
  });
});

const STYLES = fileURLToPath(new URL("../styles/", import.meta.url));
const read = (name: string): string =>
  readFileSync(`${STYLES}${name}`, "utf8").replace(/\s+/g, " ");

describe("样式表抄写的判据", () => {
  const APP = read("app.css");

  it("Tailwind 变体 compact 与 COMPACT_QUERY 同一条", () => {
    expect(APP).toContain(
      `@custom-variant compact { @media ${COMPACT_QUERY} {`,
    );
  });

  it("desktop 变体是 compact 的补集", () => {
    const rest = COMPACT_QUERY.split(", ")[1]!;
    expect(APP).toContain(
      `@custom-variant desktop { @media (min-width: 768px) and (not (${rest})) {`,
    );
  });

  it.each(["app.css", "canvas.css", "settings.css"])(
    "%s 里没有只看宽度的 767px 判据",
    (file) => {
      const css = read(file);
      expect(css).not.toMatch(/@media \(max-width: 767px\) \{/);
    },
  );

  it.each(["app.css", "canvas.css", "settings.css"])(
    "%s 里按手机判据写的规则用 COMPACT_QUERY",
    (file) => {
      expect(read(file)).toContain(`@media ${COMPACT_QUERY} {`);
    },
  );

  it("short 变体与 --mobile-nav-h 的矮屏取值按高度 ≤ 500px", () => {
    expect(APP).toContain(
      "@custom-variant short { @media (max-height: 500px) {",
    );
    expect(read("tokens.css")).toMatch(
      /@media \(max-height: 500px\) \{ :root \{ --mobile-nav-h: 44px;/,
    );
  });
});
