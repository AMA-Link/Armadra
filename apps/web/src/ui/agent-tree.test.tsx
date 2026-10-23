import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

import {
  agentTreeOf,
  type AgentTree,
  type AgentTreeDocument,
  type AgentTreeNode,
  limitLevels,
} from "@/agent/agent-tree-model";
import type { MirroredStatus } from "@/agent/status-store";
import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills } from "@/app/test-harness";
import {
  AgentTree as AgentTreeView,
  SM_MAX_HEIGHT,
  SM_MAX_WIDTH,
  layoutSm,
  shortLabel,
} from "@/ui/agent-tree";
import { TONE_COLOR } from "@/ui/status-pill";

beforeAll(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

function node(id: string, title = id) {
  return {
    id,
    title,
    data: { kind: "terminal", agent: { id: "claude" } },
  } as unknown as CanvasNode;
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
    updatedAt: "2026-10-23T10:00:00.000Z",
    ...extra,
  } as unknown as MirroredStatus;
}

/** a 盯着 ids；`states` 给每个下级一个状态。 */
function fan(
  ids: string[],
  states: Record<string, MirroredStatus> = {},
  extraEdges: Array<[string, string]> = [],
  extraNodes: string[] = [],
): AgentTree {
  const doc: AgentTreeDocument = {
    nodes: ["a", ...ids, ...extraNodes].map((id) => node(id)),
    edges: [
      ...ids.map((id) => ["a", id] as [string, string]),
      ...extraEdges,
    ].map(([source, target]) => ({
      source,
      target,
      role: "supervises" as const,
    })),
  };
  return agentTreeOf("a", doc, { a: status("working"), ...states }, {})!;
}

const MIXED = fan(["b", "c", "d"], {
  b: status("working"),
  c: status("working"),
  d: status("done", { errored: true, unread: true }),
});

function pulses(container: HTMLElement) {
  return container.querySelectorAll("[data-slot=agent-tree-pulse]");
}

describe("AgentTree sm", () => {
  it("role=img + 汇总 aria-label，整体一个焦点停留点", () => {
    render(<AgentTreeView tree={MIXED} size="sm" />);
    const host = screen.getByRole("img", {
      name: "3 个子 Agent，2 个运行中，1 个失败",
    });
    expect(host.getAttribute("tabindex")).toBe("0");
    // 里面的 svg 是装饰，不进读屏
    expect(host.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("英文汇总", () => {
    usePreferencesStore.setState({ locale: "en" });
    try {
      render(<AgentTreeView tree={MIXED} size="sm" />);
      expect(
        screen.getByRole("img", { name: "3 sub-agents, 2 running, 1 failed" }),
      ).toBeTruthy();
    } finally {
      usePreferencesStore.setState({ locale: "zh-CN" });
    }
  });

  it("尺寸不超过 96 × 48：一层、三层、超出 +k 都一样", () => {
    const deep = (() => {
      const ids = ["b", "c", "d", "e"];
      return fan(
        ids,
        {},
        [
          ["b", "b1"],
          ["b", "b2"],
          ["b", "b3"],
          ["b", "b4"],
          ["b", "b5"],
          ["b1", "z1"],
        ],
        ["b1", "b2", "b3", "b4", "b5", "z1"],
      );
    })();
    const wide = fan(Array.from({ length: 12 }, (_, i) => `n${i}`));
    for (const tree of [fan(["b"]), MIXED, deep, wide]) {
      const layout = layoutSm(limitLevels(tree.root, 5));
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.width).toBeLessThanOrEqual(SM_MAX_WIDTH);
      expect(layout.height).toBeLessThanOrEqual(SM_MAX_HEIGHT);
      const { container } = render(<AgentTreeView tree={tree} size="sm" />);
      const svg = container.querySelector("svg")!;
      expect(Number(svg.getAttribute("width"))).toBeLessThanOrEqual(96);
      expect(Number(svg.getAttribute("height"))).toBeLessThanOrEqual(48);
      cleanup();
    }
  });

  it("每层最多 5 格：超出的最后一格换成 +k", () => {
    const { container } = render(
      <AgentTreeView
        tree={fan(Array.from({ length: 8 }, (_, i) => `n${i}`))}
        size="sm"
      />,
    );
    // 根 + 4 个子节点，加一个 +4
    expect(
      container.querySelectorAll("[data-slot=agent-tree-node]"),
    ).toHaveLength(5);
    expect(
      container.querySelector("[data-slot=agent-tree-more]")?.textContent,
    ).toBe("+4");
  });

  it("三层封顶：末层有更深的下级时在方块右下角画一个 2px 点，汇总仍数全部", () => {
    const tree = fan(
      ["b"],
      {},
      [
        ["b", "c"],
        ["c", "d"],
      ],
      ["c", "d"],
    );
    const { container } = render(<AgentTreeView tree={tree} size="sm" />);
    expect(
      container.querySelectorAll("[data-slot=agent-tree-node]"),
    ).toHaveLength(3);
    const dot = container.querySelector("[data-slot=agent-tree-hidden]")!;
    expect(dot.getAttribute("width")).toBe("2");
    expect(screen.getByRole("img", { name: /^3 个子 Agent/ })).toBeTruthy();
  });

  it("idle 空心、failed / done 实心；working 与 attention 带呼吸外圈，其余没有", () => {
    const tree = fan(["b", "c", "d", "e"], {
      b: status("working"),
      c: status("done", { errored: true, unread: true }),
      d: status("blocked", { pendingId: "p" }),
    });
    const { container } = render(<AgentTreeView tree={tree} size="sm" />);
    const nodes = [
      ...container.querySelectorAll("[data-slot=agent-tree-node]"),
    ];
    const byTone = (tone: string) =>
      nodes.find((item) => item.getAttribute("data-tone") === tone)!;
    // idle：空心，1px --faint 边
    const idle = byTone("idle").querySelector("rect")!;
    expect(idle.getAttribute("fill")).toBe("none");
    expect(idle.getAttribute("stroke")).toBe("var(--faint)");
    // failed 实心
    expect(byTone("failed").querySelector("rect")!.getAttribute("fill")).toBe(
      TONE_COLOR.failed,
    );
    // 根（working）+ b（working）+ d（attention）有外圈，且带 anim-dot-pulse 与 motion-reduce 静止
    const rings = pulses(container);
    expect(rings).toHaveLength(3);
    for (const ring of rings) {
      expect(ring.getAttribute("class")).toContain("anim-dot-pulse");
      expect(ring.getAttribute("class")).toContain(
        "motion-reduce:animate-none",
      );
    }
    expect(
      byTone("failed").querySelector("[data-slot=agent-tree-pulse]"),
    ).toBeNull();
    expect(
      byTone("idle").querySelector("[data-slot=agent-tree-pulse]"),
    ).toBeNull();
  });

  it("全 idle：没有任何呼吸外圈", () => {
    const tree = agentTreeOf(
      "a",
      {
        nodes: [node("a"), node("b")],
        edges: [{ source: "a", target: "b", role: "supervises" }],
      },
      {},
      {},
    )!;
    const { container } = render(<AgentTreeView tree={tree} size="sm" />);
    expect(pulses(container)).toHaveLength(0);
  });

  it("连线都是 1px 实心矩形；多个子节点有分叉点", () => {
    const { container } = render(<AgentTreeView tree={MIXED} size="sm" />);
    const lines = [
      ...container.querySelectorAll("[data-slot=agent-tree-line]"),
    ];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const w = Number(line.getAttribute("width"));
      const h = Number(line.getAttribute("height"));
      expect(Math.min(w, h)).toBe(1);
      // 整数像素，不发虚
      expect(Number(line.getAttribute("x")) % 1).toBe(0);
      expect(Number(line.getAttribute("y")) % 1).toBe(0);
    }
    expect(
      container.querySelectorAll("[data-slot=agent-tree-joint]"),
    ).toHaveLength(1);
  });

  it("Tooltip：方块的提示是「名称 · 状态」", async () => {
    const { container } = render(<AgentTreeView tree={MIXED} size="sm" />);
    const failed = container.querySelector(
      "[data-slot=agent-tree-node][data-tone=failed]",
    )!;
    fireEvent.focus(failed);
    expect((await screen.findAllByText("d · 失败")).length).toBeGreaterThan(0);
  });
});

describe("AgentTree md", () => {
  const TREE = fan(
    ["b", "c"],
    {
      b: status("working"),
      c: status("done", { errored: true, unread: true }),
    },
    [
      ["b", "b1"],
      ["b", "b2"],
    ],
    ["b1", "b2"],
  );

  it("顶行是汇总；每个节点各自有 aria-label（名称 · 状态）", () => {
    render(<AgentTreeView tree={TREE} size="md" />);
    expect(
      screen.getByText("4 个子 Agent，1 个运行中，1 个失败，2 个空闲"),
    ).toBeTruthy();
    const tree = screen.getByRole("tree");
    expect(tree.getAttribute("aria-label")).toContain("4 个子 Agent");
    const items = screen.getAllByRole("treeitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "a · 运行中",
      "b · 运行中",
      "b1 · 空闲",
      "b2 · 空闲",
      "c · 失败",
    ]);
    expect(items.map((item) => item.getAttribute("aria-level"))).toEqual([
      "1",
      "2",
      "3",
      "3",
      "2",
    ]);
  });

  it("宽度上限 240，标签最多 8 个字", () => {
    const { container } = render(<AgentTreeView tree={TREE} size="md" />);
    const host = container.querySelector(
      "[data-slot=agent-tree][data-size=md]",
    ) as HTMLElement;
    expect(host.style.maxWidth).toBe("240px");
    expect(shortLabel("一二三四五六七八")).toBe("一二三四五六七八");
    expect(shortLabel("一二三四五六七八九")).toBe("一二三四五六七八…");
  });

  it("点父节点折叠成一行「名称 · +k」，再点展开；onToggle 通知", () => {
    const onToggle = vi.fn();
    render(<AgentTreeView tree={TREE} size="md" onToggle={onToggle} />);
    const b = screen.getByRole("treeitem", { name: "b · 运行中" });
    fireEvent.click(b);
    expect(onToggle).toHaveBeenLastCalledWith("b", true);
    expect(screen.queryByRole("treeitem", { name: /^b1/ })).toBeNull();
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
    const folded = screen.getByRole("treeitem", { name: "b · 运行中" });
    expect(folded.getAttribute("aria-expanded")).toBe("false");
    expect(folded.textContent).toContain("· +2");
    fireEvent.click(folded);
    expect(onToggle).toHaveBeenLastCalledWith("b", false);
    expect(screen.getAllByRole("treeitem")).toHaveLength(5);
  });

  it("defaultCollapsed 一开始就折叠", () => {
    render(<AgentTreeView tree={TREE} size="md" defaultCollapsed={["b"]} />);
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });

  it("roving：Tab 只停在一个节点上，↑↓ 移动，回车折叠", () => {
    render(<AgentTreeView tree={TREE} size="md" />);
    const items = screen.getAllByRole("treeitem");
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    items[0]!.focus();
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "Enter" });
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });

  it("每层最多 8 个：超出的一行 +k", () => {
    const wide = fan(Array.from({ length: 11 }, (_, i) => `n${i}`));
    const { container } = render(<AgentTreeView tree={wide} size="md" />);
    expect(screen.getAllByRole("treeitem")).toHaveLength(1 + 7);
    expect(
      container.querySelector("[data-slot=agent-tree-more]")?.textContent,
    ).toBe("+4");
  });

  it("working 方块带呼吸外圈，idle 空心", () => {
    const { container } = render(<AgentTreeView tree={TREE} size="md" />);
    expect(pulses(container).length).toBe(2); // a、b
    const idle = container.querySelector(
      "[data-slot=agent-tree-square][data-tone=idle]",
    ) as HTMLElement;
    expect(idle.style.border).toContain("var(--faint)");
  });
});

describe("工具", () => {
  it("root 的类型只在测试里用到：AgentTreeNode 的 kind", () => {
    const sample: AgentTreeNode = {
      id: "x",
      label: "x",
      tone: "idle",
      kind: "agent",
      children: [],
      hidden: 0,
    };
    expect(sample.kind).toBe("agent");
  });
});
