import type { DatabaseSync } from "node:sqlite";
import {
  WORK_ITEM_STAGES,
  type WorkItemReportState,
  type WorkItemStage,
} from "@armadra/shared";
import { getAgentStatus } from "../agent/status";
import { latestDelivery } from "../collab/control/wait";
import { NOT_RECEIPT } from "../collab/mailbox";
import {
  MAX_REPORT_HISTORY,
  type TaskRun,
  type WorkItemAttention,
  type WorkItemReport,
  taskRun,
} from "./task-runs";

/**
 * 工作项账本（契约 §90，#682）：阶段函数、事实的收集，与 `report` /
 * `handback` 的落库。
 *
 * **阶段只能从事实推出**：{@link itemStage} 是纯函数，Agent 没有任何办法设置
 * 它；`stage` 列只是它结果的缓存，供查询和排序，读到不一致时以函数为准。
 */

/** {@link itemStage} 的输入：都是库里查得到的事实。 */
export interface ItemStageFacts {
  /** 协调者发给成员的最近一条投递没投成（取消或过期）。 */
  readonly deliveryFailed: boolean;
  /** 有待人决定的问题。 */
  readonly attention: boolean;
  /** 最近一次报告的状态；没报告过是 `null`。 */
  readonly report: WorkItemReportState | null;
  /** 任务行自己的状态：节点没了、这一轮出错记成 `failed`。 */
  readonly runStatus: TaskRun["status"];
  /** 还没起，或在排队（首条任务在投递队列里、成员在等依赖启动）。 */
  readonly queued: boolean;
  /** 成员的 Agent 此刻空闲。 */
  readonly nodeIdle: boolean;
  /** 成员的收件箱里有没处理的未读。 */
  readonly unread: boolean;
}

/**
 * 按顺序取第一个命中的阶段（契约 §90.2）：
 *
 *   1. `person/delivery`：投递失败；
 *   2. `person/answer`：有待决问题；
 *   3. `person/review`：最近报告是 `ready`；
 *   4. `person/blocked` / `person/failed`：最近报告是 `blocked` / `failed`
 *      （任务行本身 `failed` 也算）；
 *   5. `working/queued`：还没起，或在排队；
 *   6. `idle`：最近报告是 `waiting`，或节点空闲且没有未读；
 *   7. `working`。
 */
export function itemStage(facts: ItemStageFacts): WorkItemStage {
  if (facts.deliveryFailed) return "person/delivery";
  if (facts.attention) return "person/answer";
  if (facts.report === "ready") return "person/review";
  if (facts.report === "blocked") return "person/blocked";
  if (facts.report === "failed" || facts.runStatus === "failed") {
    return "person/failed";
  }
  if (facts.queued) return "working/queued";
  if (facts.report === "waiting" || (facts.nodeIdle && !facts.unread)) {
    return "idle";
  }
  return "working";
}

/** 排序用：`person/*` 在前，其余按 {@link WORK_ITEM_STAGES} 的次序。 */
export function stageRank(stage: string): number {
  const index = (WORK_ITEM_STAGES as readonly string[]).indexOf(stage);
  return index === -1 ? WORK_ITEM_STAGES.length : index;
}

/** 收集一行的事实。 */
export function itemFacts(
  database: DatabaseSync,
  run: TaskRun,
  nowSeconds: number,
): ItemStageFacts {
  const delivery = latestDelivery(database, run.coordinatorNodeId, run.nodeId);
  const status = getAgentStatus(database, run.nodeId);
  const waitingLaunch = database
    .prepare(
      "SELECT 1 AS one FROM agent_dependency_launches WHERE node_id = ? AND state = 'waiting'",
    )
    .get(run.nodeId);
  const unread = database
    .prepare(
      "SELECT COUNT(*) AS total FROM agent_mailbox WHERE target_node_id = ? " +
        `AND acknowledged_at IS NULL AND expires_at > ? AND ${NOT_RECEIPT}`,
    )
    .get(run.nodeId, nowSeconds) as { total: number };
  return {
    deliveryFailed:
      delivery !== undefined &&
      (delivery.state === "cancelled" || delivery.state === "expired"),
    attention: run.attention !== null,
    report: run.report?.state ?? null,
    runStatus: run.status,
    queued:
      waitingLaunch !== undefined ||
      (delivery !== undefined &&
        (delivery.state === "queued" || delivery.state === "delivering")),
    nodeIdle: status?.state === "idle",
    unread: Number(unread.total) > 0,
  };
}

/** 一行此刻的阶段；缓存列不一致时顺手更新。 */
export function stageOf(
  database: DatabaseSync,
  run: TaskRun,
  nowSeconds: number,
): WorkItemStage {
  const stage = itemStage(itemFacts(database, run, nowSeconds));
  if (run.stage !== stage) {
    database
      .prepare("UPDATE workflow_task_runs SET stage = ? WHERE task_id = ?")
      .run(stage, run.taskId);
  }
  return stage;
}

/* --------------------------------- 报告 --------------------------------- */

export interface ReportWrite {
  readonly state: WorkItemReportState;
  readonly summary: string;
  /**
   * 待决问题的单槽：给出就替换，`undefined` 保持，`null` 清除。
   */
  readonly attention: string | null | undefined;
  readonly nowMs: number;
}

/** 写一次报告：最近一次、历史（有上限）与单槽。 */
export function recordReport(
  database: DatabaseSync,
  taskId: string,
  write: ReportWrite,
): TaskRun {
  const run = taskRun(database, taskId) as TaskRun;
  const at = new Date(write.nowMs).toISOString();
  const report: WorkItemReport = {
    state: write.state,
    summary: write.summary,
    at,
  };
  const history = [...run.reports, report].slice(-MAX_REPORT_HISTORY);
  let attention: WorkItemAttention | null = run.attention;
  if (write.attention === null) attention = null;
  else if (write.attention !== undefined) {
    attention = { question: write.attention, raisedAt: at };
  }
  database
    .prepare(
      "UPDATE workflow_task_runs SET report_json = ?, reports_json = ?, attention_json = ? WHERE task_id = ?",
    )
    .run(
      JSON.stringify(report),
      JSON.stringify(history),
      attention === null ? null : JSON.stringify(attention),
      taskId,
    );
  return taskRun(database, taskId) as TaskRun;
}

/** 交回协调者。每条只能一次：已经交回过就不动，答 `false`。 */
export function recordHandback(
  database: DatabaseSync,
  taskId: string,
  reason: string,
  nowMs: number,
): boolean {
  const changes = database
    .prepare(
      "UPDATE workflow_task_runs SET handback_json = ? WHERE task_id = ? AND handback_json IS NULL",
    )
    .run(JSON.stringify({ reason, at: new Date(nowMs).toISOString() }), taskId);
  return Number(changes.changes) > 0;
}

/** 一个节点名下的工作项，新的在前。 */
export function itemsOfNode(database: DatabaseSync, nodeId: string): TaskRun[] {
  const rows = database
    .prepare(
      "SELECT task_id FROM workflow_task_runs WHERE node_id = ? ORDER BY started_at DESC, rowid DESC",
    )
    .all(nodeId) as { task_id: string }[];
  return rows.map((row) => taskRun(database, row.task_id) as TaskRun);
}
