import type { CanvasNode } from "@armadra/shared";

import {
  agentTreeOf,
  type AgentTree,
  type AgentTreeDocument,
} from "@/agent/agent-tree-model";
import type { SessionRow } from "@/agent/sessions";
import type { MirroredStatus } from "@/agent/status-store";
import type { SubagentCardModel } from "@/agent/subagent-store";
import type { NeedItem } from "@/notifications/needs";
import type { StatusTone } from "@/ui/status-pill";

/**
 * `status` 分区的假数据（设计展示页 §2.1，设计系统 §11.1）：每个 tone 对应的状态镜像、
 * 缩略 Agent 树的五种夹具，以及活动卡 / 子代理卡 / 会话行 / 通知行的四种状态。
 * 纯对象；节点名是用户内容，所以不进 i18n。
 */

export const TONES: readonly StatusTone[] = [
  "working",
  "attention",
  "failed",
  "queued",
  "paused",
  "unread",
  "idle",
  "done",
];

const AT = "2026-10-23T10:00:00.000Z";
const BOARD = "00000000-0000-4000-8000-0000000000d0";

/** 经 `sessionDisplay` 恰好得到这个 tone 的状态镜像；`idle` 没有上报。 */
export function mirroredFor(
  nodeId: string,
  tone: StatusTone,
): MirroredStatus | undefined {
  const base = {
    nodeId,
    workspaceId: "showcase",
    agentId: "claude",
    unread: false,
    verified: true,
    restored: false,
    alive: true,
    updatedAt: AT,
  };
  switch (tone) {
    case "working":
      return { ...base, state: "working" } as MirroredStatus;
    case "attention":
      return { ...base, state: "blocked", pendingId: "p1" } as MirroredStatus;
    case "failed":
      return { ...base, state: "done", errored: true } as MirroredStatus;
    case "paused":
      return { ...base, state: "done", interrupted: true } as MirroredStatus;
    case "unread":
      return { ...base, state: "done", unread: true } as MirroredStatus;
    case "done":
      return { ...base, state: "done" } as MirroredStatus;
    case "queued":
      return {
        ...base,
        activity: { phase: "starting", since: Date.now(), rev: "b:1" },
      } as MirroredStatus;
    case "idle":
      return undefined;
  }
}

/* ------------------------------ Agent 树夹具 ------------------------------ */

interface Spec {
  id: string;
  title: string;
  tone: StatusTone;
  children?: readonly Spec[];
  /** 这个节点的子代理卡片：任务名与状态。 */
  cards?: ReadonlyArray<{ label: string; state: "working" | "done" }>;
}

function terminal(spec: Spec): CanvasNode {
  return {
    id: spec.id,
    boardId: BOARD,
    type: "terminal",
    title: spec.title,
    color: "#0a84ff",
    labels: [],
    note: "",
    position: { x: 0, y: 0 },
    data: { kind: "terminal", agent: { id: "claude" } },
    createdAt: AT,
    updatedAt: AT,
  } as CanvasNode;
}

export interface StatusWorld {
  nodes: CanvasNode[];
  edges: AgentTreeDocument["edges"];
  statuses: Record<string, MirroredStatus>;
  cards: Record<string, SubagentCardModel[]>;
}

/** 把一棵规格树摊成画布文档（节点 + `supervises` 边）、状态镜像与子代理卡片。 */
export function worldOf(root: Spec): StatusWorld {
  const nodes: CanvasNode[] = [];
  const edges: Array<{ source: string; target: string; role: "supervises" }> =
    [];
  const statuses: StatusWorld["statuses"] = {};
  const cards: StatusWorld["cards"] = {};
  const walk = (spec: Spec) => {
    nodes.push(terminal(spec));
    const status = mirroredFor(spec.id, spec.tone);
    if (status) statuses[spec.id] = status;
    if (spec.cards)
      cards[spec.id] = spec.cards.map((card, index) => ({
        id: `${spec.id}-card-${index}`,
        parentId: spec.id,
        taskLabel: card.label,
        startedAt: Date.now() - 20_000,
        state: card.state,
      }));
    for (const child of spec.children ?? []) {
      edges.push({ source: spec.id, target: child.id, role: "supervises" });
      walk(child);
    }
  };
  walk(root);
  return { nodes, edges, statuses, cards };
}

export function treeOfSpec(root: Spec): AgentTree {
  const world = worldOf(root);
  return agentTreeOf(
    root.id,
    { nodes: world.nodes, edges: world.edges },
    world.statuses,
    world.cards,
  )!;
}

const leaf = (id: string, tone: StatusTone): Spec => ({
  id,
  title: id,
  tone,
});

/** 五种夹具：1 层 / 3 层 / 超出 +k / 全 idle / 混合 tone。 */
export const TREE_FIXTURES: ReadonlyArray<{ name: string; tree: AgentTree }> = [
  {
    name: "tree · one level",
    tree: treeOfSpec({
      id: "ama",
      title: "ama",
      tone: "working",
      children: [leaf("claude", "working"), leaf("codex", "done")],
    }),
  },
  {
    name: "tree · three levels",
    tree: treeOfSpec({
      id: "ama",
      title: "ama",
      tone: "working",
      children: [
        {
          id: "claude",
          title: "claude",
          tone: "working",
          children: [
            leaf("explore", "attention"),
            { ...leaf("review", "idle"), children: [leaf("deep", "working")] },
          ],
        },
        {
          id: "codex",
          title: "codex",
          tone: "failed",
          cards: [{ label: "补测试", state: "done" }],
        },
      ],
    }),
  },
  {
    name: "tree · overflow +k",
    tree: treeOfSpec({
      id: "ama",
      title: "ama",
      tone: "working",
      children: Array.from({ length: 11 }, (_, index) =>
        leaf(`worker-${index + 1}`, index % 3 === 0 ? "working" : "done"),
      ),
    }),
  },
  {
    name: "tree · all idle",
    tree: treeOfSpec({
      id: "ama",
      title: "ama",
      tone: "idle",
      children: [
        leaf("claude", "idle"),
        leaf("codex", "idle"),
        leaf("pi", "idle"),
      ],
    }),
  },
  {
    name: "tree · mixed tones",
    tree: treeOfSpec({
      id: "ama",
      title: "ama",
      tone: "attention",
      children: [
        leaf("working", "working"),
        leaf("attention", "attention"),
        leaf("failed", "failed"),
        leaf("queued", "queued"),
        leaf("paused", "paused"),
        leaf("done", "done"),
      ],
    }),
  },
];

/* ------------------------------ 四种状态样本 ------------------------------ */

const SOURCE = "00000000-0000-4000-8000-0000000000d1";

/** 活动卡 / 通知行读的世界：ama 盯着两个成员，自己还有两张子代理卡片。 */
export const ACTIVITY_WORLD = worldOf({
  id: SOURCE,
  title: "ama",
  tone: "working",
  children: [leaf("codex", "working"), leaf("claude", "failed")],
  cards: [
    { label: "审查 src/x", state: "done" },
    { label: "整理 changelog", state: "working" },
  ],
});

export const ACTIVITY_SOURCE = SOURCE;

export const ACTIVITY_NODE = {
  id: "00000000-0000-4000-8000-0000000000d2",
  boardId: BOARD,
  type: "agentActivity",
  title: "ama",
  color: "#0a84ff",
  labels: [],
  note: "",
  position: { x: 0, y: 0 },
  size: { width: 300, height: 232 },
  data: {
    kind: "agentActivity",
    sourceNodeId: SOURCE,
    source: "loop",
    sessionId: "session-1",
    executionHostId: "",
    generation: 1,
    nativeJobId: "job-1",
  },
  createdAt: AT,
  updatedAt: AT,
} as unknown as CanvasNode;

/** 子代理卡：运行中、已完成（带用量与结果）、已完成（没有用量）。 */
export const SUBAGENT_CARDS: readonly SubagentCardModel[] = [
  {
    id: "c1",
    parentId: SOURCE,
    type: "Explore",
    taskLabel: "整理 changelog",
    startedAt: Date.now() - 42_000,
    state: "working",
  },
  {
    id: "c2",
    parentId: SOURCE,
    taskLabel: "审查 src/x",
    startedAt: Date.now() - 200_000,
    state: "done",
    durationMs: 184_000,
    tokens: 1234,
    toolUses: 3,
    result: "两处需要改：src/x/store.ts:42、src/x/sync.ts:118。",
  },
  {
    id: "c3",
    parentId: SOURCE,
    taskLabel: "跑一遍测试",
    startedAt: Date.now() - 90_000,
    state: "done",
    durationMs: 61_000,
  },
];

function sessionRow(title: string, patch: Partial<SessionRow>): SessionRow {
  return {
    nodeId: `node-${title}`,
    boardId: BOARD,
    sessionId: `session-${title}`,
    title,
    cwd: "/repo/apps/web",
    agentId: "claude",
    unread: false,
    updatedAt: AT,
    alive: true,
    sinceMs: 95_000,
    ...patch,
  };
}

/** 会话行：需要你 / 运行中 / 未读 / 失败 / 空闲。 */
export const SESSION_ROWS: readonly SessionRow[] = [
  sessionRow("登录修复", { state: "blocked", pendingId: "p1" }),
  sessionRow("接口重构", { state: "working", agentId: "codex" }),
  sessionRow("补充测试", { state: "done", unread: true, sinceMs: 600_000 }),
  sessionRow("文档", {
    state: "done",
    errored: true,
    agentId: "pi",
    sinceMs: 3_600_000,
  }),
  sessionRow("旧终端", { agentId: "opencode", sinceMs: 7_200_000 }),
];

/** 通知行：有下级（读画布与子代理卡片）与没有下级的两条。 */
export const NEED_ITEMS: readonly NeedItem[] = [
  {
    key: "showcase:ama",
    workspaceId: "showcase",
    boardId: BOARD,
    nodeId: SOURCE,
    title: "审查 src/x 与 src/y",
    need: "approval",
    updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    sessionId: "session-ama",
  },
  {
    key: "showcase:claude",
    workspaceId: "showcase",
    boardId: BOARD,
    nodeId: "00000000-0000-4000-8000-0000000000d3",
    title: "整理发布说明",
    need: "input",
    updatedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    sessionId: "session-claude",
  },
  {
    key: "showcase:codex",
    workspaceId: "showcase",
    boardId: BOARD,
    nodeId: "00000000-0000-4000-8000-0000000000d4",
    title: "性能回归",
    need: "error",
    updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  },
];
