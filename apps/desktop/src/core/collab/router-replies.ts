import type { DatabaseSync } from "node:sqlite";

/**
 * 协调者的回复闸门的表（契约 §101，#704）：`router_replies`。
 *
 * 每一条被 `canvas notify` 接受的回复落一行。id 由用途和目标确定，所以同一个
 * id 写第二次就是重复：这正好是「阶段再次变化之前只能发一次」。页面读最新一条
 * 显示在分派抽屉的成员行下面；人打开抽屉就标为已读。
 */

export const REPLY_PURPOSES = ["answer", "result", "attention"] as const;
export type ReplyPurpose = (typeof REPLY_PURPOSES)[number];

export interface RouterReply {
  readonly id: string;
  readonly coordinatorNodeId: string;
  readonly itemId: string;
  readonly purpose: ReplyPurpose;
  readonly stage: string;
  readonly text: string;
  readonly createdAt: number;
  readonly readAt: number | null;
}

interface Row {
  readonly id: string;
  readonly coordinator_node_id: string;
  readonly item_id: string;
  readonly purpose: string;
  readonly stage: string;
  readonly text: string;
  readonly created_at: number;
  readonly read_at: number | null;
}

const COLUMNS =
  "id, coordinator_node_id, item_id, purpose, stage, text, created_at, read_at";

function replyOf(row: Row): RouterReply {
  return {
    id: row.id,
    coordinatorNodeId: row.coordinator_node_id,
    itemId: row.item_id,
    purpose: row.purpose as ReplyPurpose,
    stage: row.stage,
    text: row.text,
    createdAt: Number(row.created_at),
    readAt: row.read_at === null ? null : Number(row.read_at),
  };
}

export function replyExists(database: DatabaseSync, id: string): boolean {
  return (
    database
      .prepare("SELECT 1 AS one FROM router_replies WHERE id = ?")
      .get(id) !== undefined
  );
}

/** 写一条回复。id 已经在表里就什么都不做，答是不是新写进去的。 */
export function insertReply(
  database: DatabaseSync,
  reply: Omit<RouterReply, "readAt">,
): boolean {
  const changes = database
    .prepare(
      `INSERT OR IGNORE INTO router_replies (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      reply.id.slice(0, 200),
      reply.coordinatorNodeId,
      reply.itemId,
      reply.purpose,
      reply.stage,
      reply.text,
      reply.createdAt,
    );
  return Number(changes.changes) > 0;
}

/** 一个协调者名下每个工作项的最新一条回复。 */
export function latestReplies(
  database: DatabaseSync,
  coordinatorNodeId: string,
): Map<string, RouterReply> {
  const rows = database
    .prepare(
      `SELECT ${COLUMNS} FROM router_replies WHERE coordinator_node_id = ? ORDER BY created_at, rowid`,
    )
    .all(coordinatorNodeId) as unknown as Row[];
  const latest = new Map<string, RouterReply>();
  for (const row of rows) latest.set(row.item_id, replyOf(row));
  return latest;
}

/** 人打开分派抽屉：这个协调者名下的回复都标为已读。答标了几条。 */
export function markRepliesRead(
  database: DatabaseSync,
  coordinatorNodeIds: readonly string[],
  nowMs: number,
): number {
  let total = 0;
  const statement = database.prepare(
    "UPDATE router_replies SET read_at = ? WHERE coordinator_node_id = ? AND read_at IS NULL",
  );
  for (const id of coordinatorNodeIds) {
    total += Number(statement.run(nowMs, id).changes);
  }
  return total;
}
