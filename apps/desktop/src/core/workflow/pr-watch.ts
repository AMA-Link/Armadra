import type { DatabaseSync } from "node:sqlite";
import { forgeRepo, validOwner } from "../forge/service";
import type { ForgeService } from "../forge/service";
import type { Forge, ForgeRepo } from "../forge/types";
import { ForgeError } from "../forge/types";
import { loadNode } from "../collab/nodes";
import { finishTask, taskRun, type TaskRun, type Thread } from "./task-runs";
import {
  MAX_BOT_ROUNDS,
  type PullBatch,
  botRounds,
  eventPrefix,
  pollableItems,
  recordThreadEvent,
  threadCursor,
  threadKey,
  threadOutcome,
} from "./threads";

/**
 * 绑定 PR 的拉取式轮询（契约 §103.2，#705）。
 *
 * 只看工作项自己绑定的 PR：评审与评论、head 提交上检查的结论、合并或关闭。读到
 * 的每个事件先过账表（`thread_events`，id 确定），已经记过的不再算；新的才交给
 * 投递（`deliver`），所以重放同一段响应、游标回退、重启之后从头再读都不会出第二
 * 条。凭据只在 forge 域里（`forgeFor` 每次现取），这里和下游都碰不到它。
 *
 *   * 间隔：每个线程至少 60 秒轮一次；服务端给了 `x-poll-interval` 就取更大的
 *     那个。读失败（限流、不可用、没配凭据）按 1、2、4 … 倍退避，封顶 10 分钟。
 *     退避状态在内存里，重启后从头来。
 *   * 游标：评论与评审读到过的最晚的远端时刻，往回退 {@link REWIND_MS}（防止漏读），
 *     起点是绑定的时刻——绑定之前的讨论不算新事件。
 *   * 机器人（登录名以 `[bot]` 结尾）的评论照样投，但每个 PR、每个机器人最多
 *     {@link MAX_BOT_ROUNDS} 轮，之后只记账。
 *   * 范围：活着的工作项，或结束不到 14 天的；一个线程出现终态（已合并 / 已关闭）
 *     后不再轮询。
 *   * 收尾：工作项自己开的（`own`）PR 全部合并或关闭，这一项结束（`done`），结果
 *     `merged`（有一个合并了）或 `closed`（全部是关闭）。
 *   * issue 线程（主动接单绑上的，#830）：读 issue 的评论与关闭，事件 id 前缀
 *     `issue-`；不读检查，也不参与收尾（issue 没有 `own`）。
 */

/** 每个线程最短轮询间隔（毫秒）。 */
export const MIN_POLL_MS = 60_000;
/** 退避封顶（毫秒）。 */
export const MAX_BACKOFF_MS = 600_000;
/** 游标往回退多少（毫秒）。 */
export const REWIND_MS = 5_000;
/** 一次 `tick` 最多轮询几个线程，剩下的留给下一次。 */
const MAX_POLLS_PER_TICK = 20;

export type PullResult = "merged" | "closed";

export interface PrWatchOptions {
  readonly database: DatabaseSync;
  readonly forge: () => ForgeService | undefined;
  /** 毫秒。 */
  readonly clock?: () => number;
  readonly minIntervalMs?: number;
  /** 新读到的东西：投给成员、写协调者的 `external` 事件。 */
  readonly deliver: (run: TaskRun, thread: Thread, batch: PullBatch) => void;
  /** 工作项因为自己开的 PR 都合并 / 关闭而结束了。 */
  readonly onSettled: (run: TaskRun, result: PullResult) => void;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

interface Schedule {
  nextAt: number;
  failures: number;
}

/** `<主机>/<owner>/<名字>` → 仓库引用；坏的答 `undefined`。 */
export function parseRepo(repo: string): ForgeRepo | undefined {
  const parts = repo.split("/");
  if (parts.length < 3) return undefined;
  const host = parts[0] as string;
  const name = parts[parts.length - 1] as string;
  const owner = parts.slice(1, -1).join("/");
  if (!validOwner(owner)) return undefined;
  try {
    return forgeRepo(host, owner, name);
  } catch {
    return undefined;
  }
}

function isBot(author: string | null): author is string {
  return author !== null && author.endsWith("[bot]");
}

export class PrWatch {
  private readonly schedule = new Map<string, Schedule>();
  private running = false;

  constructor(private readonly options: PrWatchOptions) {}

  private get now(): number {
    return (this.options.clock ?? Date.now)();
  }

  private get minInterval(): number {
    return this.options.minIntervalMs ?? MIN_POLL_MS;
  }

  /** 此刻在退避里（上次读失败）的线程数（用例用）。 */
  failing(): number {
    return [...this.schedule.values()].filter((entry) => entry.failures > 0)
      .length;
  }

  /**
   * 轮询一遍到点的线程。上一遍还没完就什么也不做。答这一遍投出去了几批。
   * 单个线程出错只退避它自己，不影响别的。
   */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const forge = this.options.forge();
      if (forge === undefined) return 0;
      const database = this.options.database;
      const start = this.now;
      const live = new Set<string>();
      let delivered = 0;
      let polled = 0;
      for (const listed of pollableItems(database, start)) {
        for (const thread of listed.threads) {
          const key = `${listed.taskId}|${threadKey(thread)}`;
          live.add(key);
          if (threadOutcome(database, listed.taskId, thread) !== null) continue;
          const due = this.schedule.get(key);
          if (due !== undefined && due.nextAt > this.now) continue;
          if (polled >= MAX_POLLS_PER_TICK) continue;
          polled += 1;
          try {
            const result = await this.poll(forge, listed.taskId, thread);
            delivered += result.delivered ? 1 : 0;
            this.schedule.set(key, {
              nextAt: this.now + result.intervalMs,
              failures: 0,
            });
          } catch (error) {
            const failures = (due?.failures ?? 0) + 1;
            this.schedule.set(key, {
              nextAt:
                this.now +
                Math.min(
                  MAX_BACKOFF_MS,
                  this.minInterval * 2 ** Math.min(failures - 1, 10),
                ),
              failures,
            });
            // 只记固定的种类，不记远端原话，更不会有凭据。
            this.options.log?.("PR 轮询失败", {
              taskId: listed.taskId,
              pull: threadKey(thread),
              kind: error instanceof ForgeError ? error.kind : "unknown",
              reason: error instanceof ForgeError ? error.reason : "",
            });
          }
        }
        this.settle(listed.taskId);
      }
      for (const key of this.schedule.keys()) {
        if (!live.has(key)) this.schedule.delete(key);
      }
      return delivered;
    } finally {
      this.running = false;
    }
  }

  /** 读一个线程。读失败（不是「没新东西」）抛出，由调用方退避。 */
  private async poll(
    forge: ForgeService,
    taskId: string,
    thread: Thread,
  ): Promise<{ delivered: boolean; intervalMs: number }> {
    const database = this.options.database;
    const run = taskRun(database, taskId);
    const repo = parseRepo(thread.repo);
    if (run === undefined || repo === undefined) {
      return { delivered: false, intervalMs: this.minInterval };
    }
    const workspaceId =
      loadNode(database, run.nodeId)?.workspaceId ??
      loadNode(database, run.coordinatorNodeId)?.workspaceId;
    if (workspaceId === undefined) {
      return { delivered: false, intervalMs: this.minInterval };
    }
    const remote: Forge = forge.forgeFor(repo, workspaceId);
    const key = threadKey(thread);
    const nowMs = this.now;
    const eventIds: string[] = [];
    const errors: unknown[] = [];
    let intervalMs = this.minInterval;

    const prefix = eventPrefix(thread.kind);
    const issue = thread.kind === "issue";
    // 合并 / 关闭：读不到 PR（issue）本身就整个线程算失败。
    const current: {
      readonly state: "open" | "merged" | "closed";
      readonly atMs: number;
    } = issue
      ? await remote.getIssue(repo, thread.number).then((value) => ({
          state: value.state,
          atMs: value.closedAtMs ?? value.updatedAtMs,
        }))
      : await remote.getPull(repo, thread.number).then((value) => ({
          state: value.state,
          atMs: value.mergedAtMs ?? value.updatedAtMs,
        }));

    // 评论与评审。
    const items = [];
    try {
      const conversation = await remote.conversation(
        repo,
        thread.number,
        thread.kind,
      );
      if (conversation.pollIntervalMs !== null) {
        intervalMs = Math.max(intervalMs, conversation.pollIntervalMs);
      }
      const cursor = threadCursor(database, taskId, thread) - REWIND_MS;
      for (const item of conversation.items) {
        if (item.createdAtMs < cursor) continue;
        const review = item.kind === "review";
        const eventId = `${prefix}-${review ? "review" : "comment"}:${key}:${item.id}`;
        const bot = isBot(item.author);
        const deliver =
          !bot ||
          botRounds(database, taskId, thread, item.author as string) <
            MAX_BOT_ROUNDS;
        const fresh = recordThreadEvent(
          database,
          {
            itemId: taskId,
            eventId,
            thread,
            kind: review ? "review" : "comment",
            actor: bot ? item.author : null,
            delivered: deliver,
            sourceAt: item.createdAtMs,
          },
          nowMs,
        );
        if (fresh && deliver) {
          items.push(item);
          eventIds.push(eventId);
        }
      }
    } catch (error) {
      errors.push(error);
    }

    // head 提交上检查的结论：只在 head 或结论变了时算一次，进行中不算。
    let checks: PullBatch["checks"] = null;
    if (!issue && current.state === "open") {
      try {
        const summary = await remote.checks(repo, thread.number);
        if (
          (summary.rollup === "success" || summary.rollup === "failure") &&
          summary.headSha !== ""
        ) {
          const eventId = `pr-checks:${key}:${summary.headSha}:${summary.rollup}`;
          const fresh = recordThreadEvent(
            database,
            {
              itemId: taskId,
              eventId,
              thread,
              kind: "checks",
              delivered: true,
              sourceAt: nowMs,
            },
            nowMs,
          );
          if (fresh) {
            checks = {
              rollup: summary.rollup,
              sha: summary.headSha,
              failing: summary.checks
                .filter((check) => check.state === "failure")
                .map((check) => check.name)
                .slice(0, 3),
            };
            eventIds.push(eventId);
          }
        }
      } catch (error) {
        errors.push(error);
      }
    }

    // 合并 / 关闭。
    let state: PullBatch["state"] = null;
    if (current.state === "merged" || current.state === "closed") {
      const eventId = `${prefix}-state:${key}:${current.state}`;
      const fresh = recordThreadEvent(
        database,
        {
          itemId: taskId,
          eventId,
          thread,
          kind: "state",
          delivered: true,
          sourceAt: current.atMs,
        },
        nowMs,
      );
      if (fresh) {
        state = current.state;
        eventIds.push(eventId);
      }
    }

    const delivered = eventIds.length > 0;
    if (delivered) {
      this.options.deliver(run, thread, { items, checks, state, eventIds });
    }
    // 评论 / 检查读失败：已经读到的照常投了，这个线程仍按失败退避，下次重读。
    if (errors.length > 0) throw errors[0];
    return { delivered, intervalMs };
  }

  /** 自己开的 PR 都有了终态：这一项结束。 */
  private settle(taskId: string): void {
    const database = this.options.database;
    const run = taskRun(database, taskId);
    if (run === undefined || run.status !== "running") return;
    const own = run.threads.filter((thread) => thread.own);
    if (own.length === 0) return;
    const outcomes = own.map((thread) =>
      threadOutcome(database, taskId, thread),
    );
    if (outcomes.some((outcome) => outcome === null)) return;
    const result: PullResult = outcomes.includes("merged")
      ? "merged"
      : "closed";
    const finished = finishTask(
      database,
      taskId,
      "done",
      { result, pulls: own.map(threadKey) },
      this.now,
    );
    if (!finished) return;
    this.options.onSettled(taskRun(database, taskId) as TaskRun, result);
  }
}
