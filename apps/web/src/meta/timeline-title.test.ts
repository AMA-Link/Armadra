import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { forgetAutoTitle, isAutoTitled } from "./auto-title";
import { applyTimelineTitle } from "./timeline-title";

const NODE_ID = "11111111-2222-4333-8444-555555555555";

function seed(title: string, type: "terminal" | "sticky" = "terminal") {
  const node = {
    id: NODE_ID,
    type,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    title,
    data: { kind: type, agent: { id: "claude" } },
  } as unknown as CanvasNode;
  useCanvasStore.setState({ document: { nodes: [node], edges: [] } } as never);
}

const updateNode = vi.fn((id: string, patch: { title?: string }) => {
  const state = useCanvasStore.getState();
  useCanvasStore.setState({
    document: {
      ...state.document,
      nodes: state.document?.nodes.map((node) =>
        node.id === id ? { ...node, ...patch } : node,
      ),
    },
  } as never);
});

const titleNow = () => useCanvasStore.getState().document?.nodes[0]?.title;

beforeEach(() => {
  forgetAutoTitle(NODE_ID);
  updateNode.mockClear();
  usePreferencesStore.setState({ autoTitle: true, locale: "zh-CN" });
  useCanvasStore.setState({ updateNode } as never);
});

describe("timeline head title as node name", () => {
  it("names a node that has no manual name, and follows later title changes", () => {
    seed("Claude Code");
    expect(applyTimelineTitle(NODE_ID, "修复导出")).toBe(true);
    expect(titleNow()).toBe("修复导出");
    expect(isAutoTitled(NODE_ID, "修复导出")).toBe(true);
    expect(applyTimelineTitle(NODE_ID, "修复导出并补测试")).toBe(true);
    expect(titleNow()).toBe("修复导出并补测试");
  });

  it("stops once a person renames the node", () => {
    seed("Claude Code");
    applyTimelineTitle(NODE_ID, "修复导出");
    useCanvasStore.getState().updateNode(NODE_ID, { title: "我的名字" });
    updateNode.mockClear();
    expect(applyTimelineTitle(NODE_ID, "新的标题")).toBe(false);
    expect(updateNode).not.toHaveBeenCalled();
    expect(titleNow()).toBe("我的名字");
  });

  it("leaves a manually named node alone from the start", () => {
    seed("重构导出流程");
    expect(applyTimelineTitle(NODE_ID, "修复导出")).toBe(false);
    expect(titleNow()).toBe("重构导出流程");
  });

  it("ignores an empty or blank title", () => {
    seed("Claude Code");
    expect(applyTimelineTitle(NODE_ID, "")).toBe(false);
    expect(applyTimelineTitle(NODE_ID, "  \n ")).toBe(false);
    expect(applyTimelineTitle(NODE_ID, undefined)).toBe(false);
    expect(applyTimelineTitle(NODE_ID, null)).toBe(false);
    expect(updateNode).not.toHaveBeenCalled();
  });

  it("is idempotent: the same title writes once", () => {
    seed("Claude Code");
    expect(applyTimelineTitle(NODE_ID, "修复导出")).toBe(true);
    expect(applyTimelineTitle(NODE_ID, "修复导出")).toBe(false);
    expect(applyTimelineTitle(NODE_ID, " 修复导出 ")).toBe(false);
    expect(updateNode).toHaveBeenCalledTimes(1);
  });

  it("does nothing when auto naming is off, or for other node types", () => {
    seed("Claude Code");
    usePreferencesStore.setState({ autoTitle: false });
    expect(applyTimelineTitle(NODE_ID, "修复导出")).toBe(false);
    usePreferencesStore.setState({ autoTitle: true });
    seed("Claude Code", "sticky");
    expect(applyTimelineTitle(NODE_ID, "修复导出")).toBe(false);
    expect(updateNode).not.toHaveBeenCalled();
  });
});
