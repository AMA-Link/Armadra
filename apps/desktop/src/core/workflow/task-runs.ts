import type { DatabaseSync } from "node:sqlite";
import {
  WORK_REPORT_STATES,
  type WorkItemStage,
  type WorkReportState,
} from "@armadra/shared";
import type { WorkspaceEvent } from "../bus";

/**
 * `workflow_task_runs`：协调者的 `task(agent=…)` 经画布节点执行的记录（补全
 * 架构 §5.3）。这里只有存取；`wait` 动词与 runner 适配器由 G2-4 接上（契约
 * §15.5）。
 *
 * `task_id` 是幂等键：ama 崩溃重试同一个任务时，`start` 先查这里——已有一行且
 * 节点还在，就直接返回那个节点，不起第二个。
 */

export const TASK_RUN_STATUSES = [
  "running",
  "done",
  "failed",
  "stopped",
] as const;
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

export interface TaskRun {
  readonly taskId: string;
  readonly coordinatorNodeId: string;
  readonly runnerId: string;
  readonly nodeId: string;
  readonly status: TaskRunStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly result: unknown;
  /** 工作项账本（#682，迁移 0058）：一行标题；旧行没有。 */
  readonly title: string | null;
  readonly origin: WorkOrigin | null;
  readonly mandate: WorkMandate | null;
  readonly report: WorkReport | null;
  readonly attention: WorkAttention | null;
}

/** 来源：谁的原话。`text` 截到 {@link MAX_ORIGIN_CHARS}。 */
export interface WorkOrigin {
  readonly kind: "coordinator" | "team";
  readonly ref: string;
  readonly text?: string;
}

/** 授权：派发时定下，之后不改（#682）。 */
export interface WorkMandate {
  readonly by: { readonly nodeId: string; readonly title: string };
  readonly basis: "asked";
  readonly scope: string;
  readonly at: number;
}

export const REPORT_STATES = WORK_REPORT_STATES;
export type ReportState = WorkReportState;

/** 最近一次报告。 */
export interface WorkReport {
  readonly state: ReportState;
  readonly summary: string;
  readonly at: number;
}

/** 待人决定的那一个问题（单槽）。 */
export interface WorkAttention {
  readonly question: string;
  readonly raisedAt: number;
}

/** 来源原文最多存这么多字。 */
export const MAX_ORIGIN_CHARS = 8_000;

interface TaskRunRecord {
  task_id: string;
  coordinator_node_id: string;
  runner_id: string;
  node_id: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  result_json: string | null;
  title: string | null;
  origin_json: string | null;
  mandate_json: string | null;
  report_json: string | null;
  attention_json: string | null;
}

/** `recordTaskStart` 插入的那几列；账本的列由它单独补写。 */
const INSERT_COLUMNS =
  "task_id, coordinator_node_id, runner_id, node_id, status, started_at, ended_at, result_json";

const COLUMNS = `${INSERT_COLUMNS}, title, origin_json, mandate_json, report_json, attention_json`;

/** 库里的 JSON 列：坏了就当没有，账本不因一行坏数据整个读不出来。 */
function parsed<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function taskRunOf(row: TaskRunRecord): TaskRun {
  let result: unknown = null;
  if (row.result_json !== null) {
    try {
      result = JSON.parse(row.result_json) as unknown;
    } catch {
      result = null;
    }
  }
  return {
    taskId: row.task_id,
    coordinatorNodeId: row.coordinator_node_id,
    runnerId: row.runner_id,
    nodeId: row.node_id,
    status: row.status as TaskRunStatus,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    result,
    title: row.title ?? null,
    origin: parsed<WorkOrigin>(row.origin_json),
    mandate: parsed<WorkMandate>(row.mandate_json),
    report: parsed<WorkReport>(row.report_json),
    attention: parsed<WorkAttention>(row.attention_json),
  };
}

/**
 * 记一次 `start`。同一个 `taskId` 已经有一行就原样答回去（`inserted: false`），
 * 调用方据此判断节点还在不在、要不要复用。
 */
export function recordTaskStart(
  database: DatabaseSync,
  task: {
    readonly taskId: string;
    readonly coordinatorNodeId: string;
    readonly runnerId: string;
    readonly nodeId: string;
    readonly now: number;
    /**
     * 第一条任务的正文（`--task`）。记在 `result_json.task`：分派抽屉的「重试」
     * 要把它再投一次（G5-09）；结束时写进的 `text` / `reason` 与它并存。
     */
    readonly task?: string | undefined;
    /** 账本（#682）：标题、来源与授权，只在第一次插入时写。 */
    readonly title?: string | undefined;
    readonly origin?: WorkOrigin | undefined;
    readonly mandate?: WorkMandate | undefined;
  },
): { readonly inserted: boolean; readonly run: TaskRun } {
  const changes = database
    .prepare(
      `INSERT OR IGNORE INTO workflow_task_runs (${INSERT_COLUMNS}, title, origin_json, mandate_json) ` +
        "VALUES (?, ?, ?, ?, 'running', ?, NULL, ?, ?, ?, ?)",
    )
    .run(
      task.taskId,
      task.coordinatorNodeId,
      task.runnerId,
      task.nodeId,
      task.now,
      task.task === undefined ? null : JSON.stringify({ task: task.task }),
      task.title ?? null,
      task.origin === undefined ? null : JSON.stringify(task.origin),
      task.mandate === undefined ? null : JSON.stringify(task.mandate),
    );
  return {
    inserted: Number(changes.changes) > 0,
    run: taskRun(database, task.taskId) as TaskRun,
  };
}

export function taskRun(
  database: DatabaseSync,
  taskId: string,
): TaskRun | undefined {
  const row = database
    .prepare(`SELECT ${COLUMNS} FROM workflow_task_runs WHERE task_id = ?`)
    .get(taskId) as TaskRunRecord | undefined;
  return row === undefined ? undefined : taskRunOf(row);
}

/** 任务行里记着的第一条任务正文；没带 `--task` 起的任务没有。 */
export function taskPrompt(run: TaskRun): string | undefined {
  const result = run.result;
  if (result === null || typeof result !== "object") return undefined;
  const task = (result as { task?: unknown }).task;
  return typeof task === "string" && task !== "" ? task : undefined;
}

/** 只留下任务正文的 `result_json`（重开一次时用）。 */
function promptOnly(run: TaskRun | undefined): string | null {
  const task = run === undefined ? undefined : taskPrompt(run);
  return task === undefined ? null : JSON.stringify({ task });
}

/** 重试时节点已经不在了：换成新起的那个节点，状态回到 `running`。 */
export function rebindTask(
  database: DatabaseSync,
  taskId: string,
  nodeId: string,
  now: number,
): void {
  database
    .prepare(
      // 重来一次：上一轮的报告与待决问题作废（历史留在 workflow_task_reports）。
      "UPDATE workflow_task_runs SET node_id = ?, status = 'running', started_at = ?, " +
        "ended_at = NULL, result_json = ?, report_json = NULL, attention_json = NULL WHERE task_id = ?",
    )
    .run(nodeId, now, promptOnly(taskRun(database, taskId)), taskId);
}

/**
 * 人从分派抽屉点「重试」：已结束的任务回到 `running`、重新计时，节点不变。
 * 只有 `failed` / `stopped` 的才改，答有没有改到。
 */
export function reopenTask(
  database: DatabaseSync,
  taskId: string,
  now: number,
): boolean {
  const changes = database
    .prepare(
      "UPDATE workflow_task_runs SET status = 'running', started_at = ?, ended_at = NULL, " +
        "result_json = ?, report_json = NULL, attention_json = NULL " +
        "WHERE task_id = ? AND status IN ('failed','stopped')",
    )
    .run(now, promptOnly(taskRun(database, taskId)), taskId);
  return Number(changes.changes) > 0;
}

/** 结束一次任务。只有还在 `running` 的才改，答有没有改到。 */
export function finishTask(
  database: DatabaseSync,
  taskId: string,
  status: Exclude<TaskRunStatus, "running">,
  result: unknown,
  now: number,
): boolean {
  // 起任务时记下的正文（`task`）留着：结束写的是 `text` / `reason`，两者并存。
  const previous = taskRun(database, taskId);
  const task = previous === undefined ? undefined : taskPrompt(previous);
  const merged =
    task === undefined
      ? result
      : result !== null && typeof result === "object" && !Array.isArray(result)
        ? { ...(result as Record<string, unknown>), task }
        : { task };
  const changes = database
    .prepare(
      "UPDATE workflow_task_runs SET status = ?, ended_at = ?, result_json = ? " +
        "WHERE task_id = ? AND status = 'running'",
    )
    .run(
      status,
      now,
      merged === undefined || merged === null ? null : JSON.stringify(merged),
      taskId,
    );
  return Number(changes.changes) > 0;
}

export function taskRunsFor(
  database: DatabaseSync,
  coordinatorNodeId: string,
): TaskRun[] {
  const rows = database
    .prepare(
      `SELECT ${COLUMNS} FROM workflow_task_runs WHERE coordinator_node_id = ? ORDER BY started_at DESC`,
    )
    .all(coordinatorNodeId) as unknown as TaskRunRecord[];
  return rows.map(taskRunOf);
}

/**
 * 一块画板上的任务行（分派抽屉，契约 §15.7）：协调者节点在这块板上的。新的在
 * 前，最多 `limit` 行。
 */
export function taskRunsForBoard(
  database: DatabaseSync,
  boardId: string,
  limit = 200,
): TaskRun[] {
  const rows = database
    .prepare(
      `SELECT ${COLUMNS} FROM workflow_task_runs WHERE coordinator_node_id IN ` +
        "(SELECT id FROM nodes WHERE board_id = ?) ORDER BY started_at DESC LIMIT ?",
    )
    .all(boardId, limit) as unknown as TaskRunRecord[];
  return rows.map(taskRunOf);
}

/**
 * 页面看到的一行（契约 §15.7）。不带任务正文与成员的结果正文：抽屉只要状态、
 * 时刻与「能不能重试」，正文留在库里。
 */
export function taskRowJson(
  run: TaskRun,
  stage?: WorkItemStage,
): Record<string, unknown> {
  const result = run.result as { reason?: unknown } | null;
  const reason =
    result !== null &&
    typeof result === "object" &&
    typeof result.reason === "string"
      ? result.reason
      : null;
  return {
    taskId: run.taskId,
    coordinatorNodeId: run.coordinatorNodeId,
    runnerId: run.runnerId,
    nodeId: run.nodeId,
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt === null ? null : new Date(run.endedAt).toISOString(),
    reason,
    retryable:
      (run.status === "failed" || run.status === "stopped") &&
      taskPrompt(run) !== undefined,
    // 工作项账本（#682）：成员写给人看的报告与问题，不是终端原文。
    title: run.title,
    ...(stage === undefined ? {} : { stage }),
    report:
      run.report === null
        ? null
        : {
            state: run.report.state,
            summary: run.report.summary,
            at: new Date(run.report.at).toISOString(),
          },
    attention: run.attention?.question ?? null,
  };
}

export function taskRunJson(run: TaskRun): Record<string, unknown> {
  return {
    taskId: run.taskId,
    coordinatorNodeId: run.coordinatorNodeId,
    runnerId: run.runnerId,
    nodeId: run.nodeId,
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt === null ? null : new Date(run.endedAt).toISOString(),
    result: run.result ?? null,
  };
}

/**
 * 任务行换了状态时推的那一帧（契约 §15.4 的 `workflow.task`）：分派抽屉据此重读
 * §15.7，帧里不带任务正文与结果。协调者节点已经不在（拿不到画板与工作空间）
 * 时答 `undefined`，不推。
 */
export function taskEvent(
  database: DatabaseSync,
  taskId: string,
):
  | {
      readonly workspaceId: string;
      readonly event: {
        readonly type: "workflow.task";
        readonly taskId: string;
        readonly boardId: string;
        readonly coordinatorNodeId: string;
        readonly nodeId: string;
        readonly status: TaskRunStatus;
      };
    }
  | undefined {
  const run = taskRun(database, taskId);
  if (run === undefined) return undefined;
  const place = database
    .prepare(
      "SELECT n.board_id AS board_id, b.workspace_id AS workspace_id " +
        "FROM nodes n JOIN boards b ON b.id = n.board_id WHERE n.id = ?",
    )
    .get(run.coordinatorNodeId) as
    | { board_id?: unknown; workspace_id?: unknown }
    | undefined;
  if (
    typeof place?.board_id !== "string" ||
    typeof place.workspace_id !== "string"
  ) {
    return undefined;
  }
  return {
    workspaceId: place.workspace_id,
    event: {
      type: "workflow.task",
      taskId: run.taskId,
      boardId: place.board_id,
      coordinatorNodeId: run.coordinatorNodeId,
      nodeId: run.nodeId,
      status: run.status,
    },
  };
}

/** 有地方发就发一帧 {@link taskEvent}。 */
export function publishTask(
  database: DatabaseSync,
  publish: ((workspaceId: string, event: WorkspaceEvent) => void) | undefined,
  taskId: string,
): void {
  if (publish === undefined) return;
  const frame = taskEvent(database, taskId);
  if (frame !== undefined) publish(frame.workspaceId, frame.event);
}

/** 还在 `running` 的任务行（`task-watch.ts` 盯的那些），最早的在前。 */
export function runningTaskRuns(
  database: DatabaseSync,
  limit = 200,
): TaskRun[] {
  const rows = database
    .prepare(
      `SELECT ${COLUMNS} FROM workflow_task_runs WHERE status = 'running' ORDER BY started_at LIMIT ?`,
    )
    .all(limit) as unknown as TaskRunRecord[];
  return rows.map(taskRunOf);
}
