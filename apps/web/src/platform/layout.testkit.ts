/**
 * 手机布局判据测试共用：一个只认判据用到的几个媒体特性（`max-width`、`min-width`、
 * `max-height`、`pointer`、`and`、逗号）的小解释器，和几种典型屏幕尺寸。
 * Node 里没有 `matchMedia`，jsdom 的 `matchMedia` 也不会求值。
 */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly pointer: "coarse" | "fine";
}

function feature(name: string, value: string, viewport: Viewport): boolean {
  const px = Number.parseFloat(value);
  switch (name) {
    case "max-width":
      return viewport.width <= px;
    case "min-width":
      return viewport.width >= px;
    case "max-height":
      return viewport.height <= px;
    case "pointer":
      return viewport.pointer === value;
    default:
      throw new Error(`unsupported media feature: ${name}`);
  }
}

export function evaluate(query: string, viewport: Viewport): boolean {
  return query.split(",").some((part) =>
    part.split(/\band\b/).every((clause) => {
      const found = /\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)/.exec(clause);
      if (!found) throw new Error(`cannot parse: ${clause}`);
      return feature(found[1]!, found[2]!, viewport);
    }),
  );
}

export const PHONE_PORTRAIT: Viewport = {
  width: 393,
  height: 852,
  pointer: "coarse",
};
export const PHONE_LANDSCAPE: Viewport = {
  width: 852,
  height: 393,
  pointer: "coarse",
};
export const PHONE_MAX_LANDSCAPE: Viewport = {
  width: 956,
  height: 440,
  pointer: "coarse",
};
export const TABLET_PORTRAIT: Viewport = {
  width: 820,
  height: 1180,
  pointer: "coarse",
};
export const TABLET_LANDSCAPE: Viewport = {
  width: 1180,
  height: 820,
  pointer: "coarse",
};
export const TABLET_LANDSCAPE_KEYBOARD: Viewport = {
  width: 1280,
  height: 430,
  pointer: "coarse",
};
export const DESKTOP: Viewport = { width: 1440, height: 900, pointer: "fine" };
export const DESKTOP_SHORT: Viewport = {
  width: 1100,
  height: 420,
  pointer: "fine",
};
export const DESKTOP_NARROW: Viewport = {
  width: 700,
  height: 900,
  pointer: "fine",
};
