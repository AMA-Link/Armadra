// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getNodesBounds } from "@xyflow/react";
import { createBoard } from "@armadra/board/dom";
import type { CanvasNode } from "@armadra/shared";

import { createBoardFlowHandle } from "./flow-handle";

const entity = (id: string, x: number, y: number, parent?: string) => ({
  id,
  kind: "card",
  ...(parent ? { parent } : {}),
  x,
  y,
  w: 200,
  h: 100,
  z: 1,
  data: { id } as unknown as CanvasNode,
});

function setup() {
  const board = createBoard<CanvasNode>({
    kinds: { card: { layer: "world" } },
  });
  board.scene.transact(
    (d) => {
      d.set(entity("g", 100, 100));
      d.set(entity("c", 10, 20, "g"));
    },
    { history: "ignore" },
  );
  board.camera.setViewport({ width: 800, height: 600 });
  const container = document.createElement("div");
  container.getBoundingClientRect = () =>
    ({ left: 50, top: 30, width: 800, height: 600 }) as DOMRect;
  return { board, flow: createBoardFlowHandle(board, () => container) };
}

describe("引擎的视口句柄", () => {
  it("getViewport / setViewport 读写相机", async () => {
    const { board, flow } = setup();
    await flow.setViewport({ x: 10, y: 20, zoom: 2 });
    expect(flow.getViewport()).toEqual({ x: 10, y: 20, zoom: 2 });
    expect(board.camera.get()).toEqual({ x: 10, y: 20, zoom: 2 });
  });

  it("screenToFlowPosition 吃客户端坐标，先减去容器偏移", async () => {
    const { flow } = setup();
    await flow.setViewport({ x: 100, y: 0, zoom: 2 });
    // 客户端 (250, 130) → 容器内 (200, 100) → 画布 ((200-100)/2, 100/2)
    expect(flow.screenToFlowPosition({ x: 250, y: 130 })).toEqual({
      x: 50,
      y: 50,
    });
  });

  it("zoomTo 以容器中心为锚点，中心点在画布上不动", async () => {
    const { flow } = setup();
    const center = () =>
      flow.screenToFlowPosition({ x: 50 + 400, y: 30 + 300 });
    const before = center();
    await flow.zoomTo(2);
    expect(flow.getViewport().zoom).toBe(2);
    expect(center().x).toBeCloseTo(before.x);
    expect(center().y).toBeCloseTo(before.y);
  });

  it("setCenter 把指定点放到视口中心", async () => {
    const { flow } = setup();
    await flow.setCenter(500, 400, { zoom: 1 });
    expect(flow.getViewport()).toEqual({ x: -100, y: -100, zoom: 1 });
  });

  it("getNode：相对坐标、绝对位置与 measured；getNodesBounds 读得懂", () => {
    const { flow } = setup();
    const node = flow.getNode("c")!;
    expect(node.position).toEqual({ x: 10, y: 20 });
    expect(node.parentId).toBe("g");
    expect(node.measured).toEqual({ width: 200, height: 100 });
    expect(getNodesBounds([node])).toEqual({
      x: 110,
      y: 120,
      width: 200,
      height: 100,
    });
    expect(flow.getNodes()).toHaveLength(2);
    expect(flow.getNode("nope")).toBeUndefined();
  });
});
