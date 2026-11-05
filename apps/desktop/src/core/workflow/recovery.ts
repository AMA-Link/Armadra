import type { DatabaseSync } from "node:sqlite";
import { stageOf } from "./work-items";
import { type TaskRun, runningTaskRuns, taskRun } from "./task-runs";

/**
 * 重启恢复（契约 §101.5，#704）。
 *
 * core 起来之后，也每 60 秒顺带（搭任务行兜底扫描的便车）扫一遍：进行中
 * （`status = running`）、阶段是 `working`、成员没有活着的终端会话（休眠的不算
 * 没有）的工作项，写一条 `interrupted` 事件（§93 的新种类）并把
 * `recovery_pending` 置 1。**不自动重跑任何东西**：重跑可能把做过的外部动作（推
 * 分支、开 PR、发评论）再做一遍，也违反「不替人做决定」。
 *
 * 成员续接回来、下一次报告空闲且有活着的会话时，投一条固定的恢复提示并清掉
 * `recovery_pending`，所以每次中断只投一次。
 *
 * 阶段 `working/queued`（还没起、在排队，含等依赖启动）不算中断：它还没开始。
 * 启动后先留一段宽限（终端域在重启后要花一点时间接回还活着的会话）。
 */

/** 启动之后多久才开始扫，与一个会话结束多久之后才算中断（毫秒）。 */
export const RECOVERY_GRACE_MS = 20_000;

export interface RecoveryOptions {
  readonly database: DatabaseSync;
  /** 毫秒。 */
  readonly clock?: () => number;
  readonly graceMs?: number;
  /** 成员此刻有活着（或休眠着、等着接回）的会话。 */
  readonly alive: (nodeId: string) => boolean;
  /** 写 `interrupted` 事件；答是不是新写进去的。 */
  readonly record: (run: TaskRun, atMs: number) => boolean;
  /** 投恢复提示；答有没有（或早已）排进队列。 */
  readonly deliver: (run: TaskRun) => boolean;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export class RecoveryScan {
  private readonly startedAt: number;

  constructor(private readonly options: RecoveryOptions) {
    this.startedAt = (options.clock ?? Date.now)();
  }

  private get now(): number {
    return (this.options.clock ?? Date.now)();
  }

  private get grace(): number {
    return this.options.graceMs ?? RECOVERY_GRACE_MS;
  }

  /** 扫一遍；答这一遍新记了几条中断。 */
  scan(): number {
    const database = this.options.database;
    const now = this.now;
    if (now - this.startedAt < this.grace) return 0;
    let found = 0;
    for (const run of runningTaskRuns(database)) {
      if (this.options.alive(run.nodeId)) continue;
      if (stageOf(database, run, Math.floor(now / 1000)) !== "working")
        continue;
      const at = this.interruptedAt(run);
      if (now - at < this.grace) continue;
      if (!this.options.record(run, at)) continue;
      database
        .prepare(
          "UPDATE workflow_task_runs SET recovery_pending = 1 WHERE task_id = ?",
        )
        .run(run.taskId);
      this.options.log?.("工作项中断", { taskId: run.taskId });
      found += 1;
    }
    return found;
  }

  /**
   * 成员 `nodeId` 报告了状态 `state`。空闲且有活着的会话时，把它名下等着恢复
   * 的项各投一次提示。答投了几条。
   */
  onStatus(nodeId: string, state: string | undefined): number {
    if (state !== "idle") return 0;
    const database = this.options.database;
    const pending = database
      .prepare(
        "SELECT task_id FROM workflow_task_runs WHERE node_id = ? AND recovery_pending = 1",
      )
      .all(nodeId) as { task_id: string }[];
    if (pending.length === 0 || !this.options.alive(nodeId)) return 0;
    let delivered = 0;
    for (const row of pending) {
      const run = taskRun(database, row.task_id);
      // 先清再投：投递失败也不重复，每次中断最多提示一次。
      database
        .prepare(
          "UPDATE workflow_task_runs SET recovery_pending = 0 WHERE task_id = ?",
        )
        .run(row.task_id);
      if (run === undefined || run.status !== "running") continue;
      if (this.options.deliver(run)) delivered += 1;
    }
    return delivered;
  }

  /** 这次中断的时刻：成员最近一个会话的结束时刻；没有会话过就是工作项开始的时刻。 */
  private interruptedAt(run: TaskRun): number {
    const row = this.options.database
      .prepare(
        "SELECT COALESCE(ended_at, created_at) AS at FROM terminal_sessions " +
          "WHERE owner_node_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(run.nodeId) as { at?: unknown } | undefined;
    const parsed = typeof row?.at === "string" ? Date.parse(row.at) : NaN;
    if (!Number.isNaN(parsed)) return parsed;
    return run.startedAt;
  }
}
