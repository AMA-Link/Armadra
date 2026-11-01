import type { DatabaseSync } from "node:sqlite";
import type { WorkItemReportState, WorkItemStage } from "@armadra/shared";
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

/** 来源（契约 §90.1）：`human` 是人在协调者终端里说的那一回合。 */
export const ITEM_ORIGIN_KINDS = [
  "human",
  "inbox",
  "schedule",
  "external",
] as const;
export interface WorkItemOrigin {
  readonly kind: (typeof ITEM_ORIGIN_KINDS)[number];
  readonly ref: string;
  readonly text?: string;
}

/** 授权：派发时写入，之后不可改。 */
export interface WorkItemMandate {
  readonly by: string;
  readonly basis: "asked" | "rule";
  readonly scope: string;
  readonly at: string;
}

export interface WorkItemReport {
  readonly state: WorkItemReportState;
  readonly summary: string;
  readonly at: string;
}

export interface WorkItemAttention {
  readonly question: string;
  readonly raisedAt: string;
}

export interface WorkItemHandback {
  readonly reason: string;
  readonly at: string;
}

/** 报告历史最多留多少条（含最近一次）。 */
export const MAX_REPORT_HISTORY = 20;
/** 标题上限（字）。 */
export const MAX_TITLE_CHARS = 80;

export interface TaskRun {
  readonly taskId: string;
  readonly coordinatorNodeId: string;
  readonly runnerId: string;
  readonly nodeId: string;
  readonly status: TaskRunStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly result: unknown;
  /** 工作项账本（迁移 0058）。旧行这些列是空的。 */
  readonly title: string | null;
  readonly origin: WorkItemOrigin | null;
  readonly mandate: WorkItemMandate | null;
  readonly report: WorkItemReport | null;
  readonly reports: readonly WorkItemReport[];
  readonly attention: WorkItemAttention | null;
  readonly handback: WorkItemHandback | null;
  /** 阶段函数结果的缓存；以 `itemStage()` 为准。 */
  readonly stage: string | null;
}

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
  reports_json: string | null;
  attention_json: string | null;
  handback_json: string | null;
  stage: string | null;
}

const COLUMNS =
  "task_id, coordinator_node_id, runner_id, node_id, status, started_at, ended_at, result_json, " +
  "title, origin_json, mandate_json, report_json, reports_json, attention_json, handback_json, stage";

function parsed<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" ? (value as T) : null;
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
    title: row.title,
    origin: parsed<WorkItemOrigin>(row.origin_json),
    mandate: parsed<WorkItemMandate>(row.mandate_json),
    report: parsed<WorkItemReport>(row.report_json),
    reports: (() => {
      if (row.reports_json === null) return [];
      try {
        const list = JSON.parse(row.reports_json) as unknown;
        return Array.isArray(list) ? (list as WorkItemReport[]) : [];
      } catch {
        return [];
      }
    })(),
    attention: parsed<WorkItemAttention>(row.attention_json),
    handback: parsed<WorkItemHandback>(row.handback_json),
    stage: row.stage,
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
    /** 标题（派发时给出，截到 {@link MAX_TITLE_CHARS} 字）。 */
    readonly title?: string | undefined;
    /** 来源；缺省是人在协调者终端里说的那一回合，原文是任务正文。 */
    readonly origin?: WorkItemOrigin | undefined;
  },
): { readonly inserted: boolean; readonly run: TaskRun } {
  const title = oneLine(task.title);
  const origin: WorkItemOrigin = task.origin ?? {
    kind: "human",
    ref: task.coordinatorNodeId,
    ...(task.task === undefined ? {} : { text: task.task }),
  };
  // 授权派发时写入，之后没有任何一条语句改它。
  const mandate: WorkItemMandate = {
    by: task.coordinatorNodeId,
    basis: "asked",
    scope: "dispatch",
    at: new Date(task.now).toISOString(),
  };
  const changes = database
    .prepare(
      "INSERT OR IGNORE INTO workflow_task_runs (task_id, coordinator_node_id, runner_id, node_id, " +
        "status, started_at, ended_at, result_json, title, origin_json, mandate_json) " +
        "VALUES (?, ?, ?, ?, 'running', ?, NULL, ?, ?, ?, ?)",
    )
    .run(
      task.taskId,
      task.coordinatorNodeId,
      task.runnerId,
      task.nodeId,
      task.now,
      task.task === undefined ? null : JSON.stringify({ task: task.task }),
      title ?? null,
      JSON.stringify(origin),
      JSON.stringify(mandate),
    );
  return {
    inserted: Number(changes.changes) > 0,
    run: taskRun(database, task.taskId) as TaskRun,
  };
}

/** 一行标题：折掉换行与多余空白，截到上限；空的当没有。 */
export function oneLine(
  text: string | undefined,
  limit = MAX_TITLE_CHARS,
): string | undefined {
  if (text === undefined) return undefined;
  const folded = text.replace(/\s+/g, " ").trim();
  if (folded === "") return undefined;
  return [...folded].slice(0, limit).join("");
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

/**
 * 重试时节点已经不在了：换成新起的那个节点，状态回到 `running`。重新开始一次，
 * 上一次的最近报告与待决问题作废（报告历史、授权、来源留着）。
 */
export function rebindTask(
  database: DatabaseSync,
  taskId: string,
  nodeId: string,
  now: number,
): void {
  database
    .prepare(
      "UPDATE workflow_task_runs SET node_id = ?, status = 'running', started_at = ?, " +
        "ended_at = NULL, result_json = ?, report_json = NULL, attention_json = NULL " +
        "WHERE task_id = ?",
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
  stage: WorkItemStage,
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
    title: run.title,
    stage,
    report: run.report,
    attention: run.attention,
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
