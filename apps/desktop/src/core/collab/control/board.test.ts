import { describe, expect, it } from "vitest";
import { defaultNodeSizeOf, isGoldenSize } from "@armadra/shared";

import { ANCHOR_FALLBACK_WIDTH, NODE_FALLBACK_HEIGHT } from "./board";

describe("没有 size 的锚点节点", () => {
  it("按默认终端的黄金比例尺寸占位，与页面新建的终端同一口径", () => {
    const terminal = defaultNodeSizeOf("terminal");
    expect({
      width: ANCHOR_FALLBACK_WIDTH,
      height: NODE_FALLBACK_HEIGHT,
    }).toEqual(terminal);
    expect(isGoldenSize(terminal)).toBe(true);
  });
});
