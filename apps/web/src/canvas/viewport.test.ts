import { describe, expect, it } from "vitest";

import {
  INITIAL_VIEWPORT_MARGIN,
  initialViewportFor,
  isDefaultViewport,
  phoneOpeningViewport,
} from "./viewport";

describe("initialViewportFor", () => {
  it("空画布回到默认视口", () => {
    expect(initialViewportFor([])).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("单个节点：左上角落在 40px 边距上，缩放恒为 1", () => {
    expect(
      initialViewportFor([{ x: 120, y: 80, width: 640, height: 440 }]),
    ).toEqual({
      x: INITIAL_VIEWPORT_MARGIN - 120,
      y: INITIAL_VIEWPORT_MARGIN - 80,
      zoom: 1,
    });
  });

  it("多个节点：取包围盒左上角，不因节点多而缩小", () => {
    const viewport = initialViewportFor([
      { x: 300, y: 500, width: 640, height: 440 },
      { x: 120, y: 900, width: 900, height: 620 },
      { x: 2400, y: 260, width: 700, height: 480 },
    ]);
    expect(viewport).toEqual({ x: 40 - 120, y: 40 - 260, zoom: 1 });
  });

  it("负坐标：视口把内容推回可视区", () => {
    expect(
      initialViewportFor([
        { x: -800, y: -1200, width: 640, height: 440 },
        { x: -200, y: 300, width: 240, height: 200 },
      ]),
    ).toEqual({ x: 840, y: 1240, zoom: 1 });
  });

  it("组员坐标是相对父组框的，不参与包围盒", () => {
    const viewport = initialViewportFor([
      { x: 600, y: 600, width: 520, height: 360 },
      { x: 20, y: 20, width: 240, height: 200, parentId: "group-1" },
    ]);
    expect(viewport).toEqual({ x: 40 - 600, y: 40 - 600, zoom: 1 });
    // 全是组员时没有可用包围盒。
    expect(initialViewportFor([{ x: 20, y: 20, parentId: "group-1" }])).toEqual(
      { x: 0, y: 0, zoom: 1 },
    );
  });

  it("自定义边距", () => {
    expect(initialViewportFor([{ x: 100, y: 100 }], 0)).toEqual({
      x: -100,
      y: -100,
      zoom: 1,
    });
  });
});

describe("isDefaultViewport", () => {
  it("缺失或 {0,0,1} 视为没存过", () => {
    expect(isDefaultViewport(undefined)).toBe(true);
    expect(isDefaultViewport(null)).toBe(true);
    expect(isDefaultViewport({ x: 0, y: 0, zoom: 1 })).toBe(true);
  });

  it("存过的视口原样保留", () => {
    expect(isDefaultViewport({ x: 0, y: 0, zoom: 0.7 })).toBe(false);
    expect(isDefaultViewport({ x: -120, y: 40, zoom: 1 })).toBe(false);
  });
});

describe("phoneOpeningViewport（#715）", () => {
  const phone = { width: 402, height: 700 };
  const sticky = (x: number, y: number) => ({
    x,
    y,
    width: 260,
    height: 160,
  });
  // 桌面上存的 10% 全局视图：画布原点在屏幕 (50, 100)。
  const zoomedOut = { x: 50, y: 100, zoom: 0.1 };

  it("存的缩放低于字号下限：原视口中心最近的节点按首次显示的规则居中", () => {
    const near = sticky(1400, 2400); // 中心 (1530, 2480)，离原视口中心最近
    const far = sticky(0, 0);
    const next = phoneOpeningViewport({
      persisted: zoomedOut,
      nodes: [far, near],
      container: phone,
    })!;
    // 便签占主方向 1/φ 要 0.96，抬到字号下限 100%。
    expect(next.zoom).toBe(1);
    // 节点中心落在容器中心。
    expect(next.x + 1530 * next.zoom).toBeCloseTo(phone.width / 2, 5);
    expect(next.y + 2480 * next.zoom).toBeCloseTo(phone.height / 2, 5);
  });

  it("小节点不为了占比放大到 1.25 以上", () => {
    const next = phoneOpeningViewport({
      persisted: zoomedOut,
      nodes: [{ x: 1480, y: 2470, width: 100, height: 60 }],
      container: phone,
    })!;
    expect(next.zoom).toBeCloseTo(1.25, 5);
    expect(next.x + 1530 * next.zoom).toBeCloseTo(phone.width / 2, 5);
  });

  it("屏幕字号不低于 12px：大节点的缩放停在字号下限 100%", () => {
    const terminal = { x: 0, y: 0, width: 960, height: 594, fontPx: 12 };
    const next = phoneOpeningViewport({
      persisted: zoomedOut,
      nodes: [terminal],
      container: phone,
    })!;
    expect(next.zoom).toBe(1);
    expect(12 * next.zoom).toBeGreaterThanOrEqual(12);
  });

  it("终端字号偏好调小时下限跟着抬", () => {
    const terminal = { x: 0, y: 0, width: 960, height: 594, fontPx: 10 };
    const next = phoneOpeningViewport({
      persisted: zoomedOut,
      nodes: [terminal],
      container: phone,
    })!;
    expect(next.zoom).toBeCloseTo(1.2, 5);
  });

  it("存的缩放已经看得清时照旧恢复", () => {
    expect(
      phoneOpeningViewport({
        persisted: { x: -300, y: -120, zoom: 1 },
        nodes: [sticky(0, 0)],
        container: phone,
      }),
    ).toBeNull();
  });

  it("从没存过视口、画布空着、组员或容器没量到时不接管", () => {
    expect(
      phoneOpeningViewport({
        persisted: { x: 0, y: 0, zoom: 1 },
        nodes: [sticky(0, 0)],
        container: phone,
      }),
    ).toBeNull();
    expect(
      phoneOpeningViewport({
        persisted: zoomedOut,
        nodes: [],
        container: phone,
      }),
    ).toBeNull();
    expect(
      phoneOpeningViewport({
        persisted: zoomedOut,
        nodes: [{ ...sticky(0, 0), parentId: "group-1" }],
        container: phone,
      }),
    ).toBeNull();
    expect(
      phoneOpeningViewport({
        persisted: zoomedOut,
        nodes: [sticky(0, 0)],
        container: { width: 0, height: 0 },
      }),
    ).toBeNull();
  });
});
