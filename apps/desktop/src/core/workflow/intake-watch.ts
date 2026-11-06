import type { DatabaseSync } from "node:sqlite";
import type { ForgeService } from "../forge/service";
import {
  ForgeError,
  type Forge,
  type ForgeIssue,
  type ForgePull,
  type ForgeRepo,
} from "../forge/types";
import {
  type IntakeCandidate,
  type IntakeSource,
  MAX_RAISES,
  advanceCursor,
  candidatesSince,
  claimedBy,
  commentVersion,
  enabledSources,
  getCandidate,
  getSource,
  insertCandidate,
  isAllowed,
  pruneCandidates,
  threadCandidates,
  threadVersion,
} from "./intake";
import { parseRepo, REWIND_MS } from "./pr-watch";
import { readRules } from "./rules";
import type { ThreadKind } from "./task-runs";

/**
 * 来源的拉取式轮询（契约 §104.2，#830）：找来源仓库里**没人认领**的线程，落成
 * 候选交给协调者判定。与 `pr-watch.ts` 同一种结构——`tick()`、内存退避、单个来源
 * 出错只退避它自己。
 *
 *   * 间隔：每个来源至少 {@link MIN_SOURCE_POLL_MS} 一次（这是「发现」不是「跟进」），
 *     列表响应给了更大的 `x-poll-interval` 就取它；
 *     读失败按 1、2、4 … 倍退避，封顶 10 分钟。每轮最多读 {@link MAX_SOURCES_PER_TICK}
 *     个来源。
 *   * 列表：`listIssues` / `listPulls` 按更新时间倒序，从第 1 页读起，遇到比游标
 *     （回退 5 秒）旧的行就停，最多 {@link MAX_PAGES} 页。窗口里的行全部处理完才把
 *     游标推到这一批最晚的 `updatedAtMs`；限流打断时不推，下一轮从同一处再来。
 *   * 新线程：来源建立之后创建、还没出过候选的线程（作者是机器人、PR 是草稿、
 *     已认领的不出）。草稿转正时 `updatedAtMs` 变了，它仍是「还没出过候选」的新
 *     线程，所以会在那时出候选。
 *   * 重新提起：出过候选、最近一条判定为 `skip` 或请求人不在允许名单且没接单的
 *     线程，判定（或读到）之后有允许名单里的人评论了，再出一条候选。一个线程最多
 *     {@link MAX_RAISES} 条。
 *   * 规则文件缺失（本机工作区）的来源跳过且不推游标。
 */

/** 每个来源最短轮询间隔（毫秒）。 */
export const MIN_SOURCE_POLL_MS = 120_000;
/** 退避封顶（毫秒）。 */
export const MAX_BACKOFF_MS = 600_000;
/** 每轮最多读几个来源。 */
export const MAX_SOURCES_PER_TICK = 10;
/** 列表每页条数与最多翻几页。 */
export const PAGE_SIZE = 50;
export const MAX_PAGES = 3;
/** 每个来源每小时最多出几条候选。 */
export const MAX_CANDIDATES_PER_HOUR = 20;
/** 每个来源每轮最多读几个线程的讨论（重新提起）。 */
export const MAX_CONVERSATIONS_PER_TICK = 10;
/** 清理候选的间隔（毫秒）。 */
const PRUNE_EVERY_MS = 3_600_000;

export interface IntakeWatchOptions {
  readonly database: DatabaseSync;
  readonly forge: () => ForgeService | undefined;
  /** 毫秒。 */
  readonly clock?: () => number;
  readonly minIntervalMs?: number;
  /** 新写的候选：写协调者的 `intake` 事件、推 `workflow.intake` 帧。 */
  readonly onCandidate: (
    candidate: IntakeCandidate,
    source: IntakeSource,
  ) => void;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

interface Schedule {
  nextAt: number;
  failures: number;
}

/** 列表里一行，issue 与 PR 统一成这个形状。 */
interface Listed {
  readonly kind: ThreadKind;
  readonly number: number;
  readonly title: string;
  readonly author: string | null;
  readonly url: string;
  readonly draft: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

function listedIssue(issue: ForgeIssue): Listed {
  return {
    kind: "issue",
    number: issue.number,
    title: issue.title,
    author: issue.author,
    url: issue.url,
    draft: false,
    createdAtMs: issue.createdAtMs,
    updatedAtMs: issue.updatedAtMs,
  };
}

function listedPull(pull: ForgePull): Listed {
  return {
    kind: "pull",
    number: pull.number,
    title: pull.title,
    author: pull.author,
    url: pull.url,
    draft: pull.draft,
    createdAtMs: pull.createdAtMs,
    updatedAtMs: pull.updatedAtMs,
  };
}

function isBot(author: string | null): boolean {
  return author !== null && author.endsWith("[bot]");
}

/** 这一轮被限流打断：游标不推。 */
class Interrupted extends Error {}

export class IntakeWatch {
  private readonly schedule = new Map<string, Schedule>();
  /** 重新提起已经读过讨论的线程：键 → 当时的 `updatedAtMs`。 */
  private readonly checked = new Map<string, number>();
  private running = false;
  private prunedAt = 0;

  constructor(private readonly options: IntakeWatchOptions) {}

  private get now(): number {
    return (this.options.clock ?? Date.now)();
  }

  private get minInterval(): number {
    return this.options.minIntervalMs ?? MIN_SOURCE_POLL_MS;
  }

  /** 此刻在退避里的来源数（用例用）。 */
  failing(): number {
    return [...this.schedule.values()].filter((entry) => entry.failures > 0)
      .length;
  }

  /** 轮询一遍到点的来源。答这一遍新写了几条候选。 */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const database = this.options.database;
      if (this.now - this.prunedAt >= PRUNE_EVERY_MS) {
        this.prunedAt = this.now;
        pruneCandidates(database, this.now);
      }
      const forge = this.options.forge();
      if (forge === undefined) return 0;
      const live = new Set<string>();
      let written = 0;
      let polled = 0;
      for (const source of enabledSources(database)) {
        live.add(source.id);
        const due = this.schedule.get(source.id);
        if (due !== undefined && due.nextAt > this.now) continue;
        if (polled >= MAX_SOURCES_PER_TICK) continue;
        polled += 1;
        try {
          const polled = await this.poll(forge, source);
          written += polled.written;
          // 服务端给了更大的 `x-poll-interval` 就听它的。
          this.schedule.set(source.id, {
            nextAt: this.now + Math.max(this.minInterval, polled.intervalMs),
            failures: 0,
          });
        } catch (error) {
          const failures = (due?.failures ?? 0) + 1;
          this.schedule.set(source.id, {
            nextAt:
              this.now +
              Math.min(
                MAX_BACKOFF_MS,
                this.minInterval * 2 ** Math.min(failures - 1, 10),
              ),
            failures,
          });
          // 只记固定的种类，不记远端原话。
          this.options.log?.("来源轮询失败", {
            sourceId: source.id,
            repo: source.repo,
            kind: error instanceof ForgeError ? error.kind : "unknown",
            reason: error instanceof ForgeError ? error.reason : "",
          });
        }
      }
      for (const key of this.schedule.keys()) {
        if (!live.has(key)) this.schedule.delete(key);
      }
      return written;
    } finally {
      this.running = false;
    }
  }

  /** 读一个来源。读失败抛出，由调用方退避。答新写了几条候选。 */
  private async poll(
    forge: ForgeService,
    source: IntakeSource,
  ): Promise<{ written: number; intervalMs: number }> {
    const database = this.options.database;
    const repo = parseRepo(source.repo);
    if (repo === undefined) return { written: 0, intervalMs: 0 };
    const rules = readRules(database, source.workspaceId);
    // 本机工作区没有规则文件：跳过且不推游标，补上文件之后不漏这段时间的线程。
    if (!rules.present && !rules.remote) return { written: 0, intervalMs: 0 };
    const remote = forge.forgeFor(repo, source.workspaceId);
    const floor = source.cursorAt - REWIND_MS;
    const window: Listed[] = [];
    const interval = { ms: 0 };
    for (const kind of source.kinds) {
      window.push(...(await this.list(remote, repo, kind, floor, interval)));
    }
    const state = { written: 0, conversations: 0 };
    try {
      // 早的先处理：限流打断时留下的是晚的，下一轮从同一处再来。
      for (const row of window.sort((a, b) => a.updatedAtMs - b.updatedAtMs)) {
        await this.consider(remote, repo, source, row, state);
      }
    } catch (error) {
      if (error instanceof Interrupted) {
        return { written: state.written, intervalMs: interval.ms };
      }
      throw error;
    }
    const latest = Math.max(0, ...window.map((row) => row.updatedAtMs));
    if (latest > 0) advanceCursor(database, source.id, latest);
    return { written: state.written, intervalMs: interval.ms };
  }

  /** 窗口里的行：更新时间不早于 `floor` 的，最多 {@link MAX_PAGES} 页。 */
  private async list(
    remote: Forge,
    repo: ForgeRepo,
    kind: ThreadKind,
    floor: number,
    interval: { ms: number },
  ): Promise<Listed[]> {
    const out: Listed[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const options = { state: "open" as const, page, limit: PAGE_SIZE };
      let listed: Listed[];
      if (kind === "issue") {
        const result = await remote.listIssues(repo, options);
        interval.ms = Math.max(interval.ms, result.pollIntervalMs ?? 0);
        listed = result.items.map(listedIssue);
      } else {
        const result = await remote.listPulls(repo, options);
        interval.ms = Math.max(interval.ms, result.pollIntervalMs ?? 0);
        listed = result.items.map(listedPull);
      }
      let older = false;
      for (const row of listed) {
        if (row.updatedAtMs < floor) {
          older = true;
          break;
        }
        out.push(row);
      }
      if (older || listed.length < PAGE_SIZE) break;
    }
    return out;
  }

  private async consider(
    remote: Forge,
    repo: ForgeRepo,
    source: IntakeSource,
    row: Listed,
    state: { written: number; conversations: number },
  ): Promise<void> {
    const database = this.options.database;
    const previous = threadCandidates(
      database,
      source.id,
      row.kind,
      row.number,
    );
    if (previous.length === 0) {
      // 来源建立之前的线程不回灌。
      if (row.createdAtMs < source.createdAt - REWIND_MS) return;
      if (isBot(row.author) || row.draft) return;
      if (claimedBy(database, row.kind, source.repo, row.number, this.now)) {
        return;
      }
      this.limit(source);
      if (
        this.write(source, row, {
          version: threadVersion(row.createdAtMs),
          request: { by: row.author ?? "", via: "thread", at: row.createdAtMs },
          sourceAt: row.createdAtMs,
        })
      ) {
        state.written += 1;
      }
      return;
    }
    // 重新提起：只看判定之后（没判定的不提起）。
    if (previous.length >= MAX_RAISES) return;
    const latest = previous[0] as IntakeCandidate;
    if (latest.verdict === null) return;
    const reopenable =
      latest.verdict === "skip" ||
      (!latest.authorized && latest.itemId === null);
    if (!reopenable) return;
    const since = latest.verdictAt ?? latest.seenAt;
    if (row.updatedAtMs <= since) return;
    const key = `${source.id}|${row.kind}|${row.number}`;
    if (this.checked.get(key) === row.updatedAtMs) return;
    if (state.conversations >= MAX_CONVERSATIONS_PER_TICK) {
      throw new Interrupted();
    }
    state.conversations += 1;
    const conversation = await remote.conversation(repo, row.number, row.kind);
    this.checked.set(key, row.updatedAtMs);
    const request = conversation.items.find(
      (item) =>
        item.createdAtMs > since &&
        !isBot(item.author) &&
        isAllowed(source, item.author),
    );
    if (request === undefined) return;
    if (claimedBy(database, row.kind, source.repo, row.number, this.now)) {
      return;
    }
    this.limit(source);
    if (
      this.write(source, row, {
        version: commentVersion(request.id),
        request: {
          by: request.author ?? "",
          via: "comment",
          commentId: request.id,
          at: request.createdAtMs,
        },
        sourceAt: request.createdAtMs,
      })
    ) {
      state.written += 1;
    }
  }

  /** 每来源每小时的候选上限：到了就打断这一轮，游标不推。 */
  private limit(source: IntakeSource): void {
    const count = candidatesSince(
      this.options.database,
      source.id,
      this.now - 3_600_000,
    );
    if (count >= MAX_CANDIDATES_PER_HOUR) throw new Interrupted();
  }

  private write(
    source: IntakeSource,
    row: Listed,
    entry: {
      readonly version: string;
      readonly request: IntakeCandidate["request"];
      readonly sourceAt: number;
    },
  ): boolean {
    const database = this.options.database;
    // 允许名单以此刻库里的为准（人可能刚改过）。
    const current = getSource(database, source.id) ?? source;
    const { inserted, id } = insertCandidate(
      database,
      {
        source: current,
        kind: row.kind,
        number: row.number,
        version: entry.version,
        title: row.title,
        author: row.author,
        url: row.url,
        request: entry.request,
        sourceAt: entry.sourceAt,
      },
      this.now,
    );
    if (!inserted) return false;
    const candidate = getCandidate(database, id);
    if (candidate !== undefined) this.options.onCandidate(candidate, current);
    return true;
  }
}
