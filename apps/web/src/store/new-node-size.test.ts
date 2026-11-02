import { afterEach, describe, expect, it, vi } from "vitest";
import { NODE_TYPES, isGoldenSize } from "@armadra/shared";

import { cameraForNewNode } from "../canvas/flow/reveal";
import { setFlowContainer } from "../canvas/flow/flow-context";
import { COMPACT_QUERY, PHONE_LANDSCAPE_QUERY } from "../platform/layout";
import { defaultNodeSize, newNodeSize } from "./defaults";

/**
 * 手机上新建的节点：以前量不准视口时会落在屏外，要点「适应」才看得见。现在尺寸
 * 先缩到装得下，相机居中，整块都在视口里。竖屏是手机布局（`COMPACT_QUERY`），
 * 横屏是电脑布局（#715），由 `PHONE_LANDSCAPE_QUERY` 认出来，两边同一条规则。
 */

type Screen = "portrait" | "landscape" | "desktop";

function viewport(width: number, height: number, screen: Screen) {
  const query =
    screen === "portrait"
      ? COMPACT_QUERY
      : screen === "landscape"
        ? PHONE_LANDSCAPE_QUERY
        : null;
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: media === query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  setFlowContainer({
    getBoundingClientRect: () => ({ width, height }),
  } as unknown as HTMLElement);
  return { width, height };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setFlowContainer(null);
});

describe.each([
  ["手机横屏", 844, 390, "landscape"],
  ["小屏手机横屏", 667, 320, "portrait"],
  ["手机竖屏", 390, 700, "portrait"],
  ["小屏手机竖屏", 320, 500, "portrait"],
] as const)("%s 新建节点", (_name, width, height, screen) => {
  it.each(NODE_TYPES)("%s 居中后整块在视口里，仍是黄金比例", (type) => {
    const container = viewport(width, height, screen);
    const size = newNodeSize(type);
    expect(isGoldenSize(size)).toBe(true);

    const target = cameraForNewNode({
      node: { x: 0, y: 0, ...size },
      container,
      fontPx: 12,
    })!;
    // 相机居中：节点中心落在容器中心，屏幕上的尺寸 = 尺寸 × 缩放。
    const onScreen = {
      width: size.width * target.zoom,
      height: size.height * target.zoom,
    };
    expect(onScreen.width).toBeLessThanOrEqual(container.width);
    expect(onScreen.height).toBeLessThanOrEqual(container.height);
    expect(12 * target.zoom).toBeGreaterThanOrEqual(12);
  });
});

describe("不是手机时不缩小", () => {
  it.each(NODE_TYPES)("%s 用默认尺寸", (type) => {
    viewport(1440, 900, "desktop");
    expect(newNodeSize(type)).toEqual(defaultNodeSize(type));
  });
});
