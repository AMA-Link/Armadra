import type { CanvasNode } from "@armadra/shared";
import { describe, expect, it } from "vitest";

import { nodeTreeRows } from "./tree";

const node = (
  id: string,
  type: CanvasNode["type"],
  parentId?: string,
): CanvasNode =>
  ({ id, boardId: "board", type, title: id, parentId }) as CanvasNode;

describe("nodeTreeRows", () => {
  it("keeps canvas order within groups and still shows collapsed children", () => {
    const nodes = [
      node("child", "terminal", "group"),
      node("other", "sticky"),
      { ...node("group", "group"), collapsed: true },
      node("nested", "editor", "group"),
    ];
    expect(
      nodeTreeRows(nodes).map(({ node, depth }) => [node.id, depth]),
    ).toEqual([
      ["other", 0],
      ["group", 0],
      ["child", 1],
      ["nested", 1],
    ]);
  });

  it("shows malformed legacy cycles once without recursing forever", () => {
    expect(
      nodeTreeRows([
        node("first", "group", "second"),
        node("second", "group", "first"),
      ]).map(({ node }) => node.id),
    ).toEqual(["first", "second"]);
  });
});
