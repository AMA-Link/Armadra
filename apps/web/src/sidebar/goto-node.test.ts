import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardDocument } from "@armadra/shared";

import { CENTER_NODE_EVENT } from "../canvas/flow/flow-context";
import { emptyWhiteboard } from "../canvas/whiteboard/model";
import { serializeWhiteboard } from "../canvas/whiteboard/serialize";
import { useCanvasStore } from "../store/canvas-store";
import { GOTO_TIMEOUT_MS, gotoItem } from "./goto-node";

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
const withItem = serializeWhiteboard({
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

  it("同一块画布：选中白板对象（清掉节点选区）并发一次居中，重试归相机意图", () => {
    useCanvasStore.getState().setSelection({ nodes: [], items: [] });
    gotoItem("b1", "wb:i1");
    expect(useCanvasStore.getState().selectedItemIds).toEqual(["wb:i1"]);
    expect(centered).toEqual(["wb:i1"]);
    vi.advanceTimersByTime(5_000);
    expect(centered).toEqual(["wb:i1"]);
    // 不留任何计时器：卸载之后没有迟到的居中（#1007）。
    expect(vi.getTimerCount()).toBe(0);
  });

  it("连点两行：旧的等待被取消，只有最后一行落地（#1028）", () => {
    gotoItem("b2", "wb:i1");
    gotoItem("b3", "wb:i1");
    useCanvasStore.getState().setDocument(documentOf("b2", withItem));
    expect(centered).toEqual([]);
    useCanvasStore.getState().setDocument(documentOf("b3", withItem));
    expect(centered).toEqual(["wb:i1"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("等不到文档就在超时后放弃，不留计时器与监听", () => {
    gotoItem("b2", "wb:i1");
    vi.advanceTimersByTime(GOTO_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
    useCanvasStore.getState().setDocument(documentOf("b2", withItem));
    expect(centered).toEqual([]);
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
