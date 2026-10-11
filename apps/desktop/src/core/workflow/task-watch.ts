import type { DatabaseSync } from "node:sqlite";
import type { EventBus, WorkspaceEvent } from "../bus";
import {
  type WaitCursor,
  type WaitTrackers,
  observe,
  parseCursor,
  settle,
  waitedOn,
} from "../collab/control/wait";
import { publishTask, runningTaskRuns } from "./task-runs";

/**
 * core 自己盯着还在 `running` 的任务行（契约 §15.7，G5-09）。
 *
 * 任务行原本只在协调者调 `wait` 时落结束。分派抽屉点「重试」之后，协调者的
 * runner 已经拿到过 `failed`、不会再等，这一行就一直是「运行中」。这里用与
 * `wait` 同一份判定（`observe`）在没人等的时候也把它落掉：
 *
 *   * `agent.status` / `agent.delivery` / `terminal.exit` 到达时看一遍（合并成一
 *     次），另外每 {@link TASK_WATCH_MS} 毫秒扫一遍补漏；
 *   * 结束时只写 `workflow_task_runs` 并推 `workflow.task`，**不**把成员的结果
 *     `post` 标成已收——没人替协调者取走它，收件箱唤醒照旧会提示协调者；
 *   * 有人在 `wait`（或 `WAIT_GRACE_MS` 之内等过）的任务只看不落，结束留给
 *     `wait`；基准也是这里自己的一份，不改 `wait` 的判定。`wait` 读到这里落过
 *     的行就照库里的答。
 *
 * 游标（成员的 `post` 读到哪）只在进程里：重启之后从头读，最多多读几条。
 */

/** 补漏扫描的间隔。 */
export const TASK_WATCH_MS = 5_000;
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
      this.unsubscribe = bus.on("workspace.event", ({ event }) => {
        if (WATCHED_EVENTS.has(event.type)) this.soon();
      });
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
