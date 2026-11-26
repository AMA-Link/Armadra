import type { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  badRequest,
  notFound,
  rfc3339,
} from "../workspaces/support";
import { ensureSessionBoard, getBoard, isSessionBoard } from "./boards";
import { compileBoardLinks, notifyContextLinksChanged } from "./context-links";
import type { BoardDocument, CanvasNode } from "./document-types";
import { readBoard, realtimeHooksOf } from "./documents";
import { handleOfNode, syncHandles } from "./handles";

/**
 * 会话钉到画布与收回（Armadra#1062 S5）：一组 Agent 会话节点在会话板与画板之间
 * 整体搬家。
 *
 * 节点**不删不建**：会话、时间线、审批、收件箱、投递队列都以节点 id 为键，
 * 而 `agent_mailbox` / `router_events` 对 `nodes` 是级联删除。所以表里原地改
 * `board_id`，同一事务里重排名字、重编两块板的链接文档，并把两块板的
 * `updated_at` 往前推——手里拿着旧文档的保存因此答 409，不会把刚搬走的节点当成
 * 「被删掉」写回去。实时板的文档在搬表前先落表（`prepareMove`），搬完在同一段
 * 同步代码里写进同一份改动（`applyMove`），中间不会有物化插进来。
 *
 * 搬的是被点的那个节点经连线连起来的 Agent 终端节点（连通分量）。分量连着别的
 * 节点（便签、浏览器……）时拒绝：边不能跨板，断开哪条线该由人决定。
 */

/** 搬到画板上时放在已有节点右边，空这么宽。 */
const GAP = 120;

export interface MoveResult {
  readonly fromBoardId: string;
  readonly toBoardId: string;
  readonly nodeIds: readonly string[];
}

function isAgentNode(node: CanvasNode): boolean {
  if (node.type !== "terminal") return false;
  const agent = (node.data as { agent?: unknown } | null)?.agent;
  return agent !== null && typeof agent === "object";
}

/** 从 `start` 出发、只走 Agent 节点之间的边，得到要搬的那一组。 */
function component(document: BoardDocument, start: string): Set<string> {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const found = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const edge of document.edges) {
      const other =
        edge.source === id
          ? edge.target
          : edge.target === id
            ? edge.source
            : "";
      if (other === "" || found.has(other)) continue;
      const node = byId.get(other);
      if (node === undefined) continue;
      if (!isAgentNode(node)) {
        throw new DomainError(
          400,
          "session_has_other_links",
          `「${node.title}」不是会话，先断开它与这组会话之间的连线再搬`,
        );
      }
      found.add(other);
      queue.push(other);
    }
  }
  return found;
}

/** 目标板上没人用的名字：撞了就在后面加 `-2`、`-3`…… */
function freeHandle(taken: Set<string>, handle: string): string {
  if (!taken.has(handle)) return handle;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${handle}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function moveNodes(
  database: DatabaseSync,
  workspaceId: string,
  nodeId: string,
  fromBoardId: string,
  toBoardId: string,
): MoveResult {
  const hooks = realtimeHooksOf(database);
  hooks?.prepareMove?.(database, workspaceId, fromBoardId);
  hooks?.prepareMove?.(database, workspaceId, toBoardId);
  const from = readBoard(database, workspaceId, fromBoardId);
  const to = readBoard(database, workspaceId, toBoardId);
  const start = from.nodes.find((node) => node.id === nodeId);
  if (start === undefined || !isAgentNode(start)) {
    throw badRequest("Only an agent session can be moved");
  }
  const moving = component(from, nodeId);
  const moved = from.nodes.filter((node) => moving.has(node.id));
  const stays = from.nodes.filter((node) => !moving.has(node.id));

  // 保留这组节点之间的相对位置，整体放到目标板已有内容的右边。
  const left = Math.min(...moved.map((node) => node.position.x));
  const top = Math.min(...moved.map((node) => node.position.y));
  const right = to.nodes.reduce(
    (most, node) => Math.max(most, node.position.x + (node.size?.width ?? 0)),
    -GAP,
  );
  const dx = right + GAP - left;
  const dy =
    (to.nodes.length === 0
      ? 0
      : Math.min(...to.nodes.map((n) => n.position.y))) - top;

  const taken = new Set(
    to.nodes.map(handleOfNode).filter((h): h is string => h !== undefined),
  );
  const now = rfc3339();
  const arriving: CanvasNode[] = moved.map((node) => {
    const handle = handleOfNode(node);
    const kept = handle === undefined ? undefined : freeHandle(taken, handle);
    if (kept !== undefined) taken.add(kept);
    const data =
      kept === undefined || kept === handle
        ? node.data
        : { ...(node.data as Record<string, unknown>), handle: kept };
    const parentInside =
      node.parentId !== undefined &&
      node.parentId !== null &&
      moving.has(node.parentId);
    const { parentId: _parent, ...rest } = node;
    return {
      ...rest,
      boardId: toBoardId,
      position: { x: node.position.x + dx, y: node.position.y + dy },
      ...(parentInside ? { parentId: node.parentId } : {}),
      data,
      updatedAt: now,
    } as CanvasNode;
  });

  let linksChanged: string[];
  database.exec("BEGIN IMMEDIATE");
  try {
    const updateNode = database.prepare(
      "UPDATE nodes SET board_id = ?, x = ?, y = ?, parent_id = ?, data_json = ?, updated_at = ? WHERE id = ? AND board_id = ?",
    );
    for (const node of arriving) {
      const written = updateNode.run(
        toBoardId,
        node.position.x,
        node.position.y,
        node.parentId ?? null,
        JSON.stringify(node.data),
        now,
        node.id,
        fromBoardId,
      );
      if (written.changes !== 1) {
        throw new DomainError(409, "conflict", "Board changed; try again");
      }
    }
    const updateEdge = database.prepare(
      "UPDATE edges SET board_id = ?, updated_at = ? WHERE id = ? AND board_id = ?",
    );
    for (const edge of from.edges) {
      if (moving.has(edge.source) && moving.has(edge.target)) {
        updateEdge.run(toBoardId, now, edge.id, fromBoardId);
      }
    }
    syncHandles(database, fromBoardId, stays);
    syncHandles(database, toBoardId, [...to.nodes, ...arriving]);
    database
      .prepare("UPDATE boards SET updated_at = ? WHERE id IN (?, ?)")
      .run(now, fromBoardId, toBoardId);
    linksChanged = [
      ...compileBoardLinks(database, fromBoardId),
      ...compileBoardLinks(database, toBoardId),
    ];
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  hooks?.applyMove?.(database, workspaceId, fromBoardId, from);
  hooks?.applyMove?.(database, workspaceId, toBoardId, to);
  for (const id of new Set(linksChanged)) {
    notifyContextLinksChanged(workspaceId, id);
  }
  return {
    fromBoardId,
    toBoardId,
    nodeIds: arriving.map((node) => node.id),
  };
}

function boardOfNode(
  database: DatabaseSync,
  workspaceId: string,
  nodeId: string,
): string {
  const row = database
    .prepare(
      "SELECT n.board_id AS board_id FROM nodes n JOIN boards b ON b.id = n.board_id WHERE n.id = ? AND b.workspace_id = ?",
    )
    .get(nodeId, workspaceId) as { board_id: string } | undefined;
  if (row === undefined) throw notFound("Node was not found");
  return row.board_id;
}

/** 会话板上的会话（连同它那一组）钉到一块画板上。 */
export function pinSession(
  database: DatabaseSync,
  workspaceId: string,
  nodeId: string,
  boardId: string,
): MoveResult {
  const fromBoardId = boardOfNode(database, workspaceId, nodeId);
  if (!isSessionBoard(database, fromBoardId)) {
    throw badRequest("This session is already on a canvas");
  }
  getBoard(database, workspaceId, boardId);
  if (isSessionBoard(database, boardId)) {
    throw notFound("Board was not found");
  }
  return moveNodes(database, workspaceId, nodeId, fromBoardId, boardId);
}

/** 画布上的会话（连同它那一组）收回会话板。 */
export function unpinSession(
  database: DatabaseSync,
  workspaceId: string,
  nodeId: string,
): MoveResult {
  const fromBoardId = boardOfNode(database, workspaceId, nodeId);
  if (isSessionBoard(database, fromBoardId)) {
    throw badRequest("This session is not on a canvas");
  }
  const sessions = ensureSessionBoard(database, workspaceId);
  return moveNodes(database, workspaceId, nodeId, fromBoardId, sessions.id);
}
