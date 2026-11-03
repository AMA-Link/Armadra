import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardDocument } from "@armadra/shared";

import { CENTER_NODE_EVENT } from "../canvas/flow/flow-context";
import { emptyWhiteboard } from "../canvas/whiteboard/model";
import { useCanvasStore } from "../store/canvas-store";
import { CENTER_RETRY_DELAYS, gotoItem } from "./goto-node";

const timestamp = "2026-09-05T10:00:00.000Z";
const documentOf = (boardId: string, whiteboard: string): BoardDocument => ({
  board: {
    id: boardId,
    workspaceId: "w",
    name: boardId,
    sortOrder: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    whiteboard,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  nodes: [],
  edges: [],
});
const withItem = JSON.stringify({
  ...emptyWhiteboard(),
  items: [
    {
      id: "i1",
      kind: "text",
      text: "限流",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      z: 0,
      style: { color: "black", size: "m" },
    },
  ],
});

describe("gotoItem", () => {
  const centered: string[] = [];
  const listener = (event: Event) =>
    centered.push((event as CustomEvent<{ nodeId: string }>).detail.nodeId);

  beforeEach(() => {
    vi.useFakeTimers();
    centered.length = 0;
    window.addEventListener(CENTER_NODE_EVENT, listener);
    useCanvasStore.getState().setDocument(documentOf("b1", withItem));
  });
  afterEach(() => {
    window.removeEventListener(CENTER_NODE_EVENT, listener);
    vi.useRealTimers();
  });

  it("同一块画布：选中白板对象（清掉节点选区）并按重试表居中", () => {
    useCanvasStore.getState().setSelection({ nodes: [], items: [] });
    gotoItem("b1", "wb:i1");
    expect(useCanvasStore.getState().selectedItemIds).toEqual(["wb:i1"]);
    expect(centered).toEqual(["wb:i1"]);
    vi.advanceTimersByTime(Math.max(...CENTER_RETRY_DELAYS));
    expect(centered).toHaveLength(CENTER_RETRY_DELAYS.length);
  });

  it("别的画布：先切板，文档到位后再选中并居中", () => {
    gotoItem("b2", "wb:i1");
    expect(useCanvasStore.getState().boardId).toBe("b2");
    expect(centered).toEqual([]);
    useCanvasStore.getState().setDocument(documentOf("b2", withItem));
    expect(useCanvasStore.getState().selectedItemIds).toEqual(["wb:i1"]);
    expect(centered).toEqual(["wb:i1"]);
  });
});
