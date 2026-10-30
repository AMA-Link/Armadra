import type { DatabaseSync } from "node:sqlite";
import type { EventBus, WorkspaceEvent } from "../bus";
import {
  type WaitCursor,
  type WaitTrackers,
  observe,
  parseCursor,
  releaseWait,
  settle,
  waitedOn,
} from "../collab/control/wait";
import { publishTask, runningTaskRuns, taskRun } from "./task-runs";

/**
 * core 自己盯着还在 `running` 的任务行（契约 §15.7，G5-09）。
 *
 * 任务行原本只在协调者调 `wait` 时落结束。分派抽屉点「重试」之后，协调者的
 * runner 已经拿到过 `failed`、不会再等，这一行就一直是「运行中」。这里用与
 * `wait` 同一份判定（`observe`）在没人等的时候也把它落掉：
 *
 *   * 协调者的 runner 报 `runner_done`（ama 的 host-api 1.1 `runners.onDone`，
 *     总线上的 `runner.done`）时，让这个任务「有人在等」的标记立即失效（还有
 *     `wait` 挂着时不动），马上看一遍——协调者中断 / 停止任务后不必再等
 *     `WAIT_GRACE_MS`；
 *   * `agent.status` / `agent.delivery` / `terminal.exit` 到达时看一遍（合并成一
 *     次），另外每 {@link TASK_WATCH_MS} 毫秒扫一遍兜底；
 *   * 结束时只写 `workflow_task_runs` 并推 `workflow.task`，**不**把成员的结果
 *     `post` 标成已收——没人替协调者取走它，收件箱唤醒照旧会提示协调者；
 *   * 有人在 `wait`（或 `WAIT_GRACE_MS` 之内等过）的任务只看不落，结束留给
 *     `wait`；基准也是这里自己的一份，不改 `wait` 的判定。`wait` 读到这里落过
 *     的行就照库里的答。
 *
 * 游标（成员的 `post` 读到哪）只在进程里：重启之后从头读，最多多读几条。
 */

/**
 * 兜底扫描的间隔。落行的主触发是上面那些事件；定时扫描只兜事件到不了的情况：
 * ama 崩溃或被杀（不发 `runner_done`）、core 重启后游标从头读、分派抽屉「重试」
 * 之类不经 ama runner 的行、旧版或远程主机上没有 `runners.onDone` 的 ama。
 * 这些都不在交互的关键路径上，60 秒足够。
 */
export const TASK_WATCH_MS = 60_000;
/** 事件到达后合并多久再看。 */
const COALESCE_MS = 250;

const WATCHED_EVENTS: ReadonlySet<WorkspaceEvent["type"]> = new Set([
  "agent.status",
  "agent.delivery",
  "terminal.exit",
]);

export interface TaskWatchOptions {
  readonly database: DatabaseSync;
  readonly bus?: EventBus | undefined;
  /** 推帧；协作域还没装好时缺席。 */
  readonly publish: () =>
    | ((workspaceId: string, event: WorkspaceEvent) => void)
    | undefined;
  /** 毫秒。 */
  readonly clock?: () => number;
  /** 为 `false` 时不武装定时扫描（用例手动调 {@link TaskWatch.sweep}）。 */
  readonly everyMs?: number | false;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export class TaskWatch {
  private readonly cursors = new Map<string, WaitCursor>();
  private readonly trackers: WaitTrackers = new Map();
  private timer: NodeJS.Timeout | undefined;
  private pending: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly options: TaskWatchOptions) {}

  start(): void {
    const bus = this.options.bus;
    if (bus !== undefined) {
      const offEvents = bus.on("workspace.event", ({ event }) => {
        if (WATCHED_EVENTS.has(event.type)) this.soon();
      });
      const offDone = bus.on("runner.done", ({ nodeId, taskId }) => {
        this.runnerDone(nodeId, taskId);
      });
      this.unsubscribe = () => {
        offEvents();
        offDone();
      };
    }
    const every = this.options.everyMs ?? TASK_WATCH_MS;
    if (every !== false) {
      this.timer = setInterval(() => this.safeSweep(), every);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.unsubscribe?.();
  }

  /**
   * 协调者 `nodeId` 的 runner 说任务 `taskId` 这一轮完了：只认起这个任务的那个
   * 协调者（任务 id 不是授权，同 `wait`），放掉等待标记，立即看一遍。答这次
   * 落了几行。
   */
  runnerDone(nodeId: string, taskId: string): number {
    if (this.stopped) return 0;
    try {
      const run = taskRun(this.options.database, taskId);
      if (run === undefined || run.coordinatorNodeId !== nodeId) return 0;
      if (run.status !== "running") return 0;
      releaseWait(taskId);
      return this.sweep();
    } catch (error) {
      this.options.log?.("任务行扫描失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private soon(): void {
    if (this.stopped || this.pending !== undefined) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.safeSweep();
    }, COALESCE_MS);
    this.pending.unref?.();
  }

  private safeSweep(): void {
    if (this.stopped) return;
    try {
      this.sweep();
    } catch (error) {
      this.options.log?.("任务行扫描失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 看一遍所有 `running` 的行；答这一遍落了几行。 */
  sweep(): number {
    const database = this.options.database;
    const now = (this.options.clock ?? Date.now)();
    const running = runningTaskRuns(database);
    const live = new Set(running.map((run) => run.taskId));
    for (const taskId of this.cursors.keys()) {
      if (!live.has(taskId)) this.cursors.delete(taskId);
    }
    for (const taskId of this.trackers.keys()) {
      if (!live.has(taskId)) this.trackers.delete(taskId);
    }
    let settled = 0;
    for (const run of running) {
      const cursor = this.cursors.get(run.taskId) ?? { post: 0, state: "" };
      const answer = observe(database, run, cursor, this.trackers);
      const final = answer.status === "done" || answer.status === "failed";
      // 有人在等：结束交给 `wait`（它还要把结果 post 标成已收）。游标不往前
      // 挪，等的人走了之后这里还能看到那条结果。
      if (final && waitedOn(run.taskId)) continue;
      const next = parseCursor(answer.since);
      if (next !== undefined) this.cursors.set(run.taskId, next);
      if (!final) continue;
      this.trackers.delete(run.taskId);
      if (settle(database, answer, now, { acknowledge: false })) {
        this.cursors.delete(run.taskId);
        publishTask(database, this.options.publish(), run.taskId);
        settled += 1;
      }
    }
    return settled;
  }
}
