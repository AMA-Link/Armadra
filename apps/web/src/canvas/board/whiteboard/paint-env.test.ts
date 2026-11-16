// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { applyCanvasBackground } from "@/app/use-canvas-preferences";
import { DOT_COLORS } from "../../whiteboard/palette";
import { boardColor } from "./paint-env";

afterEach(() => {
  applyCanvasBackground(null);
  document.documentElement.style.cssText = "";
});

describe("点阵色", () => {
  it("取 --canvas-dot 令牌；令牌没定义时退回配色表", () => {
    expect(boardColor("dot")).toBe(DOT_COLORS.light);
    document.documentElement.style.setProperty("--canvas-dot", "#363636");
    expect(boardColor("dot")).toBe("#363636");
    document.documentElement.style.setProperty("--canvas-dot", "#d0d0d0");
    expect(boardColor("dot")).toBe("#d0d0d0");
  });

  it("「画布背景」偏好写在根元素上的值照样生效", () => {
    applyCanvasBackground({
      "--canvas-bg": "#000000",
      "--canvas-dot": "#4d4d4d",
    });
    expect(boardColor("dot")).toBe("#4d4d4d");
  });
});
