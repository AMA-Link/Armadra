/**
 * 缩略 Agent 树的数据（设计系统 §11.1）：谁派了谁、各自什么状态，别的不放。
 *
 * 纯函数，没有 store 也没有 React；数据只来自三处，不编造：
 *
 *  - 画布上 `supervises` 边（读法与 `canvas/supervision.ts` 一致：第一条上级边赢、
 *    环路截断、已不在画布上的节点跳过）；
 *  - 每个 Agent 节点的状态镜像（经 `displayOfStatus` 取 tone，和节点头、侧栏同一个答案）；
 *  - 每个节点的子代理临时卡片（`working → working`、`done → done`）。
 *
 * 没有任何下级（既没有被盯着的节点也没有子代理卡片）时返回 `null`，调用方不渲染。
 * 输出最多三层（根 + 2），更深的在末层节点上记 `hidden`；汇总数覆盖全部可达的
 * 下级，不因展示截断而变少。
 */
import type { CanvasEdge, CanvasNode, StatusTone } from "@armadra/shared";

import type { Translate } from "../app/preferences-store";
import { displayNameOf } from "../canvas/supervision";
import { displayOfStatus } from "./display";
import type { MirroredStatus } from "./status-store";
import type { SubagentCardModel } from "./subagent-store";

/** 展示的层数（根 + 2）。再深的下级折成末层节点的 `hidden`。 */
export const AGENT_TREE_MAX_DEPTH = 3;
/** 每个节点最多挂几张子代理卡片（与 `subagent-store` 的上限一致）。 */
export const AGENT_TREE_CARD_LIMIT = 8;
/** 每层最多画几格：sm 5、md 8；超出的最后一格换成 `+k`。 */
export const AGENT_TREE_LEVEL_CAP = { sm: 5, md: 8 } as const;

export interface AgentTreeNode {
  /** Agent 节点是画布节点 id；子代理卡片是 `父节点 id/卡片 id`。 */
  id: string;
  /** 名称：Agent 取 handle / 标题，卡片取任务名。 */
  label: string;
  tone: StatusTone;
  kind: "agent" | "subagent";
  children: AgentTreeNode[];
  /** 深度截断：这个节点下面还有多少个没画出来的下级。 */
  hidden: number;
}

export interface AgentTreeSummary {
  /** 全部可达下级的个数（不含根）。 */
  total: number;
  /** 各 tone 的下级个数（不含根），只列非零的。 */
  byTone: Partial<Record<StatusTone, number>>;
}

export interface AgentTree {
  root: AgentTreeNode;
  summary: AgentTreeSummary;
}

/** 只读这几列：画布文档与测试夹具都满足。 */
export interface AgentTreeDocument {
  readonly nodes: readonly Pick<CanvasNode, "id" | "title" | "data">[];
  readonly edges: readonly Pick<CanvasEdge, "source" | "target" | "role">[];
}

/**
 * @param statuses 状态镜像，键是**节点 id**（不带来源前缀）
 * @param cards 子代理卡片，键是父节点 id
 * @param fallbackLabel 根不在当前画布上时的名称（通知面板里别的画布的节点）；
 *   给了就只用它自己的子代理卡片成树，没有边可读
 */
export function agentTreeOf(
  rootId: string,
  document: AgentTreeDocument | null | undefined,
  statuses: Readonly<Record<string, MirroredStatus | undefined>>,
  cards: Readonly<Record<string, readonly SubagentCardModel[] | undefined>>,
  fallbackLabel?: string,
): AgentTree | null {
  const byId = new Map((document?.nodes ?? []).map((node) => [node.id, node]));
  const rootNode = byId.get(rootId);
  if (!rootNode && fallbackLabel === undefined) return null;

  // 第一条上级边赢：一个节点只挂在它的第一个上级下面。
  const firstParent = new Map<string, string>();
  const subordinates = new Map<string, string[]>();
  for (const edge of document?.edges ?? []) {
    if (edge.role !== "supervises") continue;
    if (!firstParent.has(edge.target))
      firstParent.set(edge.target, edge.source);
    const list = subordinates.get(edge.source) ?? [];
    list.push(edge.target);
    subordinates.set(edge.source, list);
  }

  const seen = new Set<string>([rootId]);
  const toneOf = (id: string): StatusTone => displayOfStatus(statuses[id]).tone;

  const build = (id: string): AgentTreeNode => {
    const node = byId.get(id);
    const children: AgentTreeNode[] = [];
    for (const target of subordinates.get(id) ?? []) {
      if (seen.has(target)) continue; // 环路或重复边
      if (!byId.has(target)) continue; // 上级已离开的、目标不在画布上的
      if (firstParent.get(target) !== id) continue;
      seen.add(target);
      children.push(build(target));
    }
    for (const card of (cards[id] ?? []).slice(-AGENT_TREE_CARD_LIMIT)) {
      children.push({
        id: `${id}/${card.id}`,
        label: card.taskLabel,
        tone: card.state === "working" ? "working" : "done",
        kind: "subagent",
        children: [],
        hidden: 0,
      });
    }
    return {
      id,
      label: node ? displayNameOf(node, id) : (fallbackLabel ?? id),
      tone: toneOf(id),
      kind: "agent",
      children,
      hidden: 0,
    };
  };

  const full = build(rootId);
  if (full.children.length === 0) return null;

  const summary: AgentTreeSummary = { total: 0, byTone: {} };
  const visit = (node: AgentTreeNode, isRoot: boolean) => {
    if (!isRoot) {
      summary.total += 1;
      summary.byTone[node.tone] = (summary.byTone[node.tone] ?? 0) + 1;
    }
    for (const child of node.children) visit(child, false);
  };
  visit(full, true);

  return { root: truncate(full, 0), summary };
}

function descendants(node: AgentTreeNode): number {
  return node.children.reduce(
    (count, child) => count + 1 + descendants(child),
    0,
  );
}

/** 只留 `AGENT_TREE_MAX_DEPTH` 层；末层节点记下面还有几个。 */
function truncate(node: AgentTreeNode, depth: number): AgentTreeNode {
  if (depth >= AGENT_TREE_MAX_DEPTH - 1) {
    return { ...node, children: [], hidden: descendants(node) };
  }
  return {
    ...node,
    children: node.children.map((child) => truncate(child, depth + 1)),
  };
}

/* --------------------------------- 分层截断 --------------------------------- */

export interface AgentTreeLevel {
  /** 画出来的节点，按深度优先的顺序。 */
  nodes: AgentTreeNode[];
  /** 超出这一层上限、没画的格数（最后一格换成 `+k`）。 */
  overflow: number;
}

/**
 * 每层最多 `cap` 格：超出时只画前 `cap - 1` 个，最后一格是 `+k`。下一层只从画出来
 * 的节点往下取，所以画出来的节点一定连得上父节点。
 */
export function limitLevels(
  root: AgentTreeNode,
  cap: number,
): AgentTreeLevel[] {
  const levels: AgentTreeLevel[] = [{ nodes: [root], overflow: 0 }];
  let current = [root];
  // 每层的实际总数（含挂在被截掉的父节点下的），用来算 `+k`。
  const totals = totalsPerDepth(root);
  for (let depth = 1; depth < AGENT_TREE_MAX_DEPTH; depth += 1) {
    const candidates = current.flatMap((node) => node.children);
    if (candidates.length === 0 && (totals[depth] ?? 0) === 0) break;
    const total = totals[depth] ?? candidates.length;
    const shown =
      total <= cap && candidates.length === total
        ? candidates
        : candidates.slice(0, cap - 1);
    levels.push({ nodes: shown, overflow: total - shown.length });
    current = shown;
    if (shown.length === 0) break;
  }
  return levels;
}

function totalsPerDepth(root: AgentTreeNode): number[] {
  const totals: number[] = [];
  const walk = (node: AgentTreeNode, depth: number) => {
    totals[depth] = (totals[depth] ?? 0) + 1;
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return totals;
}

/* ----------------------------------- 文案 ----------------------------------- */

/** 汇总里 tone 的顺序：先要人处理的，再在跑的、失败的，最后安静的。 */
export const SUMMARY_TONE_ORDER: readonly StatusTone[] = [
  "attention",
  "working",
  "failed",
  "queued",
  "paused",
  "unread",
  "done",
  "idle",
];

/** 「3 个子 Agent，2 个运行中，1 个失败」；`role="img"` 的 `aria-label` 与 md 顶行共用。 */
export function summaryLabel(tree: AgentTree, t: Translate): string {
  const { total, byTone } = tree.summary;
  const parts = [
    total === 1
      ? t("agentTree.sub.one")
      : t("agentTree.sub.many", { count: total }),
  ];
  for (const tone of SUMMARY_TONE_ORDER) {
    const count = byTone[tone];
    if (count) parts.push(t(`agentTree.count.${tone}`, { count }));
  }
  return parts.join(t("agentTree.sep"));
}

/** Tooltip：「名称 · 状态」。 */
export function nodeLabel(node: AgentTreeNode, t: Translate): string {
  return `${node.label} · ${t(`agentTree.state.${node.tone}`)}`;
}
