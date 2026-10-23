import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@armadra/shared";

import { t } from "../app/preferences-store";
import {
  AGENT_TREE_CARD_LIMIT,
  agentTreeOf,
  limitLevels,
  nodeLabel,
  summaryLabel,
  type AgentTreeDocument,
  type AgentTreeNode,
} from "./agent-tree-model";
import { displayOfStatus } from "./display";
import type { MirroredStatus } from "./status-store";
import type { SubagentCardModel } from "./subagent-store";
import { usePreferencesStore } from "../app/preferences-store";

const AT = "2026-10-23T10:00:00.000Z";

function node(id: string, title = id): AgentTreeDocument["nodes"][number] {
  return {
    id,
    title,
    data: { kind: "terminal", agent: { id: "claude" } },
  } as unknown as CanvasNode;
}

function supervises(source: string, target: string) {
  return { source, target, role: "supervises" } as const;
}

function status(state: string, extra: Partial<MirroredStatus> = {}) {
  return {
    nodeId: "x",
    workspaceId: "w",
    agentId: "claude",
    state,
    unread: false,
    verified: true,
    restored: false,
    alive: true,
    updatedAt: AT,
    ...extra,
  } as unknown as MirroredStatus;
}

function card(
  parentId: string,
  id: string,
  state: "working" | "done" = "working",
): SubagentCardModel {
  return { id, parentId, taskLabel: `task-${id}`, startedAt: 1, state };
}

function labels(root: AgentTreeNode): string[] {
  return [root.id, ...root.children.flatMap(labels)];
}

describe("agentTreeOf", () => {
  it("没有下级也没有卡片：返回 null；根不在画布上也是 null", () => {
    const doc = { nodes: [node("a"), node("b")], edges: [] };
    expect(agentTreeOf("a", doc, {}, {})).toBeNull();
    expect(agentTreeOf("missing", doc, {}, {})).toBeNull();
    expect(agentTreeOf("a", null, {}, {})).toBeNull();
    // 只有一条指向不存在节点的边：跳过，仍是 null
    expect(
      agentTreeOf(
        "a",
        { nodes: [node("a")], edges: [supervises("a", "gone")] },
        {},
        {},
      ),
    ).toBeNull();
  });

  it("supervises 边展开下级，tone 经 displayOfStatus；其他角色的边不算", () => {
    const doc = {
      nodes: [node("a", "ama"), node("b", "写"), node("c", "审")],
      edges: [
        supervises("a", "b"),
        supervises("a", "c"),
        { source: "b", target: "c", role: "reference" },
      ] as unknown as AgentTreeDocument["edges"],
    };
    const statuses = {
      a: status("working"),
      b: status("working"),
      c: status("done", { errored: true, unread: true }),
    };
    const tree = agentTreeOf("a", doc, statuses, {})!;
    expect(tree.root.label).toBe("ama");
    expect(tree.root.tone).toBe(displayOfStatus(statuses.a).tone);
    expect(tree.root.children.map((child) => child.label)).toEqual([
      "写",
      "审",
    ]);
    expect(tree.root.children.map((child) => child.tone)).toEqual([
      "working",
      "failed",
    ]);
    expect(tree.summary).toEqual({
      total: 2,
      byTone: { working: 1, failed: 1 },
    });
  });

  it("根不在当前画布上：给了名称就只用它自己的子代理卡片成树", () => {
    const doc = { nodes: [node("a")], edges: [] };
    expect(agentTreeOf("far", doc, {}, { far: [card("far", "1")] })).toBeNull();
    const tree = agentTreeOf(
      "far",
      doc,
      { far: status("working") },
      { far: [card("far", "1")] },
      "远端节点",
    )!;
    expect(tree.root.label).toBe("远端节点");
    expect(tree.root.tone).toBe("working");
    expect(tree.root.children).toHaveLength(1);
    expect(agentTreeOf("far", null, {}, {}, "远端节点")).toBeNull();
  });

  it("节点有 handle 时用 handle", () => {
    const named = {
      id: "b",
      title: "标题",
      data: { kind: "terminal", handle: "reviewer" },
    } as unknown as CanvasNode;
    const tree = agentTreeOf(
      "a",
      { nodes: [node("a"), named], edges: [supervises("a", "b")] },
      {},
      {},
    )!;
    expect(tree.root.children[0]?.label).toBe("reviewer");
  });

  it("卡片挂在父节点下做叶：working / done，kind 为 subagent，没有状态也不影响", () => {
    const doc = { nodes: [node("a")], edges: [] };
    const tree = agentTreeOf(
      "a",
      doc,
      {},
      { a: [card("a", "1"), card("a", "2", "done")] },
    )!;
    expect(
      tree.root.children.map((child) => [child.kind, child.tone, child.label]),
    ).toEqual([
      ["subagent", "working", "task-1"],
      ["subagent", "done", "task-2"],
    ]);
    expect(tree.root.tone).toBe("idle");
    expect(tree.summary.byTone).toEqual({ working: 1, done: 1 });
  });

  it("卡片上限 8：只取最近的 8 张", () => {
    const cards = Array.from({ length: 11 }, (_, index) =>
      card("a", String(index)),
    );
    const tree = agentTreeOf(
      "a",
      { nodes: [node("a")], edges: [] },
      {},
      { a: cards },
    )!;
    expect(tree.root.children).toHaveLength(AGENT_TREE_CARD_LIMIT);
    expect(tree.root.children[0]?.label).toBe("task-3");
  });

  it("第一条上级边赢：被两个上级盯着的节点只挂在第一个下面", () => {
    const doc = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [supervises("a", "b"), supervises("a", "c"), supervises("b", "c")],
    };
    const tree = agentTreeOf("a", doc, {}, {})!;
    expect(labels(tree.root)).toEqual(["a", "b", "c"]);
    expect(tree.root.children[0]?.children).toEqual([]);
    expect(tree.summary.total).toBe(2);
  });

  it("环路截断：a → b → a 不会无限展开，根也不会重复出现", () => {
    const doc = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [supervises("a", "b"), supervises("b", "c"), supervises("c", "a")],
    };
    const tree = agentTreeOf("a", doc, {}, {})!;
    expect(labels(tree.root)).toEqual(["a", "b", "c"]);
    expect(tree.summary.total).toBe(2);
  });

  it("上级是已不在画布上的节点：不凭空出现", () => {
    const doc = {
      nodes: [node("a"), node("b")],
      edges: [supervises("ghost", "b"), supervises("a", "b")],
    };
    // b 的第一条上级边来自 ghost：不挂在 a 下面（与 supervisionFor 同一规则）
    expect(agentTreeOf("a", doc, {}, {})).toBeNull();
  });

  it("深度截断：只画根 + 2 层，末层记 hidden，汇总仍覆盖全部下级", () => {
    const doc = {
      nodes: ["a", "b", "c", "d", "e"].map((id) => node(id)),
      edges: [
        supervises("a", "b"),
        supervises("b", "c"),
        supervises("c", "d"),
        supervises("d", "e"),
      ],
    };
    const tree = agentTreeOf(
      "a",
      doc,
      { e: status("working") },
      { d: [card("d", "k")] },
    )!;
    const [b] = tree.root.children;
    const [c] = b!.children;
    expect(labels(tree.root)).toEqual(["a", "b", "c"]);
    expect(c?.children).toEqual([]);
    // c 下面还有 d、e、卡片 k
    expect(c?.hidden).toBe(3);
    expect(b?.hidden).toBe(0);
    expect(tree.summary.total).toBe(5);
    expect(tree.summary.byTone.working).toBe(2);
  });
});

describe("limitLevels（每层截断 +k）", () => {
  const flat = (count: number) => {
    const ids = Array.from({ length: count }, (_, index) => `n${index}`);
    return agentTreeOf(
      "a",
      {
        nodes: [node("a"), ...ids.map((id) => node(id))],
        edges: ids.map((id) => supervises("a", id)),
      },
      {},
      {},
    )!;
  };

  it("不超过上限：全画，没有 +k", () => {
    const levels = limitLevels(flat(5).root, 5);
    expect(levels).toHaveLength(2);
    expect(levels[1]?.nodes).toHaveLength(5);
    expect(levels[1]?.overflow).toBe(0);
  });

  it("超出：画前 cap-1 个，最后一格是 +k", () => {
    const levels = limitLevels(flat(7).root, 5);
    expect(levels[1]?.nodes.map((n) => n.id)).toEqual(["n0", "n1", "n2", "n3"]);
    expect(levels[1]?.overflow).toBe(3);
    expect(limitLevels(flat(10).root, 8)[1]?.overflow).toBe(3);
  });

  it("下一层只从画出来的节点往下取，+k 把被截掉的也算进去", () => {
    const ids = ["n0", "n1", "n2", "n3", "n4", "n5"];
    const tree = agentTreeOf(
      "a",
      {
        nodes: [
          node("a"),
          ...ids.map((id) => node(id)),
          node("g0"),
          node("g5"),
        ],
        edges: [
          ...ids.map((id) => supervises("a", id)),
          supervises("n0", "g0"),
          supervises("n5", "g5"),
        ],
      },
      {},
      {},
    )!;
    const levels = limitLevels(tree.root, 5);
    expect(levels[1]?.nodes).toHaveLength(4);
    expect(levels[2]?.nodes.map((n) => n.id)).toEqual(["g0"]);
    // g5 挂在被截掉的 n5 下面：算进第二层的 +k
    expect(levels[2]?.overflow).toBe(1);
  });
});

describe("文案", () => {
  const doc = {
    nodes: [node("a"), node("b", "审"), node("c", "写"), node("d", "测")],
    edges: [supervises("a", "b"), supervises("a", "c"), supervises("a", "d")],
  };
  const statuses = {
    b: status("working"),
    c: status("working"),
    d: status("done", { errored: true, unread: true }),
  };

  it("中文汇总：3 个子 Agent，2 个运行中，1 个失败", () => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    const tree = agentTreeOf("a", doc, statuses, {})!;
    expect(summaryLabel(tree, t)).toBe("3 个子 Agent，2 个运行中，1 个失败");
    expect(nodeLabel(tree.root.children[2]!, t)).toBe("测 · 失败");
  });

  it("英文汇总，一个下级用单数", () => {
    usePreferencesStore.setState({ locale: "en" });
    try {
      const tree = agentTreeOf("a", doc, statuses, {})!;
      expect(summaryLabel(tree, t)).toBe("3 sub-agents, 2 running, 1 failed");
      expect(nodeLabel(tree.root.children[0]!, t)).toBe("审 · Running");
      const one = agentTreeOf(
        "a",
        { nodes: [node("a"), node("b")], edges: [supervises("a", "b")] },
        {},
        {},
      )!;
      expect(summaryLabel(one, t)).toBe("1 sub-agent, 1 idle");
    } finally {
      usePreferencesStore.setState({ locale: "zh-CN" });
    }
  });
});
