import type { DatabaseSync } from "node:sqlite";
import { WORK_ITEM_STAGES, type WorkItemStage } from "@armadra/shared";
import { NOT_RECEIPT } from "../collab/mailbox";
import {
  type ReportState,
  type TaskRun,
  type WorkAttention,
  type WorkReport,
  taskRun,
} from "./task-runs";

/**
 * 协调者的工作项账本（#682）：`workflow_task_runs` 的每一行就是一个工作项，这里
 * 管它的报告、回交与阶段。
 *
 * 三条规矩：
 *
 *   * **授权派发时定死。** 标题、来源与授权由 `open-agent --task-id` / `team`
 *     写一次（`task-runs.ts::recordTaskStart`），这里只写报告与待决问题。
 *   * **待决问题是单槽。** 报告给出问题就替换，省略就保持，显式清除才清；一个
 *     成员同时只问人一件事，问第二件之前第一件要么答了、要么清了。
 *   * **阶段从事实推出来**（{@link itemStage}），不存、也不让 Agent 自己设：存下来
 *     的阶段迟早与事实对不上，而 Agent 自己说的「完成了」只是一条报告。
 */

/** 报告摘要最多这么多字。 */
export const MAX_SUMMARY_CHARS = 300;
/** 待决问题最多这么多字。 */
export const MAX_QUESTION_CHARS = 500;
/** 回交理由最多这么多字。 */
export const MAX_HANDBACK_CHARS = 100;

export type ItemStage = WorkItemStage;

/** 列表排序：要人处理的在前（与页面同一份顺序，`@armadra/shared`）。 */
export const STAGE_ORDER: readonly ItemStage[] = WORK_ITEM_STAGES;

export interface HistoryEntry {
  readonly seq: number;
  readonly kind: "report" | "handback";
  readonly state: ReportState | null;
  readonly summary: string;
  readonly humanAction: string | null;
  readonly at: number;
}

/** 报告怎么动待决问题：给出就换，省略就留，`clear` 就清。 */
export type AttentionChange =
  | { readonly kind: "keep" }
  | { readonly kind: "set"; readonly question: string }
  | { readonly kind: "clear" };

function nextSeq(database: DatabaseSync, taskId: string): number {
  const row = database
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM workflow_task_reports WHERE task_id = ?",
    )
    .get(taskId) as { seq: number };
  return Number(row.seq) + 1;
}

/**
 * 记一次报告：写历史、换「最近一次报告」、按 {@link AttentionChange} 动单槽。
 * 一个事务里做完，答这次的序号与写完之后的那一行。
 */
export function recordReport(
  database: DatabaseSync,
  taskId: string,
  report: {
    readonly state: ReportState;
    readonly summary: string;
    readonly attention: AttentionChange;
  },
  now: number,
): { readonly seq: number; readonly run: TaskRun } {
  database.exec("BEGIN IMMEDIATE");
  try {
    const seq = nextSeq(database, taskId);
    const question =
      report.attention.kind === "set" ? report.attention.question : null;
    database
      .prepare(
        "INSERT INTO workflow_task_reports (task_id, seq, kind, state, summary, human_action, at) " +
          "VALUES (?, ?, 'report', ?, ?, ?, ?)",
      )
      .run(taskId, seq, report.state, report.summary, question, now);
    const latest: WorkReport = {
      state: report.state,
      summary: report.summary,
      at: now,
    };
    if (report.attention.kind === "keep") {
      database
        .prepare(
          "UPDATE workflow_task_runs SET report_json = ? WHERE task_id = ?",
        )
        .run(JSON.stringify(latest), taskId);
    } else {
      const attention: WorkAttention | null =
        report.attention.kind === "set"
          ? { question: report.attention.question, raisedAt: now }
          : null;
      database
        .prepare(
          "UPDATE workflow_task_runs SET report_json = ?, attention_json = ? WHERE task_id = ?",
        )
        .run(
          JSON.stringify(latest),
          attention === null ? null : JSON.stringify(attention),
          taskId,
        );
    }
    database.exec("COMMIT");
    return { seq, run: taskRun(database, taskId) as TaskRun };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** 这一项交回过没有。 */
export function handedBack(database: DatabaseSync, taskId: string): boolean {
  const row = database
    .prepare(
      "SELECT 1 AS one FROM workflow_task_reports WHERE task_id = ? AND kind = 'handback' LIMIT 1",
    )
    .get(taskId);
  return row !== undefined;
}

/**
 * 记一次回交。同一项只能一次：答 `undefined` 表示已经交回过，调用方据此拒绝。
 * 回交不动最近一次报告与待决问题——交回的是「这件事要协调者重新决定」，不是
 * 成员对进度的说法。
 */
export function recordHandback(
  database: DatabaseSync,
  taskId: string,
  reason: string,
  now: number,
): number | undefined {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (handedBack(database, taskId)) {
      database.exec("ROLLBACK");
      return undefined;
    }
    const seq = nextSeq(database, taskId);
    database
      .prepare(
        "INSERT INTO workflow_task_reports (task_id, seq, kind, state, summary, human_action, at) " +
          "VALUES (?, ?, 'handback', NULL, ?, NULL, ?)",
      )
      .run(taskId, seq, reason, now);
    database.exec("COMMIT");
    return seq;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** 最近的 `limit` 条历史，新的在后。 */
export function itemHistory(
  database: DatabaseSync,
  taskId: string,
  limit = 10,
): HistoryEntry[] {
  const rows = database
    .prepare(
      "SELECT seq, kind, state, summary, human_action, at FROM workflow_task_reports " +
        "WHERE task_id = ? ORDER BY seq DESC LIMIT ?",
    )
    .all(taskId, limit) as unknown as {
    seq: number;
    kind: string;
    state: string | null;
    summary: string;
    human_action: string | null;
    at: number;
  }[];
  return rows.reverse().map((row) => ({
    seq: Number(row.seq),
    kind: row.kind === "handback" ? "handback" : "report",
    state: (row.state as ReportState | null) ?? null,
    summary: row.summary,
    humanAction: row.human_action,
    at: Number(row.at),
  }));
}

/** 一个成员节点名下还没结束的工作项，新的在前。 */
export function openItemsOf(database: DatabaseSync, nodeId: string): string[] {
  const rows = database
    .prepare(
      "SELECT task_id FROM workflow_task_runs WHERE node_id = ? AND status = 'running' ORDER BY started_at DESC",
    )
    .all(nodeId) as unknown as { task_id: string }[];
  return rows.map((row) => row.task_id);
}

/** 一个成员节点名下最近的那一项（不论结束没有）。 */
export function latestItemOf(
  database: DatabaseSync,
  nodeId: string,
): string | undefined {
  const row = database
    .prepare(
      "SELECT task_id FROM workflow_task_runs WHERE node_id = ? ORDER BY started_at DESC LIMIT 1",
    )
    .get(nodeId) as { task_id: string } | undefined;
  return row?.task_id;
}

/* --------------------------------- 阶段 ---------------------------------- */

/** 推阶段要的那几件事实，除了工作项自己那一行。 */
export interface StageFacts {
  /** 最近一次报告之后（没有报告就是开始之后），有发给成员的投递过期没投成。 */
  readonly deliveryFailed: boolean;
  /** 成员节点还没起来：没有活着的终端会话，或在依赖后面排队。 */
  readonly queued: boolean;
  /** 成员节点空闲，收件箱里也没有未读。 */
  readonly idle: boolean;
}

/**
 * 工作项现在在哪一步（#682），首个命中即答：
 *
 *   1. `person/delivery`：发给成员的东西没投成；
 *   2. `person/answer`：成员在等人回答一个问题；
 *   3. `person/review`：成员说做好了，等人验收；
 *   4. `person/blocked` / `person/failed`：成员报阻塞 / 失败，或者任务本身失败了；
 *   5. 已经结束（`done` / `stopped`）且不等人：就是结束；
 *   6. `working/queued`：节点还没起来；
 *   7. `idle`：成员报「在等」，或者节点空闲且没有未读；
 *   8. `working`。
 *
 * 前四条在任务结束之后照样成立：一项做完了等人验收，比「做完了」更要紧。
 */
export function itemStage(run: TaskRun, facts: StageFacts): ItemStage {
  const report = run.report?.state;
  if (facts.deliveryFailed && run.status === "running")
    return "person/delivery";
  if (run.attention !== null) return "person/answer";
  if (report === "ready") return "person/review";
  if (report === "blocked") return "person/blocked";
  if (report === "failed" || run.status === "failed") return "person/failed";
  if (run.status === "done") return "done";
  if (run.status === "stopped") return "stopped";
  if (facts.queued) return "working/queued";
  if (report === "waiting" || facts.idle) return "idle";
  return "working";
}

/** 从库里读出 {@link StageFacts}。`nowSeconds` 用于判断收件箱里的未读有没有过期。 */
export function stageFacts(
  database: DatabaseSync,
  run: TaskRun,
  nowSeconds: number,
): StageFacts {
  const since = Math.floor((run.report?.at ?? run.startedAt) / 1000);
  const expired = database
    .prepare(
      "SELECT 1 AS one FROM agent_send_queue WHERE target_node_id = ? AND state = 'expired' " +
        "AND created_at >= ? LIMIT 1",
    )
    .get(run.nodeId, since);
  const live = database
    .prepare(
      "SELECT 1 AS one FROM terminal_sessions WHERE owner_node_id = ? AND status = 'running' LIMIT 1",
    )
    .get(run.nodeId);
  const waiting = database
    .prepare(
      "SELECT 1 AS one FROM agent_dependency_launches WHERE node_id = ? AND state = 'waiting' LIMIT 1",
    )
    .get(run.nodeId);
  const status = database
    .prepare("SELECT state, restored FROM agent_status WHERE node_id = ?")
    .get(run.nodeId) as { state: string | null; restored: number } | undefined;
  const unread = database
    .prepare(
      "SELECT 1 AS one FROM agent_mailbox WHERE target_node_id = ? AND acknowledged_at IS NULL " +
        `AND expires_at > ? AND ${NOT_RECEIPT} LIMIT 1`,
    )
    .get(run.nodeId, nowSeconds);
  const settled =
    status !== undefined &&
    !Number(status.restored) &&
    (status.state === "idle" ||
      status.state === "done" ||
      status.state === "error");
  return {
    deliveryFailed: expired !== undefined,
    queued: live === undefined || waiting !== undefined,
    idle: live !== undefined && settled && unread === undefined,
  };
}

/** 一行的阶段：{@link stageFacts} 加 {@link itemStage}。 */
export function stageOf(
  database: DatabaseSync,
  run: TaskRun,
  nowSeconds: number,
): ItemStage {
  return itemStage(run, stageFacts(database, run, nowSeconds));
}
