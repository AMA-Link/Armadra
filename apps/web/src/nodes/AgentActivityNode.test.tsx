import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

const terminal = {
  id: "33333333-3333-4333-8333-333333333333",
  boardId: "b1",
  type: "terminal",
  title: "Claude",
  color: "#0a84ff",
  position: { x: 0, y: 0 },
  labels: [],
  note: "",
  data: { kind: "terminal" },
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
} as unknown as CanvasNode;

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[] },
  focusNodeId: null as string | null,
  maximized: {} as Record<string, unknown>,
  workspace: { id: "workspace-1", rootPath: "/tmp" },
  selectNodes: vi.fn(),
  updateNode: vi.fn(),
  updateNodeData: vi.fn(),
  setCollapsed: vi.fn(),
  maximizeNode: vi.fn(),
  restoreNode: vi.fn(),
  removeNodes: vi.fn(),
  resizeNode: vi.fn(),
  addNode: vi.fn(),
}));

const agent = vi.hoisted(() => ({
  status: undefined as Record<string, unknown> | undefined,
  tree: null as unknown,
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});
vi.mock("@/agent/status-store", () => ({
  useAgentStatus: () => agent.status,
}));
vi.mock("@/agent/use-agent-tree", () => ({
  useAgentTree: () => agent.tree,
}));

import type { AgentTree as AgentTreeModel } from "@/agent/agent-tree-model";
import { AgentActivityNode } from "./AgentActivityNode";

const node = {
  id: "44444444-4444-4444-8444-444444444444",
  boardId: "b1",
  type: "agentActivity",
  title: "Claude",
  color: "#0a84ff",
  position: { x: 0, y: 0 },
  labels: [],
  note: "",
  data: {
    kind: "agentActivity",
    sourceNodeId: terminal.id,
    source: "loop",
    sessionId: "session-1",
    executionHostId: "",
    generation: 4,
    nativeJobId: "job-1",
  },
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
} as unknown as CanvasNode;

function renderCard(override: CanvasNode = node) {
  return render(
    <AgentActivityNode
      id={override.id}
      node={override}
      selected={false}
      collapsed={false}
      focused={false}
    />,
  );
}

const TREE: AgentTreeModel = {
  root: {
    id: terminal.id,
    label: "Claude",
    tone: "working",
    kind: "agent",
    hidden: 0,
    children: [
      {
        id: `${terminal.id}/card-1`,
        label: "评审改动",
        tone: "working",
        kind: "subagent",
        children: [],
        hidden: 0,
      },
    ],
  },
  summary: { total: 1, byTone: { working: 1 } },
};

beforeEach(() => {
  store.document.nodes = [terminal];
  agent.status = undefined;
  agent.tree = null;
});
afterEach(cleanup);

describe("agent activity card", () => {
  it("只剩状态信息：来源节点名 + StatusLine，没有任何按钮", () => {
    const { container } = renderCard();
    const card = container.querySelector("[data-slot=agent-activity-card]")!;
    expect(card.textContent).toContain("Claude");
    expect(card.querySelector("[data-slot=status-line]")).toBeTruthy();
    // 没有「转为平台计划」，也没有暂停 / 取消 / 说明文字
    expect(card.querySelector("button")).toBeNull();
    for (const text of [
      "转为平台计划",
      "已观察",
      "最近一次",
      "还没有观察到活动",
      "只读观察",
      "暂停",
      "立即运行",
    ])
      expect(screen.queryByText(new RegExp(text))).toBeNull();
  });

  it("StatusLine 与节点头、侧栏同一个 tone 与文案", () => {
    agent.status = {
      nodeId: terminal.id,
      workspaceId: "w",
      agentId: "claude",
      state: "blocked",
      pendingId: "p",
      unread: false,
      verified: true,
      restored: false,
      alive: true,
      updatedAt: "2026-09-05T00:00:00.000Z",
    };
    const { container } = renderCard();
    const line = container.querySelector("[data-slot=status-line]")!;
    expect(line.getAttribute("data-tone")).toBe("attention");
    expect(line.textContent).toContain("等待审批");
  });

  it("没有下级与卡片时不渲染 AgentTree", () => {
    const { container } = renderCard();
    expect(container.querySelector("[data-slot=agent-tree]")).toBeNull();
  });

  it("有下级时渲染 AgentTree md", () => {
    agent.tree = TREE;
    const { container } = renderCard();
    const tree = container.querySelector(
      "[data-slot=agent-tree][data-size=md]",
    );
    expect(tree).toBeTruthy();
    expect(screen.getByRole("tree")).toBeTruthy();
    expect(
      screen.getByRole("treeitem", { name: "评审改动 · 运行中" }),
    ).toBeTruthy();
  });

  it("来源节点已不在画布上：EmptyState，不画状态行", () => {
    store.document.nodes = [];
    const { container } = renderCard();
    expect(screen.getByText("被观察的节点已不在这块画布上")).toBeTruthy();
    expect(container.querySelector("[data-slot=status-line]")).toBeNull();
  });

  it("没有暂停或取消——隐藏它不会停下 CLI 自己的循环", () => {
    renderCard();
    for (const label of ["暂停", "立即运行", "启用"])
      expect(screen.queryByText(label)).toBeNull();
  });
});
