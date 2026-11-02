// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COMPACT_QUERY, PHONE_LANDSCAPE_QUERY } from "./layout";
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
 * 手机布局判据（#683，#715 改）：竖屏手机、横屏手机、平板、电脑窗口四种尺寸下的
 * 取值，以及样式表里抄写这条判据的几处与 `COMPACT_QUERY` 一致。#715 起手机横屏
 * 走电脑布局，另由 `PHONE_LANDSCAPE_QUERY` 认出来收紧几处默认值。
 *
 * Node 里没有 `matchMedia`，这里用一个只认本判据用到的几个特性的小解释器
 * （`max-width`、`min-width`、`max-height`、`pointer`、`and`、逗号）求值。
 */
describe("COMPACT_QUERY", () => {
  it("竖屏手机是手机布局", () => {
    expect(evaluate(COMPACT_QUERY, PHONE_PORTRAIT)).toBe(true);
  });

  it("横屏手机（含最大的机型）是电脑布局", () => {
    expect(evaluate(COMPACT_QUERY, PHONE_LANDSCAPE)).toBe(false);
    expect(evaluate(COMPACT_QUERY, PHONE_MAX_LANDSCAPE)).toBe(false);
  });

  it("平板竖横屏都是电脑布局，横屏弹出键盘变矮也不切换", () => {
    expect(evaluate(COMPACT_QUERY, TABLET_PORTRAIT)).toBe(false);
    expect(evaluate(COMPACT_QUERY, TABLET_LANDSCAPE)).toBe(false);
    expect(evaluate(COMPACT_QUERY, TABLET_LANDSCAPE_KEYBOARD)).toBe(false);
  });

  it("电脑窗口是电脑布局；窗口压窄到 767 以下才换手机布局", () => {
    expect(evaluate(COMPACT_QUERY, DESKTOP)).toBe(false);
    expect(evaluate(COMPACT_QUERY, DESKTOP_SHORT)).toBe(false);
    expect(evaluate(COMPACT_QUERY, DESKTOP_NARROW)).toBe(true);
  });

  it("边界只看宽度：767 是手机，768 不是，与高度、指针无关", () => {
    for (const pointer of ["coarse", "fine"] as const) {
      const at = (width: number, height: number): Viewport => ({
        width,
        height,
        pointer,
      });
      expect(evaluate(COMPACT_QUERY, at(767, 2000))).toBe(true);
      expect(evaluate(COMPACT_QUERY, at(767, 360))).toBe(true);
      expect(evaluate(COMPACT_QUERY, at(768, 2000))).toBe(false);
      expect(evaluate(COMPACT_QUERY, at(1023, 500))).toBe(false);
    }
  });
});

describe("PHONE_LANDSCAPE_QUERY", () => {
  it("与 COMPACT_QUERY 互斥：任何尺寸都不会两个同时成立", () => {
    for (const width of [320, 667, 767, 768, 874, 1023, 1024, 1440])
      for (const height of [320, 375, 500, 501, 900])
        for (const pointer of ["coarse", "fine"] as const) {
          const viewport = { width, height, pointer };
          expect(
            evaluate(COMPACT_QUERY, viewport) &&
              evaluate(PHONE_LANDSCAPE_QUERY, viewport),
          ).toBe(false);
        }
  });

  it("只认横过来的手机", () => {
    expect(evaluate(PHONE_LANDSCAPE_QUERY, PHONE_LANDSCAPE)).toBe(true);
    expect(evaluate(PHONE_LANDSCAPE_QUERY, PHONE_MAX_LANDSCAPE)).toBe(true);
    expect(evaluate(PHONE_LANDSCAPE_QUERY, PHONE_PORTRAIT)).toBe(false);
  });

  it("平板（含弹出键盘变矮）与电脑窗口都不算", () => {
    expect(evaluate(PHONE_LANDSCAPE_QUERY, TABLET_LANDSCAPE)).toBe(false);
    expect(evaluate(PHONE_LANDSCAPE_QUERY, TABLET_LANDSCAPE_KEYBOARD)).toBe(
      false,
    );
    expect(evaluate(PHONE_LANDSCAPE_QUERY, DESKTOP_SHORT)).toBe(false);
  });

  it("边界：768–1023 宽、500 高算，767 / 1024 / 501 不算", () => {
    const coarse = (width: number, height: number): Viewport => ({
      width,
      height,
      pointer: "coarse",
    });
    expect(evaluate(PHONE_LANDSCAPE_QUERY, coarse(768, 375))).toBe(true);
    expect(evaluate(PHONE_LANDSCAPE_QUERY, coarse(1023, 500))).toBe(true);
    expect(evaluate(PHONE_LANDSCAPE_QUERY, coarse(767, 375))).toBe(false);
    expect(evaluate(PHONE_LANDSCAPE_QUERY, coarse(1023, 501))).toBe(false);
    expect(evaluate(PHONE_LANDSCAPE_QUERY, coarse(1024, 500))).toBe(false);
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

  it("desktop 变体（输入框字号）把手机横屏也排除在外", () => {
    expect(APP).toContain(
      `@custom-variant desktop { @media (min-width: 768px) and (not (${PHONE_LANDSCAPE_QUERY})) {`,
    );
  });

  it("canvas.css 的手机横屏规则用 PHONE_LANDSCAPE_QUERY", () => {
    expect(read("canvas.css")).toContain(`@media ${PHONE_LANDSCAPE_QUERY} {`);
  });

  it.each(["app.css", "canvas.css", "settings.css"])(
    "%s 里按手机判据写的规则用 COMPACT_QUERY",
    (file) => {
      expect(read(file)).toContain(`@media ${COMPACT_QUERY} {`);
    },
  );

  it.each(["app.css", "canvas.css", "settings.css"])(
    "%s 里不再把手机横屏并进手机判据（#715）",
    (file) => {
      expect(read(file)).not.toContain("(max-width: 767px), (pointer: coarse)");
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
