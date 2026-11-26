import type {
  BoardDocument,
  CanvasEdge,
  CanvasNode,
  TerminalNodeData,
} from "@armadra/shared";

import {
  byRecency,
  sessionBucket,
  type SessionBucket,
  type SessionRow,
} from "@/agent/sessions";
import { displayNameOf } from "@/canvas/supervision";
import type { StartingSession } from "./store";

/** 会话页里的一条：一个带 Agent 的终端节点，不论它在画布上还是会话板上。 */
export interface AgentSessionItem {
  readonly nodeId: string;
  readonly boardId: string;
  readonly boardName: string;
  readonly onSessionBoard: boolean;
  readonly title: string;
  readonly data: TerminalNodeData;
  /** 进程起来之后才有；刚新开的会话没有。 */
  readonly session?: SessionRow | undefined;
  /** 盯着它的那个会话（同一块板上，第一条上级边赢）。 */
  readonly parentId?: string | undefined;
}

export interface AgentSessionNode {
  readonly item: AgentSessionItem;
  readonly children: readonly AgentSessionNode[];
}

export interface BoardSource {
  readonly boardId: string;
  readonly name: string;
  readonly onSessionBoard: boolean;
  readonly document: Pick<BoardDocument, "nodes" | "edges"> | undefined;
}

/** 分区：沿用会话侧栏的顺序，「启动中」排在运行中之后。 */
export type PageBucket = SessionBucket | "starting";
export const PAGE_BUCKET_ORDER: readonly PageBucket[] = [
  "attention",
  "working",
  "starting",
  "unread",
  "idle",
  "unknown",
];

function terminalAgentData(node: CanvasNode): TerminalNodeData | undefined {
  return node.type === "terminal" &&
    node.data.kind === "terminal" &&
    node.data.agent !== undefined
    ? node.data
    : undefined;
}

/** 每块板上的 Agent 终端节点 + 会话行 + 刚新开的会话 → 平铺的条目。 */
export function buildSessionItems(
  boards: readonly BoardSource[],
  rows: readonly SessionRow[],
  starting: readonly StartingSession[],
  sessionsLabel: string,
): AgentSessionItem[] {
  const rowByNode = new Map(rows.map((row) => [row.nodeId, row]));
  const items: AgentSessionItem[] = [];
  const seen = new Set<string>();
  for (const board of boards) {
    const document = board.document;
    if (document === undefined) continue;
    const agents = new Map<string, CanvasNode>();
    for (const node of document.nodes) {
      if (terminalAgentData(node) !== undefined) agents.set(node.id, node);
    }
    const parentOf = supervisorsOf(document.edges, agents);
    for (const node of agents.values()) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      items.push({
        nodeId: node.id,
        boardId: board.boardId,
        boardName: board.onSessionBoard ? sessionsLabel : board.name,
        onSessionBoard: board.onSessionBoard,
        title: displayNameOf(node, node.id),
        data: terminalAgentData(node)!,
        session: rowByNode.get(node.id),
        parentId: parentOf.get(node.id),
      });
    }
  }
  for (const pending of starting) {
    if (seen.has(pending.nodeId)) continue;
    seen.add(pending.nodeId);
    items.push({
      nodeId: pending.nodeId,
      boardId: pending.boardId,
      boardName: sessionsLabel,
      onSessionBoard: true,
      title: pending.title,
      data: {
        kind: "terminal",
        agent: { id: pending.agentId, driver: pending.driver },
      },
      session: rowByNode.get(pending.nodeId),
    });
  }
  return items;
}

/** `supervises` 边读成「节点 → 上级」：第一条赢，上级必须也是这块板上的会话。 */
function supervisorsOf(
  edges: readonly CanvasEdge[],
  agents: ReadonlyMap<string, CanvasNode>,
): Map<string, string> {
  const parents = new Map<string, string>();
  for (const edge of edges) {
    if (edge.role !== "supervises") continue;
    if (!agents.has(edge.source) || !agents.has(edge.target)) continue;
    if (!parents.has(edge.target)) parents.set(edge.target, edge.source);
  }
  return parents;
}

/** 上级在前、下级缩进：条目 → 森林。环路里的节点按根处理，不丢条目。 */
export function buildSessionTree(
  items: readonly AgentSessionItem[],
): AgentSessionNode[] {
  const ids = new Set(items.map((item) => item.nodeId));
  const children = new Map<string, AgentSessionItem[]>();
  const roots: AgentSessionItem[] = [];
  for (const item of items) {
    if (item.parentId !== undefined && ids.has(item.parentId)) {
      const list = children.get(item.parentId) ?? [];
      list.push(item);
      children.set(item.parentId, list);
    } else {
      roots.push(item);
    }
  }
  const placed = new Set<string>();
  const build = (item: AgentSessionItem): AgentSessionNode => {
    placed.add(item.nodeId);
    return {
      item,
      children: (children.get(item.nodeId) ?? [])
        .filter((child) => !placed.has(child.nodeId))
        .sort(compareItems)
        .map(build),
    };
  };
  const forest = roots.sort(compareItems).map(build);
  // 互相盯着的环：没有根，挑一个当根，免得整环消失。
  for (const item of items) {
    if (!placed.has(item.nodeId)) forest.push(build(item));
  }
  return forest;
}

function compareItems(a: AgentSessionItem, b: AgentSessionItem): number {
  if (a.session && b.session) return byRecency(a.session, b.session);
  if (a.session) return -1;
  if (b.session) return 1;
  return a.title.localeCompare(b.title);
}

export function flatten(tree: readonly AgentSessionNode[]): AgentSessionItem[] {
  return tree.flatMap((node) => [node.item, ...flatten(node.children)]);
}

export function itemBucket(item: AgentSessionItem): PageBucket {
  return item.session ? sessionBucket(item.session) : "starting";
}

/** 一棵子树里最要紧的那个分区：下级在等人时，上级也排在「需要你」里。 */
export function nodeBucket(node: AgentSessionNode): PageBucket {
  let best = itemBucket(node.item);
  for (const child of node.children) {
    const bucket = nodeBucket(child);
    if (PAGE_BUCKET_ORDER.indexOf(bucket) < PAGE_BUCKET_ORDER.indexOf(best))
      best = bucket;
  }
  return best;
}

export interface BucketGroup {
  readonly bucket: PageBucket;
  readonly nodes: readonly AgentSessionNode[];
}

export function groupTree(tree: readonly AgentSessionNode[]): BucketGroup[] {
  const groups = new Map<PageBucket, AgentSessionNode[]>();
  for (const node of tree) {
    const bucket = nodeBucket(node);
    groups.set(bucket, [...(groups.get(bucket) ?? []), node]);
  }
  return PAGE_BUCKET_ORDER.filter((bucket) => groups.has(bucket)).map(
    (bucket) => ({ bucket, nodes: groups.get(bucket)! }),
  );
}

/** 过滤：标题、位置与目录命中的节点保留，命中节点的上级一并保留。 */
export function filterTree(
  tree: readonly AgentSessionNode[],
  query: string,
): AgentSessionNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...tree];
  const hit = (item: AgentSessionItem) =>
    item.title.toLowerCase().includes(needle) ||
    item.boardName.toLowerCase().includes(needle) ||
    (item.session?.cwd.toLowerCase().includes(needle) ?? false);
  const walk = (nodes: readonly AgentSessionNode[]): AgentSessionNode[] =>
    nodes.flatMap((node) => {
      const children = walk(node.children);
      return hit(node.item) || children.length > 0
        ? [{ item: node.item, children }]
        : [];
    });
  return walk(tree);
}
