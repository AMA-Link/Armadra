import { describe, expect, it } from "vitest";

import { GOLDEN_RATIO } from "@armadra/shared";

import { cameraForNewNode } from "./reveal";

/**
 * 新建节点之后相机去哪（#684）。手动新建与 `node.created` 共用这套规则：
 * 每次都居中，缩放让节点占视口主方向的 1/φ，但字号 × 缩放不低于 12px。
 */

const CONTAINER = { width: 1700, height: 1000 };
const NODE = { x: 1000, y: 400, width: 960, height: 593 };

describe("cameraForNewNode", () => {
  it("居中到节点中心，缩放让节点占主方向 1/φ", () => {
    const target = cameraForNewNode({ node: NODE, container: CONTAINER });
    expect(target).not.toBeNull();
    expect(target!.x).toBe(1480);
    expect(target!.y).toBe(696.5);
    expect(
      Math.max(
        (NODE.width * target!.zoom) / CONTAINER.width,
        (NODE.height * target!.zoom) / CONTAINER.height,
      ),
    ).toBeCloseTo(1 / GOLDEN_RATIO, 9);
  });

  it("总览缩放不影响结果：只看节点与容器", () => {
    expect(cameraForNewNode({ node: NODE, container: CONTAINER })).toEqual(
      cameraForNewNode({ node: NODE, container: CONTAINER }),
    );
  });

  it("容器放不下时缩放顶在字号下限（100%），不再缩小", () => {
    const target = cameraForNewNode({
      node: NODE,
      container: { width: 800, height: 600 },
    });
    expect(target).toMatchObject({ zoom: 1 });
  });

  it("终端字号偏好调小到 10px 时下限抬到 120%", () => {
    const target = cameraForNewNode({
      node: NODE,
      container: { width: 800, height: 600 },
      fontPx: 10,
    });
    expect(target!.zoom).toBeCloseTo(1.2);
  });

  it("量不到容器时居中并抬到字号下限", () => {
    expect(
      cameraForNewNode({ node: NODE, container: { width: 0, height: 0 } }),
    ).toEqual({ x: 1480, y: 696.5, zoom: 1 });
  });

  it("小便签不会被放大过头：缩放封顶在 3 倍", () => {
    const target = cameraForNewNode({
      node: { x: 0, y: 0, width: 280, height: 173 },
      container: CONTAINER,
    });
    expect(target!.zoom).toBe(3);
  });

  it("还没量过的节点（宽高为 0）一律不动相机", () => {
    expect(
      cameraForNewNode({
        node: { x: 0, y: 0, width: 0, height: 0 },
        container: CONTAINER,
      }),
    ).toBe(null);
  });
});
