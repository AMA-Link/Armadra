import type { DatabaseSync } from "node:sqlite";

import type { WorkspaceEvent } from "../bus";
import { getAgentStatus } from "../agent/status";
import {
  type StallKind,
  type StallSource,
  type StallSubject,
  stallBasis,
  withStalled,
} from "../agent/stalled";
import { runningTaskRuns, type TaskRun } from "./task-runs";
import { stageOf } from "./work-items";

/**
 * 进展看门狗（契约 §91，规则版，只提示不处置）。
 *
 * 协调者分派出去的成员卡住、空转、停在提示符上时没有任何东西能察觉：现有的
 * 看门狗只看中继进程活没活着。这里补上 Agent 层「进程还活着，但已经很久没有
 * 实质进展」的三种判定，数据全来自已有的表与内存里的观察，不开新的采集通道：
 *
 *   * `stalled`（停滞）：`agent_status.state` 是 `working`，最后一次 hook 上报与
 *     终端 / 会话最近一次输出都已超过 N 分钟（`watchdog.stalledMinutes`）；
 *   * `idleWaiting`（空等）：节点不在忙，它还有一个没结束的分派任务，投递已经
 *     完成，成员也没有 `post` 过这个任务的结论，且这样已超过 N 分钟；工作项
 *     已经在 `person/*`（等人验收、回答、处理）的不算空等；
 *   * `needsHuman`（等人太久）：`blocked` / `waiting` 超过 M 分钟
 *     （`watchdog.needsHumanMinutes`）。审批推送本来就有，这里只提醒还没处理的。
 *
 * 判定出来之后做三件事，**都不动节点本身**：
 *   1. 标记挂上 `agent.status` 帧（`stalled` 字段，分派抽屉与节点头读它）；
 *   2. 帧经推送规则变成一条 `stalled` 通知（只发给有 `canvas:read` 的人，
 *      正文不带终端原文，`push/triggers.ts`）；
 *   3. 节点是某个运行中任务的成员时，给协调者排一条短唤醒（走收件箱唤醒同一条
 *      队列与串行门，`collab/wake.ts::queueWatchWake`），由协调者决定重试、追问
 *      还是上报给人。
 * 不打断、不重启、不替人回答任何东西。
 *
 * 去重：同一个节点处在同一个判定（种类 + 状态指纹）时只提示一次；状态指纹是
 * 「状态 + 最后一次上报的时刻」，节点有了新上报，旧判定作废，之后再满足条件重新
 * 计时、重新提示。标记与「已提示」只在内存里：重启后最多对仍然卡着的节点再提示
 * 一次。
 *
 * 扫描由 `task-watch.ts` 的 60 秒兜底扫描带着跑（`TaskWatchOptions.onTick`），
 * 不另开定时器。
 */

/** 默认阈值（分钟）；设置 `watchdog.*` 可调，`0` 关闭对应判定。 */
export const DEFAULT_STALLED_MINUTES = 10;
export const DEFAULT_NEEDS_HUMAN_MINUTES = 15;

export interface WatchdogThresholds {
  /** 毫秒；`0` = 关。 */
  readonly stalledMs: number;
  readonly needsHumanMs: number;
}

export interface WatchdogWake {
  readonly coordinatorNodeId: string;
  readonly memberNodeId: string;
  readonly taskId: string;
  readonly reason: StallKind;
  readonly minutes: number;
  readonly basis: string;
}

export interface ProgressWatchdogOptions {
  readonly database: DatabaseSync;
  /** 推帧；协作域还没装好时缺席。 */
  readonly publish: () =>
    | ((workspaceId: string, event: WorkspaceEvent) => void)
    | undefined;
  /** 每次现读：设置改了下一轮扫描就生效。 */
  readonly thresholds: () => WatchdogThresholds;
  /** 节点最近一次输出的时刻（毫秒）：终端的 PTY 输出、ACP 会话的时间线写入。 */
  readonly lastOutputAt: (nodeId: string) => number | undefined;
  /** 这个节点此刻是不是有一个在跑的会话（没有会话的节点不判）。 */
  readonly running: (nodeId: string) => boolean;
  /** 给协调者排一条唤醒；没排进去也不重试。 */
  readonly wake: (wake: WatchdogWake) => void;
  /** 毫秒。 */
  readonly clock?: () => number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

interface Mark {
  readonly kind: StallKind;
  readonly basis: string;
  readonly workspaceId: string;
}

interface Verdict {
  readonly kind: StallKind;
  /** 已经多久（毫秒）。 */
  readonly quietMs: number;
}

interface CandidateRow {
  node_id: string;
}

const BUSY_STATES: ReadonlySet<string> = new Set(["blocked", "waiting"]);

export class ProgressWatchdog implements StallSource {
  private readonly marks = new Map<string, Mark>();

  constructor(private readonly options: ProgressWatchdogOptions) {}

  /** 这行状态上有没有标记；指纹对不上（节点有了新上报）就是没有。 */
  stalledOf(subject: StallSubject): StallKind | undefined {
    const mark = this.marks.get(subject.nodeId);
    if (mark === undefined || mark.basis !== stallBasis(subject)) {
      return undefined;
    }
    return mark.kind;
  }

  /** 当前挂着的标记数（用例与日志用）。 */
  size(): number {
    return this.marks.size;
  }

  /** 看一遍所有候选节点；答这一遍新挂上的标记数。 */
  scan(): number {
    const now = (this.options.clock ?? Date.now)();
    const limits = this.options.thresholds();
    const tasks = this.membersOfRunningTasks();
    const seen = new Set<string>();
    let raised = 0;
    for (const nodeId of this.candidates(tasks)) {
      seen.add(nodeId);
      try {
        if (this.review(nodeId, now, limits, tasks.get(nodeId) ?? [])) {
          raised += 1;
        }
      } catch (error) {
        this.options.log?.("进展看门狗扫描失败", {
          node: nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // 不再是候选的节点（恢复成 `done`、会话没了、节点删了）：摘掉标记。
    for (const nodeId of [...this.marks.keys()]) {
      if (!seen.has(nodeId)) this.clear(nodeId);
    }
    return raised;
  }

  /** 进程里的标记全丢（装配体停下时）。 */
  reset(): void {
    this.marks.clear();
  }

  /* --------------------------------- 判定 --------------------------------- */

  private review(
    nodeId: string,
    now: number,
    limits: WatchdogThresholds,
    tasks: readonly TaskRun[],
  ): boolean {
    const status = getAgentStatus(this.options.database, nodeId);
    const verdict =
      status === undefined || !this.options.running(nodeId)
        ? undefined
        : this.judge(status, now, limits, tasks);
    const previous = this.marks.get(nodeId);
    if (status === undefined || verdict === undefined) {
      if (previous !== undefined) this.clear(nodeId);
      return false;
    }
    const basis = stallBasis(status);
    if (previous?.kind === verdict.kind && previous.basis === basis) {
      return false;
    }
    this.marks.set(nodeId, {
      kind: verdict.kind,
      basis,
      workspaceId: status.workspaceId,
    });
    this.publishStatus(nodeId, status.workspaceId);
    const minutes = Math.floor(verdict.quietMs / 60_000);
    for (const task of tasks) {
      this.options.wake({
        coordinatorNodeId: task.coordinatorNodeId,
        memberNodeId: nodeId,
        taskId: task.taskId,
        reason: verdict.kind,
        minutes,
        basis,
      });
    }
    this.options.log?.("进展看门狗标记了一个节点", {
      node: nodeId,
      kind: verdict.kind,
      minutes,
    });
    return true;
  }

  private judge(
    status: NonNullable<ReturnType<typeof getAgentStatus>>,
    now: number,
    limits: WatchdogThresholds,
    tasks: readonly TaskRun[],
  ): Verdict | undefined {
    // CLI 已经说过自己退出了：不是卡住，是没了（终端退出自有一套收尾）。
    if (status.sessionPhase === "end") return undefined;
    const reported = Date.parse(status.lastEventAt ?? status.updatedAt);
    if (!Number.isFinite(reported)) return undefined;
    const state = status.state;

    if (state === "working") {
      if (limits.stalledMs <= 0) return undefined;
      const output = this.options.lastOutputAt(status.nodeId);
      const quietSince = Math.max(reported, output ?? 0);
      const quietMs = now - quietSince;
      return quietMs >= limits.stalledMs
        ? { kind: "stalled", quietMs }
        : undefined;
    }

    if (state !== undefined && BUSY_STATES.has(state)) {
      if (limits.needsHumanMs <= 0) return undefined;
      const quietMs = now - reported;
      return quietMs >= limits.needsHumanMs
        ? { kind: "needsHuman", quietMs }
        : undefined;
    }

    // 空等：不在忙，却还有一个没结束的任务、投递已经完成、没有结论。
    if (limits.stalledMs <= 0 || tasks.length === 0) return undefined;
    let quietMs = -1;
    for (const task of tasks) {
      if (this.deliveryPending(task) || this.concluded(task, reported)) {
        continue;
      }
      // 工作项已经交到人手里（`person/*`，契约 §90）：在等人，不是空等。
      if (
        stageOf(this.options.database, task, Math.floor(now / 1000)).startsWith(
          "person/",
        )
      ) {
        continue;
      }
      quietMs = Math.max(quietMs, now - Math.max(reported, task.startedAt));
    }
    return quietMs >= limits.stalledMs
      ? { kind: "idleWaiting", quietMs }
      : undefined;
  }

  /** 协调者投给成员的最近一条还没投完：这一轮还没开始，不算空等。 */
  private deliveryPending(task: TaskRun): boolean {
    const row = this.options.database
      .prepare(
        "SELECT state FROM agent_send_queue WHERE source_node_id = ? AND target_node_id = ? " +
          "ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(task.coordinatorNodeId, task.nodeId) as
      | { state?: string }
      | undefined;
    return row?.state === "queued" || row?.state === "delivering";
  }

  /** 成员在最近一次上报之后 `post` 过这个任务的东西（结论或进展）。 */
  private concluded(task: TaskRun, sinceMs: number): boolean {
    const prefix = `task:${task.taskId}`;
    const row = this.options.database
      .prepare(
        "SELECT 1 AS found FROM agent_mailbox WHERE source_node_id = ? AND created_at >= ? " +
          "AND (message_key = ? OR substr(message_key, 1, ?) = ?) LIMIT 1",
      )
      .get(
        task.nodeId,
        Math.floor(sinceMs / 1000),
        prefix,
        prefix.length + 1,
        `${prefix}:`,
      );
    return row !== undefined;
  }

  /* --------------------------------- 候选 --------------------------------- */

  /** 运行中的任务行按成员节点分组（同一节点可能有多行）。 */
  private membersOfRunningTasks(): Map<string, TaskRun[]> {
    const byNode = new Map<string, TaskRun[]>();
    for (const run of runningTaskRuns(this.options.database)) {
      const list = byNode.get(run.nodeId) ?? [];
      list.push(run);
      byNode.set(run.nodeId, list);
    }
    return byNode;
  }

  private candidates(tasks: ReadonlyMap<string, TaskRun[]>): Set<string> {
    const rows = this.options.database
      .prepare(
        "SELECT a.node_id AS node_id FROM agent_status a " +
          "WHERE a.state IN ('working','waiting','blocked') " +
          // 和 `hook/store.ts` 的清扫同一条理由：状态表不跟着节点删。
          "AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = a.node_id) LIMIT 500",
      )
      .all() as unknown as CandidateRow[];
    const nodes = new Set(rows.map((row) => row.node_id));
    for (const nodeId of tasks.keys()) nodes.add(nodeId);
    return nodes;
  }

  /* --------------------------------- 发帧 --------------------------------- */

  private clear(nodeId: string): void {
    const mark = this.marks.get(nodeId);
    if (mark === undefined) return;
    this.marks.delete(nodeId);
    this.publishStatus(nodeId, mark.workspaceId);
  }

  /** 把节点当前的状态行（带上或不带标记）推一帧；节点没了就不推。 */
  private publishStatus(nodeId: string, workspaceId: string): void {
    const publish = this.options.publish();
    if (publish === undefined) return;
    const status = getAgentStatus(this.options.database, nodeId);
    if (status === undefined) return;
    publish(workspaceId, {
      type: "agent.status",
      status: withStalled(status) as unknown as Record<string, unknown>,
    });
  }
}
