// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GOLDEN_RATIO } from "@armadra/shared";

import { COLLAPSED_HEIGHT } from "../nodes/geometry";

/**
 * 主要分区的比例取 φ（#684）：侧栏与画布、工作面板与画布、Dock 与节点头。
 * 数值来自 `tokens.css`，这里只校对它们和 φ 的关系。
 */
const tokens = readFileSync(
  fileURLToPath(new URL("./tokens.css", import.meta.url)),
  "utf8",
);

function declaration(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(tokens);
  expect(match, name).not.toBeNull();
  return match![1]!;
}

/** `clamp(min, calc(100vw / d), max)` 里的除数。 */
function divisor(name: string): number {
  const match = /calc\(100vw \/ ([\d.]+)\)/.exec(declaration(name));
  expect(match, name).not.toBeNull();
  return Number(match![1]);
}

describe("主要分区的 φ 比例", () => {
  it("侧栏 : 画布 = 1 : φ³（窗口 = 侧栏 × (1 + φ³)）", () => {
    expect(divisor("--sidebar-w")).toBeCloseTo(1 + GOLDEN_RATIO ** 3, 3);
  });

  it("右侧工作面板 : 画布 = 1 : φ²（窗口 = 面板 × (1 + φ²)）", () => {
    expect(divisor("--drawer-w")).toBeCloseTo(1 + GOLDEN_RATIO ** 2, 3);
  });

  it("Dock 高 : 节点折叠高 = φ（1px 以内）", () => {
    const dock = Number(/(\d+)px/.exec(declaration("--dock-h"))![1]);
    expect(
      Math.abs(dock - COLLAPSED_HEIGHT * GOLDEN_RATIO),
    ).toBeLessThanOrEqual(1);
  });

  it("字号档不动：--text-meta 仍是 12px", () => {
    expect(declaration("--text-meta")).toBe("12px");
    expect(declaration("--text-caption")).toBe("11px");
    expect(declaration("--text-body")).toBe("13px");
  });
});
