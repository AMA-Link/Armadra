/**
 * 「需要人处理」的清单与分组（契约 §81）。
 *
 * 分类本身在共享层（`agentHumanNeed` / `handoffHumanNeed`），这里只做两件事：
 * 把会话行与交接记录收成清单，再按 工作空间 → 画布 → 节点 分三层并带上计数。
 * 铃铛徽标、面板、系统通知的点击跳转都读这份清单，没有第二套判断。
 */
import {
  agentHumanNeed,
  handoffHumanNeed,
  HUMAN_NEEDS,
  type HandoffView,
  type HumanNeed,
} from "@armadra/shared";

import type { SessionRow } from "../agent/sessions";

export interface NeedItem {
  /** 同一个节点可以同时有审批与交接，所以键带上分类。 */
  key: string;
  workspaceId: string;
  boardId: string;
  nodeId: string;
  title: string;
  need: HumanNeed;
  updatedAt: string;
  /** 会话行才有；面板的「对话记录 / 屏幕」菜单用。 */
  sessionId?: string;
}

export interface NeedSource {
  workspaceId: string;
  rows: readonly SessionRow[];
  handoffs: readonly HandoffView[];
}

export interface NeedBoardGroup {
  boardId: string;
  name: string;
  count: number;
  items: NeedItem[];
}

export interface NeedWorkspaceGroup {
  workspaceId: string;
  name: string;
  count: number;
  boards: NeedBoardGroup[];
}

export interface NeedLayout {
  workspaces: readonly {
    id: string;
    name: string;
    boards: readonly { id: string; name: string }[];
  }[];
  currentWorkspaceId?: string | null;
  currentBoardId?: string | null;
}

function millis(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? 0 : value;
}

/** 一个工作空间里所有要人处理的事。 */
export function collectNeeds(sources: readonly NeedSource[]): NeedItem[] {
  const items: NeedItem[] = [];
  for (const { workspaceId, rows, handoffs } of sources) {
    const boardOf = new Map<string, string>();
    const seen = new Set<string>();
    for (const row of rows) {
      boardOf.set(row.nodeId, row.boardId);
      // 同一个节点只算一行；会话列表本来就按节点去过重，这里防两路合流。
      if (seen.has(row.nodeId)) continue;
      seen.add(row.nodeId);
      const need = agentHumanNeed(row);
      if (need === null) continue;
      items.push({
        key: `${workspaceId}:${row.nodeId}:${need}`,
        workspaceId,
        boardId: row.boardId,
        nodeId: row.nodeId,
        title: row.title,
        need,
        updatedAt: row.updatedAt,
        sessionId: row.sessionId,
      });
    }
    for (const view of handoffs) {
      const need = handoffHumanNeed(view.state);
      if (need === null) continue;
      // 交接挂在来源节点上；来源已经不在画布上（找不到所在画布）就没处可去。
      const nodeId = view.bundle.source.nodeId;
      const boardId = boardOf.get(nodeId);
      if (boardId === undefined) continue;
      items.push({
        key: `${workspaceId}:${view.bundle.handoffId}:${need}`,
        workspaceId,
        boardId,
        nodeId,
        title: view.bundle.source.nodeTitle,
        need,
        updatedAt: view.updatedAt,
      });
    }
  }
  return items;
}

const needRank = (need: HumanNeed): number => HUMAN_NEEDS.indexOf(need);

/** 先排当前的，其余按 `order`；不在 `order` 里的排最后。 */
function positionOf(
  id: string,
  current: string | null | undefined,
  order: readonly string[],
): number {
  if (id === current) return -1;
  const index = order.indexOf(id);
  return index === -1 ? order.length : index;
}

/**
 * 清单 → 工作空间 → 画布 → 节点。当前工作空间与当前画布在前，其余按侧栏顺序；
 * 节点按 审批 > 等待回答 > 出错 > 交接，同类里新的在前。空的层不出现。
 */
export function groupNeeds(
  items: readonly NeedItem[],
  layout: NeedLayout,
): NeedWorkspaceGroup[] {
  const byWorkspace = new Map<string, NeedItem[]>();
  for (const item of items) {
    const list = byWorkspace.get(item.workspaceId) ?? [];
    list.push(item);
    byWorkspace.set(item.workspaceId, list);
  }
  const workspaceOrder = layout.workspaces.map((workspace) => workspace.id);

  return [...byWorkspace.entries()]
    .map(([workspaceId, list]) => {
      const known = layout.workspaces.find((item) => item.id === workspaceId);
      const boardOrder = known?.boards.map((board) => board.id) ?? [];
      const byBoard = new Map<string, NeedItem[]>();
      for (const item of list) {
        const inBoard = byBoard.get(item.boardId) ?? [];
        inBoard.push(item);
        byBoard.set(item.boardId, inBoard);
      }
      const boards = [...byBoard.entries()]
        .map(([boardId, inBoard]) => ({
          boardId,
          name: known?.boards.find((board) => board.id === boardId)?.name ?? "",
          count: inBoard.length,
          items: [...inBoard].sort(
            (a, b) =>
              needRank(a.need) - needRank(b.need) ||
              millis(b.updatedAt) - millis(a.updatedAt) ||
              a.title.localeCompare(b.title),
          ),
        }))
        .sort(
          (a, b) =>
            positionOf(a.boardId, layout.currentBoardId, boardOrder) -
              positionOf(b.boardId, layout.currentBoardId, boardOrder) ||
            a.boardId.localeCompare(b.boardId),
        );
      return {
        workspaceId,
        name: known?.name ?? "",
        count: list.length,
        boards,
      };
    })
    .sort(
      (a, b) =>
        positionOf(a.workspaceId, layout.currentWorkspaceId, workspaceOrder) -
          positionOf(
            b.workspaceId,
            layout.currentWorkspaceId,
            workspaceOrder,
          ) || a.workspaceId.localeCompare(b.workspaceId),
    );
}
