/**
 * 铃铛面板的纯逻辑（§27）。
 *
 * 状态语义一律复用 `agent/sessions` 的分桶（与画布行下面那段 Agent 列表同源），
 * 这里只定四件事：哪些行算 Agent、按画布怎么分区、分区的先后、区内的先后。
 *
 * **什么算 Agent**：活着的终端行，并且带 `agentId`——节点启动时指定了 Agent，
 * 或者 hook / 观测在这个终端里报告过 Agent。普通 shell（标题常常就是主机名）
 * 不算；Agent 已经 `SessionEnd`、退回 shell 的终端也不算。会话列表在 core 里
 * 已经按节点去重、只列还在画布上的节点，这里再按节点去一次重，防的是两条来源
 * （查询与状态镜像）合流时出现同一个节点两行。
 */
import {
  agentExited,
  byRecency,
  sessionBucket,
  type SessionBucket,
  type SessionRow,
} from "../agent/sessions";
import type { StatusTone } from "../ui/status-pill";

/** 区内的状态先后：先要人管的，再跑着的，然后没看过的，最后安静的。 */
export const AGENT_BUCKET_ORDER: readonly SessionBucket[] = [
  "attention",
  "working",
  "unread",
  "idle",
  "unknown",
];

/** 分区 → 胶囊色。`unknown`（Agent 从未报告过状态）与空闲同色。 */
export function bucketTone(bucket: SessionBucket): StatusTone {
  switch (bucket) {
    case "attention":
      return "attention";
    case "working":
      return "working";
    case "unread":
      return "unread";
    default:
      return "idle";
  }
}

/** 这一行该不该进面板：活着、是 Agent、Agent 还没退出。 */
export function isListedAgent(row: SessionRow): boolean {
  return row.alive && Boolean(row.agentId) && !agentExited(row);
}

export interface AgentEntry {
  row: SessionRow;
  bucket: SessionBucket;
}

export interface BoardAgentSection {
  boardId: string;
  entries: AgentEntry[];
}

export interface AgentSectionOptions {
  /** 当前画布，排在最前。 */
  currentBoardId?: string | null;
  /** 侧栏里画布的顺序；不在里面的画布排在最后。 */
  boardOrder?: readonly string[];
}

function rank(bucket: SessionBucket): number {
  return AGENT_BUCKET_ORDER.indexOf(bucket);
}

/** 同一个节点只留一行：活着的优先，再取更新的那行。 */
function dedupeByNode(rows: readonly SessionRow[]): SessionRow[] {
  const kept = new Map<string, SessionRow>();
  for (const row of rows) {
    const previous = kept.get(row.nodeId);
    if (previous === undefined || byRecency(row, previous) < 0) {
      kept.set(row.nodeId, row);
    }
  }
  return [...kept.values()];
}

/**
 * 当前工作空间的会话 → 按画布分好的区：当前画布在前，其余按侧栏顺序；
 * 区内按 `AGENT_BUCKET_ORDER`，同一状态里最近更新的在前。
 */
export function agentSections(
  rows: readonly SessionRow[],
  options: AgentSectionOptions = {},
): BoardAgentSection[] {
  const boards = new Map<string, AgentEntry[]>();
  for (const row of dedupeByNode(rows.filter(isListedAgent))) {
    const list = boards.get(row.boardId) ?? [];
    list.push({ row, bucket: sessionBucket(row) });
    boards.set(row.boardId, list);
  }

  const order = options.boardOrder ?? [];
  const position = (boardId: string): number => {
    if (boardId === options.currentBoardId) return -1;
    const index = order.indexOf(boardId);
    return index === -1 ? order.length : index;
  };

  return [...boards.entries()]
    .map(([boardId, entries]) => ({
      boardId,
      entries: entries.sort(
        (a, b) => rank(a.bucket) - rank(b.bucket) || byRecency(a.row, b.row),
      ),
    }))
    .sort(
      (a, b) =>
        position(a.boardId) - position(b.boardId) ||
        a.boardId.localeCompare(b.boardId),
    );
}
