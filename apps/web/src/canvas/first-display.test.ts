// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GOLDEN_RATIO,
  NODE_TYPES,
  defaultNodeSizeOf,
  isGoldenSize,
  minNodeSizeOf,
  type CanvasNodeType,
  type Size,
} from "@armadra/shared";

import {
  FIRST_DISPLAY_FRACTION,
  FONT_FLOOR_PX,
  NODE_TEXT_PX,
  PHONE_NODE_MARGIN,
  firstDisplayZoom,
  fitNewNodeSize,
  fontFloorZoom,
  fractionZoom,
} from "./first-display";
import { MAX_ZOOM } from "./zoom";

/**
 * 新建节点第一次出现在屏幕上的大小（#684）：占主方向 1/φ、居中；屏幕上的
 * 字号（字号 × 缩放）不低于 `--text-meta`。三种视口：小屏手机竖屏、横屏手机、
 * 桌面。容器是画布本身（扣掉了底部导航 / 标题栏之后）的像素尺寸。
 */
const VIEWPORTS = {
  小屏手机竖屏: { width: 320, height: 500, compact: true },
  手机竖屏: { width: 390, height: 700, compact: true },
  手机横屏: { width: 844, height: 340, compact: true },
  桌面: { width: 1440, height: 900, compact: false },
} as const;

/** 页面新建一个节点时的尺寸（`store/defaults.ts::newNodeSize` 的同一条规则）。 */
function created(
  type: CanvasNodeType,
  viewport: { width: number; height: number; compact: boolean },
): Size {
  const size = defaultNodeSizeOf(type);
  return viewport.compact
    ? fitNewNodeSize({ size, min: minNodeSizeOf(type), container: viewport })
    : size;
}

describe("字号下限", () => {
  it("下限是 --text-meta（12px），节点正文最小也是 12px", () => {
    const tokens = readFileSync(
      fileURLToPath(new URL("../styles/tokens.css", import.meta.url)),
      "utf8",
    );
    expect(tokens).toMatch(new RegExp(`--text-meta:\\s*${FONT_FLOOR_PX}px;`));
    expect(tokens).toMatch(/--text-code:\s*var\(--text-meta\);/);
    expect(NODE_TEXT_PX).toBe(FONT_FLOOR_PX);
  });

  it("字号 × 缩放 ≥ 12px 对应的最小缩放", () => {
    expect(fontFloorZoom(12)).toBe(1);
    expect(fontFloorZoom(10)).toBeCloseTo(1.2);
    expect(fontFloorZoom(16)).toBeCloseTo(0.75);
  });
});

describe.each(Object.entries(VIEWPORTS))("%s", (_name, viewport) => {
  it.each(NODE_TYPES)("%s：字号下限成立", (type) => {
    const node = created(type, viewport);
    const zoom = firstDisplayZoom({ node, container: viewport });
    expect(NODE_TEXT_PX * zoom).toBeGreaterThanOrEqual(FONT_FLOOR_PX - 1e-9);
  });

  it.each(NODE_TYPES)("%s：新建尺寸仍是黄金比例", (type) => {
    expect(isGoldenSize(created(type, viewport))).toBe(true);
  });

  it.each(NODE_TYPES)(
    "%s：占主方向 1/φ（被字号下限或缩放上限顶住时除外）",
    (type) => {
      const node = created(type, viewport);
      const zoom = firstDisplayZoom({ node, container: viewport });
      const wanted = fractionZoom(node, viewport);
      if (wanted >= fontFloorZoom() && wanted <= MAX_ZOOM) {
        const fraction = Math.max(
          (node.width * zoom) / viewport.width,
          (node.height * zoom) / viewport.height,
        );
        expect(fraction).toBeCloseTo(FIRST_DISPLAY_FRACTION, 9);
      } else {
        expect(zoom).toBe(
          Math.min(MAX_ZOOM, Math.max(wanted, fontFloorZoom())),
        );
      }
    },
  );
});

describe.each(
  Object.entries(VIEWPORTS).filter(([, viewport]) => viewport.compact),
)("手机 %s", (_name, viewport) => {
  it.each(NODE_TYPES)("%s：新建后整块落在视口里并留出边距", (type) => {
    const node = created(type, viewport);
    const zoom = firstDisplayZoom({ node, container: viewport });
    expect(node.width * zoom).toBeLessThanOrEqual(
      viewport.width - PHONE_NODE_MARGIN * 2 + 1,
    );
    expect(node.height * zoom).toBeLessThanOrEqual(
      viewport.height - PHONE_NODE_MARGIN * 2 + 1,
    );
  });
});

describe("桌面上新建的终端、便签、编辑器", () => {
  const desktop = VIEWPORTS["桌面"];

  it("不改尺寸，缩放让它占主方向 1/φ，且不低于字号下限", () => {
    for (const type of ["terminal", "sticky", "editor"] as const) {
      const size = defaultNodeSizeOf(type);
      expect(created(type, desktop)).toEqual(size);
      const zoom = firstDisplayZoom({ node: size, container: desktop });
      expect(zoom).toBeGreaterThanOrEqual(1);
    }
    // 1440×900 的画布里终端在 100% 就已占 2/3，被字号下限顶住；更宽的画布才
    // 轮到 1/φ 起作用。
    const wide = { width: 1700, height: 1000 };
    const terminal = defaultNodeSizeOf("terminal");
    const zoom = firstDisplayZoom({ node: terminal, container: wide });
    expect(zoom).toBeGreaterThan(1);
    expect(
      Math.max(
        (terminal.width * zoom) / wide.width,
        (terminal.height * zoom) / wide.height,
      ),
    ).toBeCloseTo(1 / GOLDEN_RATIO, 9);
  });
});

describe("手机上装得下就原样", () => {
  it("横屏手机上的便签不被缩小", () => {
    const size = defaultNodeSizeOf("sticky");
    expect(
      fitNewNodeSize({
        size,
        min: minNodeSizeOf("sticky"),
        container: VIEWPORTS["手机横屏"],
      }),
    ).toEqual(size);
  });

  it("量不出容器时不缩小", () => {
    const size = defaultNodeSizeOf("terminal");
    expect(
      fitNewNodeSize({
        size,
        min: minNodeSizeOf("terminal"),
        container: { width: 0, height: 0 },
      }),
    ).toEqual(size);
  });

  it("终端的字号偏好小于 12 时下限更高，缩放跟着抬", () => {
    const node = defaultNodeSizeOf("terminal");
    const zoom = firstDisplayZoom({
      node,
      container: VIEWPORTS["桌面"],
      fontPx: 10,
    });
    expect(10 * zoom).toBeGreaterThanOrEqual(FONT_FLOOR_PX - 1e-9);
  });
});

describe("节点内容的字号只用字号档", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  const LITERAL = /fontSize:\s*["'`]?\d|font-size:\s*\d|text-\[\d/;

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });
  }

  it("nodes/ 与 canvas/flow/nodes/ 里没有写死 px 的字号", () => {
    const offenders = [
      ...sources(join(SRC, "nodes")),
      ...sources(join(SRC, "canvas/flow/nodes")),
    ].filter((path) => LITERAL.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
