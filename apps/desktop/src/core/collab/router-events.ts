import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { loadNode } from "./nodes";
import { stripControl } from "./refusals";
import { type CollabContext, nowDate } from "./service";

/**
 * 协调者的统一事件队列（契约 §93，#696）。
 *
 * 要让协调者知道的事——成员的报告与交回、看门狗的判定、任务结束、人对某个工作
 * 项的追问、别的节点留的话——原先各走各的路（收件箱一行、五分钟就过期的唤醒、
 * `wait` 长轮询）。现在都只做一件事：往 `router_events` 写一行。投递是另一件事：
 * core 在协调者空闲、且有还没提醒过的事件时，把未确认的事件合并成**一张**卡片
 * 投进去（`router-cards.ts`）；协调者处理完用 `canvas ack --event` 确认。
 *
 * 这个模块只管表与文字：写入幂等（id 由种类 + 来源 id + 版本确定）、读未确认的、
 * 确认、排卡片。正文只有节点名、工作项 id、种类和成员自己写的那一行，**不带终端
 * 原文**。
 */

export const ROUTER_EVENT_KINDS = [
  "report",
  "attention",
  "handback",
  "task-done",
  "stalled",
  "followup",
  "inbox",
  "interrupted",
  "external",
  "intake",
] as const;

export type RouterEventKind = (typeof ROUTER_EVENT_KINDS)[number];

/** 一张卡片最多这么多行。 */
export const MAX_CARD_ROWS = 20;
/** `canvas events` 缺省与最多读多少条。 */
export const DEFAULT_EVENTS = 20;
export const MAX_EVENTS = 50;
/** 一行内容最多这么多字。 */
export const MAX_SUMMARY_CHARS = 160;
/** 确认过的事件留多久（毫秒），之后清掉。 */
export const ACKED_KEEP_MS = 7 * 24 * 3_600_000;
/** 没确认的事件最多留多久（毫秒）：协调者不确认，表也不随节点寿命增长。 */
export const OPEN_KEEP_MS = 30 * 24 * 3_600_000;
/** 每个协调者最多留这么多条没确认的事件，超出的丢最旧的。 */
export const MAX_OPEN_EVENTS = 500;
/** 「没能转给」事件的 id 前缀：卡片据此换掉「不要再派一份」的提示。 */
export const FOLLOWUP_FAILED_PREFIX = "followup-failed:";

export interface RouterEvent {
  readonly id: string;
  readonly coordinatorNodeId: string;
  readonly workspaceId: string;
  readonly kind: RouterEventKind;
  readonly itemId: string | null;
  readonly sourceNodeId: string | null;
  readonly summary: string;
  readonly createdAt: number;
  readonly cardedAt: number | null;
  readonly ackedAt: number | null;
}

export interface NewRouterEvent {
  readonly id: string;
  readonly coordinatorNodeId: string;
  readonly kind: RouterEventKind;
  readonly itemId?: string | null | undefined;
  readonly sourceNodeId?: string | null | undefined;
  readonly summary: string;
}

interface Row {
  readonly id: string;
  readonly coordinator_node_id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly item_id: string | null;
  readonly source_node_id: string | null;
  readonly summary: string;
  readonly created_at: number;
  readonly carded_at: number | null;
  readonly acked_at: number | null;
}

const COLUMNS =
  "id, coordinator_node_id, workspace_id, kind, item_id, source_node_id, summary, created_at, carded_at, acked_at";

function eventOf(row: Row): RouterEvent {
  return {
    id: row.id,
    coordinatorNodeId: row.coordinator_node_id,
    workspaceId: row.workspace_id,
    kind: row.kind as RouterEventKind,
    itemId: row.item_id,
    sourceNodeId: row.source_node_id,
    summary: row.summary,
    createdAt: Number(row.created_at),
    cardedAt: row.carded_at === null ? null : Number(row.carded_at),
    ackedAt: row.acked_at === null ? null : Number(row.acked_at),
  };
}

/** 去控制字符、折叠空白、限长：卡片一行就是一行。 */
export function oneLine(text: string, max = MAX_SUMMARY_CHARS): string {
  const flat = stripControl(text).replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

/** 事件 id 里放进去的短指纹（看门狗的状态指纹含 `|` 等，不能原样进 id）。 */
export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** 毫秒时刻的 36 进制：事件 id 里的「版本」。 */
export function versionOf(ms: number): string {
  return Math.max(0, Math.floor(ms)).toString(36);
}

/* --------------------------------- 写 / 读 -------------------------------- */

/** 这个节点是不是某个工作项的协调者。 */
export function isCoordinator(database: DatabaseSync, nodeId: string): boolean {
  return (
    database
      .prepare(
        "SELECT 1 AS one FROM workflow_task_runs WHERE coordinator_node_id = ? LIMIT 1",
      )
      .get(nodeId) !== undefined
  );
}

/**
 * 写一个事件。id 已经在表里就什么都不做（幂等）。答这次是不是新写进去的。
 * 协调者节点不在了不写：没人接。
 */
export function insertEvent(
  database: DatabaseSync,
  event: NewRouterEvent,
  nowMs: number,
): boolean {
  const coordinator = loadNode(database, event.coordinatorNodeId);
  if (coordinator === undefined) return false;
  const changes = database
    .prepare(
      `INSERT OR IGNORE INTO router_events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      event.id.slice(0, 200),
      event.coordinatorNodeId,
      coordinator.workspaceId,
      event.kind,
      event.itemId ?? null,
      event.sourceNodeId ?? null,
      oneLine(event.summary),
      nowMs,
    );
  return Number(changes.changes) > 0;
}

/**
 * 写一个事件并叫醒协调者那一侧的投递（出队泵）。所有来源都走这一个入口。
 * 答这次是不是新写进去的。
 */
export function recordRouterEvent(
  context: CollabContext,
  event: NewRouterEvent,
): boolean {
  const inserted = insertEvent(
    context.database,
    event,
    nowDate(context).getTime(),
  );
  if (inserted) context.nudge?.(event.coordinatorNodeId);
  return inserted;
}

/** 未确认的事件，最早的在前。 */
export function openEvents(
  database: DatabaseSync,
  coordinatorNodeId: string,
  limit: number,
): RouterEvent[] {
  const rows = database
    .prepare(
      `SELECT ${COLUMNS} FROM router_events WHERE coordinator_node_id = ? AND acked_at IS NULL ` +
        "ORDER BY created_at, rowid LIMIT ?",
    )
    .all(coordinatorNodeId, limit) as unknown as Row[];
  return rows.map(eventOf);
}

export function countOpen(
  database: DatabaseSync,
  coordinatorNodeId: string,
): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS total FROM router_events WHERE coordinator_node_id = ? AND acked_at IS NULL",
    )
    .get(coordinatorNodeId) as { total: number };
  return Number(row.total);
}

/** 还没进过卡片的未确认事件数：卡片只在有这样的事件时才投。 */
export function countFresh(
  database: DatabaseSync,
  coordinatorNodeId: string,
): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS total FROM router_events WHERE coordinator_node_id = ? " +
        "AND acked_at IS NULL AND carded_at IS NULL",
    )
    .get(coordinatorNodeId) as { total: number };
  return Number(row.total);
}

/** 有还没提醒过的事件的协调者（兜底清扫用）。 */
export function coordinatorsWithFresh(database: DatabaseSync): string[] {
  const rows = database
    .prepare(
      "SELECT DISTINCT coordinator_node_id AS id FROM router_events WHERE acked_at IS NULL AND carded_at IS NULL",
    )
    .all() as { id: string }[];
  return rows.map((row) => row.id);
}

/**
 * 下一张卡片要列的事件：没提醒过的优先，不够再补提醒过但没确认的；一共不超过
 * {@link MAX_CARD_ROWS}。列出来按时间顺序。
 */
export function cardEvents(
  database: DatabaseSync,
  coordinatorNodeId: string,
): RouterEvent[] {
  const rows = database
    .prepare(
      `SELECT ${COLUMNS} FROM router_events WHERE coordinator_node_id = ? AND acked_at IS NULL ` +
        "ORDER BY (carded_at IS NULL) DESC, created_at, rowid LIMIT ?",
    )
    .all(coordinatorNodeId, MAX_CARD_ROWS) as unknown as Row[];
  return rows
    .map(eventOf)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** 这些事件进了一张投出去的卡片。 */
export function markCarded(
  database: DatabaseSync,
  ids: readonly string[],
  nowMs: number,
): void {
  const update = database.prepare(
    "UPDATE router_events SET carded_at = ? WHERE id = ?",
  );
  for (const id of ids) update.run(nowMs, id);
}

export type AckResult = "acked" | "already" | "missing";

/** 协调者确认「我处理了」。只认自己名下的；已经确认过的什么都不动。 */
export function ackEvent(
  database: DatabaseSync,
  coordinatorNodeId: string,
  id: string,
  nowMs: number,
): AckResult {
  const changes = database
    .prepare(
      "UPDATE router_events SET acked_at = ? WHERE id = ? AND coordinator_node_id = ? AND acked_at IS NULL",
    )
    .run(nowMs, id, coordinatorNodeId);
  if (Number(changes.changes) > 0) return "acked";
  const row = database
    .prepare(
      "SELECT 1 AS one FROM router_events WHERE id = ? AND coordinator_node_id = ?",
    )
    .get(id, coordinatorNodeId);
  return row === undefined ? "missing" : "already";
}

/** 收件箱消息被 `canvas ack --id` 确认时，它对应的 `inbox` 事件一并确认。 */
export function ackInboxEvent(
  database: DatabaseSync,
  coordinatorNodeId: string,
  messageId: string,
  nowMs: number,
): void {
  ackEvent(database, coordinatorNodeId, `inbox:${messageId}`, nowMs);
}

/** 确认过很久的清掉，表不会无限长。答清了几行。 */
export function pruneAcked(database: DatabaseSync, nowMs: number): number {
  const changes = database
    .prepare(
      "DELETE FROM router_events WHERE acked_at IS NOT NULL AND acked_at <= ?",
    )
    .run(nowMs - ACKED_KEEP_MS);
  return Number(changes.changes);
}

/**
 * 协调者一直不确认的事件也要有尽头：超过 {@link OPEN_KEEP_MS} 的丢掉，每个协调者
 * 超过 {@link MAX_OPEN_EVENTS} 条时丢最旧的。卡片一张只列 {@link MAX_CARD_ROWS}
 * 行，所以丢掉的都是早就排不进卡片的那些。答丢了几行。
 */
export function pruneOpen(database: DatabaseSync, nowMs: number): number {
  const old = database
    .prepare(
      "DELETE FROM router_events WHERE acked_at IS NULL AND created_at <= ?",
    )
    .run(nowMs - OPEN_KEEP_MS);
  const over = database
    .prepare(
      "DELETE FROM router_events WHERE rowid IN (" +
        "SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (" +
        "PARTITION BY coordinator_node_id ORDER BY created_at DESC, rowid DESC) AS place " +
        "FROM router_events WHERE acked_at IS NULL) WHERE place > ?)",
    )
    .run(MAX_OPEN_EVENTS);
  return Number(old.changes) + Number(over.changes);
}

/* --------------------------------- 文字 ---------------------------------- */

/** 「事件 id · 工作项 id · 种类 · 一行内容」。 */
export function eventLine(event: RouterEvent): string {
  return [event.id, event.itemId ?? "-", event.kind, event.summary].join(" · ");
}

/** 节点的名字（用户给的标题），折成一行、限长。 */
export function nodeName(database: DatabaseSync, nodeId: string): string {
  const node = loadNode(database, nodeId);
  const name = oneLine(node?.title ?? "", 40);
  return name === "" ? "一个成员" : `「${name}」`;
}

/**
 * 一张卡片的正文：最多 {@link MAX_CARD_ROWS} 行事件，末尾是 `canvas items` 的读取
 * 指针与确认的用法。`total` 是此刻未确认的总数。
 */
export function composeCard(
  events: readonly RouterEvent[],
  total: number,
): string {
  const lines = [
    `协调者事件：未确认 ${total} 条` +
      (total > events.length ? `，本卡列出 ${events.length} 条` : "") +
      "。",
    ...events.map(eventLine),
  ];
  if (total > events.length) {
    lines.push(
      `还有 ${total - events.length} 条没列出，\`canvas events\` 读。`,
    );
  }
  lines.push(
    "工作项详情读 `canvas items --item <工作项 id>`；处理完一条用 `canvas ack --event <事件 id>` 确认（确认是「我处理了」，不是「我看到了」）。",
  );
  if (
    events.some(
      (event) =>
        event.kind === "followup" &&
        !event.id.startsWith(FOLLOWUP_FAILED_PREFIX),
    )
  ) {
    lines.push(
      "followup 的行是人的原话已排队转给成员（没投进去会另有一行「没能转给」）：你只能决定停掉那一项，不要再派一份。",
    );
  }
  if (events.some((event) => event.kind === "intake")) {
    lines.push(
      "intake 的行是来源仓库里没人认领的 issue / PR：先 `canvas intake --candidate <id>` 读规则和正文，再 `canvas intake --candidate <id> --verdict accept|skip --reason <一句话>` 判定；判定即确认，不用 ack。",
    );
  }
  return lines.join("\n");
}
