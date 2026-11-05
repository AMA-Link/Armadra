import type { DatabaseSync } from "node:sqlite";
import { type PullThread, type TaskRun, taskRun } from "./task-runs";

/**
 * 工作项绑定的外部线程（契约 §103，#705）：绑定的读写，和轮询读到的事件的账
 * （`thread_events`）。轮询本身在 `pr-watch.ts`，投递在 `collab/pr-fanout.ts`。
 *
 * 账表是去重的唯一依据：事件 id 确定，同一个 id 在一个工作项里只记一次，所以
 * 重放同一段响应、重启后从头再读，都不会产生第二条事件，也不会把同一条评论再
 * 投给成员一次。
 */

/** 一个工作项最多绑这么多个 PR。 */
export const MAX_THREADS = 5;
/** 同一个机器人在一个 PR 上最多投几轮；之后只记账。 */
export const MAX_BOT_ROUNDS = 3;
/** 结束多久之后不再轮询（毫秒）。 */
export const POLL_RETENTION_MS = 14 * 24 * 3_600_000;

export type ThreadEventKind = "comment" | "review" | "checks" | "state";

/** 线程的显示名与事件 id 里的写法：`<仓库>#<编号>`。 */
export function threadKey(thread: Pick<PullThread, "repo" | "number">): string {
  return `${thread.repo}#${thread.number}`;
}

export type BindResult =
  | { readonly kind: "bound"; readonly run: TaskRun }
  | { readonly kind: "unchanged"; readonly run: TaskRun }
  | { readonly kind: "full"; readonly run: TaskRun };

/**
 * 给工作项绑一个 PR。同一个 PR（仓库 + 编号）再绑只会把 `own` 升成 `true`
 * （自己开的不会被降成只看），其余不动，所以成员每次 `report --pr` 都带着编号
 * 也不会重复。
 */
export function bindPull(
  database: DatabaseSync,
  taskId: string,
  pull: {
    readonly repo: string;
    readonly number: number;
    readonly own: boolean;
    readonly url: string;
  },
  nowMs: number,
): BindResult {
  const run = taskRun(database, taskId) as TaskRun;
  const existing = run.threads.find(
    (thread) => thread.repo === pull.repo && thread.number === pull.number,
  );
  let next: PullThread[];
  if (existing !== undefined) {
    if (existing.own || !pull.own) return { kind: "unchanged", run };
    next = run.threads.map((thread) =>
      thread === existing ? { ...thread, own: true } : thread,
    );
  } else {
    if (run.threads.length >= MAX_THREADS) return { kind: "full", run };
    next = [
      ...run.threads,
      {
        kind: "pull",
        repo: pull.repo,
        number: pull.number,
        own: pull.own,
        url: pull.url,
        boundAt: nowMs,
      },
    ];
  }
  database
    .prepare("UPDATE workflow_task_runs SET threads = ? WHERE task_id = ?")
    .run(JSON.stringify(next), taskId);
  return { kind: "bound", run: taskRun(database, taskId) as TaskRun };
}

export interface NewThreadEvent {
  readonly itemId: string;
  readonly eventId: string;
  readonly thread: Pick<PullThread, "repo" | "number">;
  readonly kind: ThreadEventKind;
  readonly actor?: string | null;
  readonly delivered: boolean;
  readonly sourceAt: number;
}

/** 记一个事件。已经记过就什么也不做；答这次是不是新记的。 */
export function recordThreadEvent(
  database: DatabaseSync,
  event: NewThreadEvent,
  nowMs: number,
): boolean {
  const changes = database
    .prepare(
      "INSERT OR IGNORE INTO thread_events (item_id, event_id, repo, number, kind, actor, delivered, source_at, seen_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      event.itemId,
      event.eventId.slice(0, 300),
      event.thread.repo,
      event.thread.number,
      event.kind,
      event.actor ?? null,
      event.delivered ? 1 : 0,
      event.sourceAt,
      nowMs,
    );
  return Number(changes.changes) > 0;
}

/** 这个机器人在这个 PR 上已经投过几条（记账不投的不算）。 */
export function botRounds(
  database: DatabaseSync,
  itemId: string,
  thread: Pick<PullThread, "repo" | "number">,
  actor: string,
): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS total FROM thread_events WHERE item_id = ? AND repo = ? AND number = ? " +
        "AND actor = ? AND delivered = 1",
    )
    .get(itemId, thread.repo, thread.number, actor) as { total: number };
  return Number(row.total);
}

/**
 * 轮询游标：这个线程里评论和评审读到过的最晚的远端时刻；一条都没有就是绑定的
 * 时刻。读的时候再往回退 5 秒（调用方），防止漏读。
 */
export function threadCursor(
  database: DatabaseSync,
  itemId: string,
  thread: PullThread,
): number {
  const row = database
    .prepare(
      "SELECT MAX(source_at) AS at FROM thread_events WHERE item_id = ? AND repo = ? AND number = ? " +
        "AND kind IN ('comment','review')",
    )
    .get(itemId, thread.repo, thread.number) as { at: number | null };
  return Math.max(thread.boundAt, row.at === null ? 0 : Number(row.at));
}

/** 这个线程的终态（`merged` / `closed`）；PR 还开着是 `null`。 */
export function threadOutcome(
  database: DatabaseSync,
  itemId: string,
  thread: Pick<PullThread, "repo" | "number">,
): "merged" | "closed" | null {
  const row = database
    .prepare(
      "SELECT event_id FROM thread_events WHERE item_id = ? AND repo = ? AND number = ? AND kind = 'state' " +
        "ORDER BY source_at DESC LIMIT 1",
    )
    .get(itemId, thread.repo, thread.number) as
    | { event_id?: string }
    | undefined;
  if (row?.event_id === undefined) return null;
  return row.event_id.endsWith(":merged") ? "merged" : "closed";
}

/** 要轮询的工作项：活着的，或结束不到 14 天的；而且绑了线程。 */
export function pollableItems(
  database: DatabaseSync,
  nowMs: number,
  limit = 100,
): TaskRun[] {
  const rows = database
    .prepare(
      "SELECT task_id FROM workflow_task_runs WHERE threads IS NOT NULL AND threads <> '[]' " +
        "AND (status = 'running' OR COALESCE(ended_at, 0) >= ?) ORDER BY started_at DESC LIMIT ?",
    )
    .all(nowMs - POLL_RETENTION_MS, limit) as { task_id: string }[];
  return rows.map((row) => taskRun(database, row.task_id) as TaskRun);
}
