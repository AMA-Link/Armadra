import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import type { AgentTree as AgentTreeModel } from "@/agent/agent-tree-model";

const agent = vi.hoisted(() => ({ tree: null as unknown }));
vi.mock("@/agent/use-agent-tree", () => ({
  useAgentTree: () => agent.tree,
}));

import { NodeStatusPopover } from "./NodeStatusPopover";

const TREE: AgentTreeModel = {
  root: {
    id: "n1",
    label: "Claude",
    tone: "working",
    kind: "agent",
    hidden: 0,
    children: [
      {
        id: "n1/card-1",
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

afterEach(() => {
  cleanup();
  agent.tree = null;
});

describe("节点头状态弹层", () => {
  it("没有 line 时退回头部的 tone 与文案；没有下级不画树", () => {
    const { container } = render(
      <NodeStatusPopover
        nodeId="n1"
        status={{ tone: "failed", label: "已退出 1" }}
      />,
    );
    const line = container.querySelector("[data-slot=status-line]");
    expect(line?.textContent).toContain("已退出 1");
    expect(container.querySelector("[data-slot=agent-tree]")).toBeNull();
  });

  it("有 line 时画阶段 · 细节，有下级时画 AgentTree md", () => {
    agent.tree = TREE;
    const { container } = render(
      <NodeStatusPopover
        nodeId="n1"
        status={{ tone: "working", label: "运行中" }}
        line={{
          tone: "working",
          phaseLabel: "运行中",
          detail: "npm test",
          since: undefined,
          spinning: true,
        }}
      />,
    );
    const line = container.querySelector("[data-slot=status-line]");
    expect(line?.textContent).toContain("运行中");
    expect(line?.textContent).toContain("npm test");
    const tree = container.querySelector("[data-slot=agent-tree]");
    expect(tree).toBeTruthy();
    expect(tree?.getAttribute("data-size")).toBe("md");
  });
});
