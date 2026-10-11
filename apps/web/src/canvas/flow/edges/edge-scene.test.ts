import { describe, expect, it } from "vitest";
import type { InternalNode, Node } from "@xyflow/react";

import { sameScene, sceneOf, SCENE_MARGIN } from "./edge-scene";

/** 一条边路由时看的那一小块画布（#318）。 */

function node(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 100,
  type = "armadra",
): [string, InternalNode<Node>] {
  return [
    id,
    {
      id,
      type,
      position: { x, y },
      data: {},
      measured: { width, height },
      internals: { positionAbsolute: { x, y }, z: 0, userNode: {} as Node },
    } as InternalNode<Node>,
  ];
}

describe("sceneOf", () => {
  it("只收两端附近的节点；分组框、墨迹与包住一端的外框不挡路", () => {
    const nodes = new Map([
      node("a", 0, 0),
      node("b", 400, 0),
      node("near", 200, 150),
      node("far", 400 + 100 + SCENE_MARGIN + 50, 0),
      node("group", 150, -50, 100, 100, "group"),
      node("ink", 150, 120, 50, 50, "wb.ink"),
      node("frame", -50, -50, 300, 300, "wb.shape"),
    ]);
    const scene = sceneOf(nodes, "a", "b");
    expect(scene?.source).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(scene?.obstacles).toEqual([
      { x: 200, y: 150, width: 100, height: 100 },
    ]);
  });

  it("一端还没量到尺寸时没有场景", () => {
    const nodes = new Map([node("a", 0, 0), node("b", 400, 0, 0, 0)]);
    expect(sceneOf(nodes, "a", "b")).toBeNull();
  });

  it("亚像素的挪动取整后算同一个场景", () => {
    const one = sceneOf(
      new Map([node("a", 0, 0), node("b", 400, 0)]),
      "a",
      "b",
    );
    const two = sceneOf(
      new Map([node("a", 0.2, 0), node("b", 400.3, 0)]),
      "a",
      "b",
    );
    expect(sameScene(one, two)).toBe(true);
    const moved = sceneOf(
      new Map([node("a", 0, 0), node("b", 420, 0)]),
      "a",
      "b",
    );
    expect(sameScene(one, moved)).toBe(false);
  });
});
