/**
 * 会话时间线的存储（迁移 0052，契约 §82）。
 *
 * 库里存的是每个条目的**最新完整值**加上最后一次修改它的序号 `rev`，所以任何游标的
 * 增量同步都是一次 `rev > after` 的范围查询，不需要保留操作日志。写入的单位是一批
 * 操作（已经过 `compactTimelineOps` 的那一份）：一个事务里按序应用，并把
 * `timelines.head_seq` 推到这一批的最后一个序号。应用规则与共享层的
 * `applyTimelineOps` 逐条一致（条目级的 `rev` 守卫、墓碑、`append` 落到完整值上），
 * 所以库、内存状态与页面三边对同一批操作得到同一个结果。
 */

import type { DatabaseSync } from "node:sqlite";

import {
  type TimelineHead,
  type TimelineItem,
  type TimelineItemRecord,
  type TimelineOp,
  type TimelineSnapshot,
  type TimelineState,
  type TimelineSyncResult,
  type TurnIndex,
  appendToItem,
  timelineItemSchema,
} from "@armadra/shared";

export interface TimelineRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly headSeq: number;
  readonly headRev: number;
  readonly source: string;
  readonly sourceCursor: string;
  readonly head: TimelineHead;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface EnsureTimeline {
  readonly id: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly source?: string;
}

/** `sync` 的游标比库里的序号还大（库回退过）：页面改为重新 `open`。 */
export class CursorAheadError extends Error {
  constructor(
    readonly after: number,
    readonly headSeq: number,
  ) {
    super(`cursor ${after} is ahead of head ${headSeq}`);
    this.name = "CursorAheadError";
  }
}

const DEFAULT_TAIL_TURNS = 3;
const DEFAULT_PAGE_TURNS = 5;

function parseHead(json: string): TimelineHead {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as TimelineHead)
      : {};
  } catch {
    return {};
  }
}

function rowOf(raw: Record<string, unknown>): TimelineRow {
  return {
    id: String(raw.id),
    workspaceId: String(raw.workspace_id),
    nodeId: String(raw.node_id),
    headSeq: Number(raw.head_seq),
    headRev: Number(raw.head_rev),
    source: String(raw.source),
    sourceCursor: String(raw.source_cursor),
    head: parseHead(String(raw.head_json)),
    createdAtMs: Number(raw.created_at_ms),
    updatedAtMs: Number(raw.updated_at_ms),
  };
}

function itemOf(json: unknown): TimelineItem | null {
  if (typeof json !== "string") return null;
  try {
    const parsed = timelineItemSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function mergeHead(head: TimelineHead, patch: TimelineHead): TimelineHead {
  const next: Record<string, unknown> = { ...head };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return next as TimelineHead;
}

export class TimelineStore {
  constructor(private readonly database: DatabaseSync) {}

  /* ------------------------------- 时间线行 ------------------------------- */

  get(id: string): TimelineRow | undefined {
    const raw = this.database
      .prepare("SELECT * FROM timelines WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return raw === undefined ? undefined : rowOf(raw);
  }

  /** 没有就建一条（序号从 0 起）；已有的原样返回，归属不被后来的调用改写。 */
  ensure(input: EnsureTimeline, nowMs: number): TimelineRow {
    this.database
      .prepare(
        "INSERT INTO timelines(id, workspace_id, node_id, source, created_at_ms, updated_at_ms) " +
          "VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(
        input.id,
        input.workspaceId,
        input.nodeId,
        input.source ?? "acp",
        nowMs,
        nowMs,
      );
    return this.get(input.id) as TimelineRow;
  }

  /** 外部来源（转录尾读）的续读游标。 */
  setSourceCursor(id: string, source: string, cursor: string): void {
    this.database
      .prepare(
        "UPDATE timelines SET source = ?, source_cursor = ? WHERE id = ?",
      )
      .run(source, cursor, id);
  }

  /** 整条时间线连同条目与 blob 登记一起删（字节文件由 {@link BlobStore} 回收）。 */
  remove(id: string): void {
    this.database.prepare("DELETE FROM timelines WHERE id = ?").run(id);
  }

  /** 节点已经不在库里、且比 `olderThanMs` 旧的时间线 id（启动清理用）。 */
  orphans(olderThanMs: number): string[] {
    const rows = this.database
      .prepare(
        "SELECT t.id AS id FROM timelines t WHERE t.updated_at_ms < ? " +
          "AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = t.node_id)",
      )
      .all(olderThanMs) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /* --------------------------------- 写入 --------------------------------- */

  /**
   * 应用一批（已压实、序号升序的）操作，一个事务。`headSeq` 是这一批之后的序号
   * （最后一个操作的 `seq`）。已经被更新的 `rev` 盖过的操作不生效，所以重放无害。
   */
  apply(
    id: string,
    ops: readonly TimelineOp[],
    headSeq: number,
    nowMs: number,
  ): void {
    if (ops.length === 0) return;
    const database = this.database;
    const select = database.prepare(
      "SELECT rev, deleted, data_json FROM timeline_items WHERE timeline_id = ? AND item_id = ?",
    );
    const upsert = database.prepare(
      "INSERT INTO timeline_items(timeline_id, item_id, turn, ord, kind, rev, deleted, data_json) " +
        "VALUES(?, ?, ?, ?, ?, ?, 0, ?) " +
        "ON CONFLICT(timeline_id, item_id) DO UPDATE SET turn = excluded.turn, ord = excluded.ord, " +
        "kind = excluded.kind, rev = excluded.rev, deleted = 0, data_json = excluded.data_json " +
        "WHERE excluded.rev > timeline_items.rev",
    );
    const tombstone = database.prepare(
      "INSERT INTO timeline_items(timeline_id, item_id, turn, ord, kind, rev, deleted, data_json) " +
        "VALUES(?, ?, 0, 0, '', ?, 1, NULL) " +
        "ON CONFLICT(timeline_id, item_id) DO UPDATE SET rev = excluded.rev, deleted = 1, data_json = NULL " +
        "WHERE excluded.rev > timeline_items.rev",
    );
    const patchItem = database.prepare(
      "UPDATE timeline_items SET rev = ?, data_json = ? WHERE timeline_id = ? AND item_id = ?",
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      const current = database
        .prepare(
          "SELECT head_seq, head_rev, head_json FROM timelines WHERE id = ?",
        )
        .get(id) as
        | { head_seq: number; head_rev: number; head_json: string }
        | undefined;
      if (current === undefined)
        throw new Error(`timeline ${id} does not exist`);
      let head = parseHead(current.head_json);
      let headRev = Number(current.head_rev);
      let headTouched = false;
      for (const op of ops) {
        switch (op.op) {
          case "put": {
            const item = { ...op.item, rev: op.seq };
            upsert.run(
              id,
              item.id,
              item.turn,
              item.ord,
              item.kind,
              op.seq,
              JSON.stringify(item),
            );
            break;
          }
          case "append": {
            const row = select.get(id, op.itemId) as
              | { rev: number; deleted: number; data_json: string | null }
              | undefined;
            if (row === undefined || row.deleted !== 0) break;
            if (op.seq <= Number(row.rev)) break;
            const item = itemOf(row.data_json);
            if (item === null) break;
            const next = appendToItem(item, op.delta);
            if (next === null) break;
            patchItem.run(
              op.seq,
              JSON.stringify({ ...next, rev: op.seq }),
              id,
              op.itemId,
            );
            break;
          }
          case "remove":
            tombstone.run(id, op.itemId, op.seq);
            break;
          case "head":
            if (op.seq > headRev) {
              head = mergeHead(head, op.head);
              headRev = op.seq;
              headTouched = true;
            }
            break;
        }
      }
      database
        .prepare(
          "UPDATE timelines SET head_seq = MAX(head_seq, ?), updated_at_ms = ?" +
            (headTouched ? ", head_json = ?, head_rev = ?" : "") +
            " WHERE id = ?",
        )
        .run(
          ...(headTouched
            ? [headSeq, nowMs, JSON.stringify(head), headRev, id]
            : [headSeq, nowMs, id]),
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  /* --------------------------------- 读取 --------------------------------- */

  /** 回合序号最大的那个（没有条目是 `undefined`）。 */
  maxTurn(id: string): number | undefined {
    const row = this.database
      .prepare(
        "SELECT MAX(turn) AS turn FROM timeline_items WHERE timeline_id = ? AND deleted = 0",
      )
      .get(id) as { turn: number | null };
    return row.turn ?? undefined;
  }

  /** 尾部 `turns` 个回合的条目（按显示顺序）。 */
  tailItems(id: string, turns: number): TimelineItem[] {
    const cut = this.database
      .prepare(
        "SELECT MIN(turn) AS turn FROM (SELECT DISTINCT turn FROM timeline_items " +
          "WHERE timeline_id = ? AND deleted = 0 ORDER BY turn DESC LIMIT ?)",
      )
      .get(id, turns) as { turn: number | null };
    if (cut.turn === null) return [];
    return this.itemsWhere("timeline_id = ? AND deleted = 0 AND turn >= ?", [
      id,
      cut.turn,
    ]);
  }

  private itemsWhere(
    where: string,
    params: (string | number)[],
  ): TimelineItem[] {
    const rows = this.database
      .prepare(
        `SELECT data_json FROM timeline_items WHERE ${where} ORDER BY turn, ord, item_id`,
      )
      .all(...params) as { data_json: string | null }[];
    const items: TimelineItem[] = [];
    for (const row of rows) {
      const item = itemOf(row.data_json);
      if (item !== null) items.push(item);
    }
    return items;
  }

  /** 写入器的内存状态：序号、头部值与尾部 `turns` 个回合。 */
  loadState(id: string, turns: number = DEFAULT_TAIL_TURNS): TimelineState {
    const row = this.get(id);
    const items: Record<string, TimelineItem> = {};
    for (const item of this.tailItems(id, turns)) items[item.id] = item;
    return {
      seq: row?.headSeq ?? 0,
      head: row?.head ?? {},
      headRev: row?.headRev ?? 0,
      items,
      tombstones: {},
    };
  }

  /** `timeline.open`：尾部回合 + 回合索引 + 头部值（活动由调用方补）。 */
  snapshot(
    id: string,
    tailTurns: number = DEFAULT_TAIL_TURNS,
  ): Omit<TimelineSnapshot, "activity"> | undefined {
    const row = this.get(id);
    if (row === undefined) return undefined;
    return {
      headSeq: row.headSeq,
      head: row.head,
      headRev: row.headRev,
      turns: this.turnIndex(id),
      items: this.tailItems(id, tailTurns),
    };
  }

  /** `timeline.sync`：`rev > after` 的条目（含墓碑）；头部值变了才带。 */
  sync(id: string, after: number): TimelineSyncResult | undefined {
    const row = this.get(id);
    if (row === undefined) return undefined;
    if (after > row.headSeq) throw new CursorAheadError(after, row.headSeq);
    const rows = this.database
      .prepare(
        "SELECT item_id, rev, deleted, data_json FROM timeline_items " +
          "WHERE timeline_id = ? AND rev > ? ORDER BY rev",
      )
      .all(id, after) as {
      item_id: string;
      rev: number;
      deleted: number;
      data_json: string | null;
    }[];
    const items: TimelineItemRecord[] = [];
    for (const raw of rows) {
      if (raw.deleted !== 0) {
        items.push({ id: raw.item_id, rev: Number(raw.rev), deleted: true });
        continue;
      }
      const item = itemOf(raw.data_json);
      if (item !== null) items.push(item);
    }
    return {
      headSeq: row.headSeq,
      ...(row.headRev > after ? { head: row.head, headRev: row.headRev } : {}),
      items,
    };
  }

  /** `timeline.page`：`beforeTurn` 之前的 `turns` 个回合。 */
  page(
    id: string,
    beforeTurn: number,
    turns: number = DEFAULT_PAGE_TURNS,
  ): TimelineItem[] | undefined {
    if (this.get(id) === undefined) return undefined;
    const cut = this.database
      .prepare(
        "SELECT MIN(turn) AS turn FROM (SELECT DISTINCT turn FROM timeline_items " +
          "WHERE timeline_id = ? AND deleted = 0 AND turn < ? ORDER BY turn DESC LIMIT ?)",
      )
      .get(id, beforeTurn, turns) as { turn: number | null };
    if (cut.turn === null) return [];
    return this.itemsWhere(
      "timeline_id = ? AND deleted = 0 AND turn >= ? AND turn < ?",
      [id, cut.turn, beforeTurn],
    );
  }

  /**
   * 全部回合的索引。口径与共享层 `turnIndexOf` 一致（测试对拍）：回合条目给
   * `turnId` / 起止，第一条用户消息给 `headText`（前 80 字）。
   */
  turnIndex(id: string): TurnIndex[] {
    const rows = this.database
      .prepare(
        "SELECT turn, kind, " +
          "json_extract(data_json, '$.at') AS at, " +
          "json_extract(data_json, '$.turnId') AS turn_id, " +
          "json_extract(data_json, '$.startedAt') AS started_at, " +
          "json_extract(data_json, '$.endedAt') AS ended_at, " +
          "CASE WHEN kind = 'user' THEN substr(json_extract(data_json, '$.text'), 1, 80) END AS head_text " +
          "FROM timeline_items WHERE timeline_id = ? AND deleted = 0 ORDER BY turn, ord, item_id",
      )
      .all(id) as {
      turn: number;
      kind: string;
      at: number | null;
      turn_id: string | null;
      started_at: number | null;
      ended_at: number | null;
      head_text: string | null;
    }[];
    const byTurn = new Map<number, TurnIndex>();
    for (const row of rows) {
      let entry = byTurn.get(row.turn);
      if (entry === undefined) {
        entry = {
          turnId: `turn-${row.turn}`,
          turn: row.turn,
          startedAt: Number(row.at ?? 0),
          headText: "",
          counts: { items: 0, tools: 0, thoughts: 0, messages: 0 },
        };
        byTurn.set(row.turn, entry);
      }
      if (row.kind === "turn") {
        if (row.turn_id !== null) entry.turnId = row.turn_id;
        if (row.started_at !== null) entry.startedAt = Number(row.started_at);
        if (row.ended_at !== null) entry.endedAt = Number(row.ended_at);
        continue;
      }
      entry.counts.items++;
      if (row.kind === "tool") entry.counts.tools++;
      else if (row.kind === "thought") entry.counts.thoughts++;
      else if (row.kind === "assistant") entry.counts.messages++;
      else if (row.kind === "user" && entry.headText === "") {
        entry.headText = Array.from(row.head_text ?? "")
          .slice(0, 80)
          .join("");
      }
    }
    return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  }
}
