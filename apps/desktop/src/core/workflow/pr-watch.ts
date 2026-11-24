import type { DatabaseSync } from "node:sqlite";
import { forgeRepo, validOwner } from "../forge/service";
import type { ForgeService } from "../forge/service";
import type { Forge, ForgePullSnapshot, ForgeRepo } from "../forge/types";
import { ForgeError } from "../forge/types";
import type { PullSnapshot } from "@armadra/shared";
import { snapshotOf } from "../forge/snapshot";
import {
  loadSnapshots,
  markSnapshotFailed,
  saveSnapshot,
  snapshotFetchedAt,
} from "./pull-snapshots";
import { loadNode } from "../collab/nodes";
import { finishTask, taskRun, type TaskRun, type Thread } from "./task-runs";
import {
  MAX_BOT_ROUNDS,
  type PullBatch,
  botRounds,
  eventPrefix,
  lastChecks,
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

/** 只刷快照的 PR 最短刷新间隔（毫秒）。 */
export const SNAPSHOT_ONLY_MIN_MS = 120_000;

export type PullResult = "merged" | "closed";

/** 只刷快照、不读讨论、不记账、不投递的 PR（节点关联，#988 P2）。 */
export interface SnapshotTarget {
  readonly repo: string;
  readonly number: number;
  readonly workspaceId: string;
}

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
  /** 只刷快照、不读讨论、不记账、不投递的 PR（P2 的节点关联）。 */
  readonly snapshotTargets?: (nowMs: number) => readonly SnapshotTarget[];
  /** 快照指纹变化（含首次）。 */
  readonly onSnapshot?: (
    repo: string,
    number: number,
    snapshot: PullSnapshot,
  ) => void;
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
  /** 这一遍已经刷新过快照的 PR（`<仓库>#<编号>`）。 */
  private readonly refreshed = new Set<string>();

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
      this.refreshed.clear();
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
            // 本轮快照已经读成功、只是后面读评论失败时，刚刷新的快照不算过期。
            if (
              thread.kind === "pull" &&
              !this.refreshed.has(`${thread.repo}#${thread.number}`)
            ) {
              markSnapshotFailed(
                database,
                thread.repo,
                thread.number,
                this.now,
              );
            }
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
      polled = await this.refreshTargets(forge, live, polled);
      for (const key of this.schedule.keys()) {
        if (!live.has(key)) this.schedule.delete(key);
      }
      return delivered;
    } finally {
      this.running = false;
    }
  }

  /**
   * 只刷快照的 PR：不读讨论、不记账、不投递，结构上没有投递的入口。已经被工作项
   * 线程刷新过，或离上次成功还没到间隔的跳过；与线程共用每遍的上限与退避。
   */
  private async refreshTargets(
    forge: ForgeService,
    live: Set<string>,
    polledSoFar: number,
  ): Promise<number> {
    const targets = this.options.snapshotTargets;
    if (targets === undefined) return polledSoFar;
    const database = this.options.database;
    let polled = polledSoFar;
    const seen = new Set<string>();
    for (const target of targets(this.now)) {
      const id = `${target.repo}#${target.number}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const key = `snap|${id}`;
      live.add(key);
      if (this.refreshed.has(id)) continue;
      const due = this.schedule.get(key);
      if (due !== undefined && due.nextAt > this.now) continue;
      const last = snapshotFetchedAt(database, target.repo, target.number);
      if (last !== undefined && this.now - last < SNAPSHOT_ONLY_MIN_MS) {
        continue;
      }
      if (polled >= MAX_POLLS_PER_TICK) continue;
      polled += 1;
      try {
        const repo = parseRepo(target.repo);
        if (repo === undefined) continue;
        const remote = await forge.forgeForReady(repo, target.workspaceId);
        await this.refreshSnapshot(remote, repo, target.repo, target.number);
        this.schedule.set(key, {
          nextAt: this.now + SNAPSHOT_ONLY_MIN_MS,
          failures: 0,
        });
      } catch (error) {
        markSnapshotFailed(database, target.repo, target.number, this.now);
        const failures = (due?.failures ?? 0) + 1;
        this.schedule.set(key, {
          nextAt:
            this.now +
            Math.min(
              MAX_BACKOFF_MS,
              SNAPSHOT_ONLY_MIN_MS * 2 ** Math.min(failures - 1, 10),
            ),
          failures,
        });
        this.options.log?.("PR 快照刷新失败", {
          pull: id,
          kind: error instanceof ForgeError ? error.kind : "unknown",
          reason: error instanceof ForgeError ? error.reason : "",
        });
      }
    }
    return polled;
  }

  /** 读、存一份快照；指纹变了（含首次）就告诉 `onSnapshot`。 */
  private async refreshSnapshot(
    remote: Forge,
    repo: ForgeRepo,
    repoKey: string,
    number: number,
  ): Promise<ForgePullSnapshot> {
    const snapshot = await snapshotOf(remote, repo, number);
    this.refreshed.add(`${repoKey}#${number}`);
    const database = this.options.database;
    const nowMs = this.now;
    if (saveSnapshot(database, repoKey, snapshot, nowMs)) {
      const stored = loadSnapshots(
        database,
        [{ repo: repoKey, number }],
        nowMs,
      )[0];
      if (stored !== undefined) {
        try {
          this.options.onSnapshot?.(repoKey, number, stored);
        } catch {
          // 订阅方出错不影响轮询。
        }
      }
    }
    return snapshot;
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
    // 先预热：只靠本机登录（gh 等）的仓库，缓存过期后同步的 forgeFor 会报未配置。
    const remote: Forge = await forge.forgeForReady(repo, workspaceId);
    const key = threadKey(thread);
    const nowMs = this.now;
    const eventIds: string[] = [];
    const errors: unknown[] = [];
    let intervalMs = this.minInterval;

    const prefix = eventPrefix(thread.kind);
    const issue = thread.kind === "issue";
    // 合并 / 关闭：读不到 PR（issue）本身就整个线程算失败。
    let snapshot: ForgePullSnapshot | undefined;
    const current: {
      readonly state: "open" | "merged" | "closed";
      readonly atMs: number;
    } = issue
      ? await remote.getIssue(repo, thread.number).then((value) => ({
          state: value.state,
          atMs: value.closedAtMs ?? value.updatedAtMs,
        }))
      : await this.refreshSnapshot(
          remote,
          repo,
          thread.repo,
          thread.number,
        ).then((value) => {
          snapshot = value;
          return { state: value.state, atMs: nowMs };
        });

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

    // head 提交上检查的结论（契约 §115）：事件 id 带序号，同一个提交上结论变了
    // 就是新事件，所以「失败 → 重跑 → 失败」也会再投一次。进行中只记账不投，用来
    // 隔开前后两次相同的结论；没读到、中性与「没有检查」不记。
    let checks: PullBatch["checks"] = null;
    const read = snapshot?.checks;
    if (
      !issue &&
      current.state === "open" &&
      read !== undefined &&
      read.read &&
      read.headSha !== "" &&
      (read.rollup === "pending" ||
        read.rollup === "success" ||
        read.rollup === "failure")
    ) {
      const last = lastChecks(database, taskId, key, read.headSha);
      if (last.rollup !== read.rollup) {
        const eventId = `pr-checks:${key}:${read.headSha}:${last.count}:${read.rollup}`;
        const notify = read.rollup !== "pending";
        const fresh = recordThreadEvent(
          database,
          {
            itemId: taskId,
            eventId,
            thread,
            kind: "checks",
            delivered: notify,
            sourceAt: nowMs,
          },
          nowMs,
        );
        if (fresh && notify) {
          checks = {
            rollup: read.rollup as "success" | "failure",
            sha: read.headSha,
            failing: read.failing.slice(0, 3),
          };
          eventIds.push(eventId);
        }
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
