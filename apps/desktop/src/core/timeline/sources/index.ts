/**
 * 终端驱动的 CLI → 时间线（设计 §5）：管理器。
 *
 * 每个活着的终端会话（一个节点的当前会话行）最多一个 {@link Source}：一个尾读器
 * （{@link TailRunner}）、一个写入出口（{@link TimelineSink}）和一个适配器。
 *
 *   * **hook 作门铃**：`ingest` 在算完四态之后调 {@link SourceManager.onHook}。它做两件事：
 *     把事件映射到 `activity.external`（提示中、运行：pnpm test、等审批…），并立刻让
 *     尾读器读一次转录；Stop 以后再收尾还没结束的回合。
 *   * **转录作内容**：尾读器读到的行交给适配器，适配器经 `sink` 写时间线；游标（路径、
 *     偏移、inode、指纹）存在时间线行的 `source_cursor`，core 重启后接着读。
 *   * 第一次接管只读转录尾部 2 MiB，这一段导入不推进活动层（回填）。
 *
 * 会话行不再是 `running`，或节点换了新会话，对应的 Source 在下一次巡检（60 s）或下一个
 * hook 时停掉。没有 hook 的 CLI（Antigravity / Grok / 自定义）没有适配器，什么也不做。
 */

import type { DatabaseSync } from "node:sqlite";

import { baseAgent } from "../../hook/capabilities";
import type { AgentEvent } from "../../hook/normalize";
import { getAgentStatus } from "../../hook/store";
import type { SessionHint } from "../../history/types";
import { outcomeOf } from "../activity";
import type { TimelineDomain } from "../index";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { copilotTranscript } from "./copilot";
import { internalReporter } from "../../hook/report";
import {
  OBSERVED,
  registerStateRefresher,
  stateSourceIsReported,
} from "../../agent/state-source";
import {
  type StateSlot,
  type StateSlotContext,
  type StateSlotProvider,
  stateSlotProviderFor,
} from "./state-slot";
import { mapHookActivity } from "./hook-activity";
import { opencodeTranscript } from "./opencode";
import { amaTranscript, ompTranscript, piTranscript } from "./pi";
import { TimelineSink } from "./sink";
import {
  type StatFn,
  type TailCursor,
  type TailTimers,
  type WatchFn,
  TailRunner,
  decodeCursor,
  encodeCursor,
  realTailTimers,
} from "./tailer";
import type { SourceRunner, TranscriptAdapter } from "./types";

export { TimelineSink } from "./sink";
export {
  TailRunner,
  readTranscript,
  encodeCursor,
  decodeCursor,
} from "./tailer";
export type { TailCursor } from "./tailer";
export type { TranscriptAdapter } from "./types";
export { mapHookActivity } from "./hook-activity";
export {
  registerStateSlot,
  stateSlotProviderFor,
  type StateSlot,
  type StateSlotContext,
  type StateSlotLevel,
  type StateSlotProvider,
} from "./state-slot";

/** 登记的适配器。键是 `baseAgent` 之后的代理 id。 */
export const ADAPTERS: Readonly<Record<string, TranscriptAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeTranscript,
  pi: piTranscript,
  omp: ompTranscript,
  ama: amaTranscript,
  copilot: copilotTranscript,
};

/** 这个代理有没有转录适配器（页面据此决定「会话 / 终端」切换是否可用）。 */
export function transcriptAdapterFor(
  agentId: string | undefined,
): TranscriptAdapter | undefined {
  if (agentId === undefined) return undefined;
  return ADAPTERS[baseAgent(agentId)];
}

const REAP_INTERVAL_MS = 60_000;

interface Source {
  readonly timelineId: string;
  readonly nodeId: string;
  readonly adapter: TranscriptAdapter;
  readonly runner: SourceRunner;
  readonly sink: TimelineSink;
  hint: SessionHint;
}

interface SessionRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly cwd: string;
  readonly createdAtMs: number;
  readonly generation?: number;
}

/** 一个终端会话上开着的状态读取槽（见 `state-slot.ts`）。 */
interface OpenSlot {
  readonly sessionId: string;
  readonly nodeId: string;
  readonly provider: StateSlotProvider;
  readonly slot: StateSlot;
  /** 开槽时会话的代次：同 id 不同代次（原地换代、休眠唤醒）要重开。 */
  readonly generation: number;
  /** 撤销「判 idle 之前同步读一次」的登记。 */
  unrefresh: () => void;
}

/** 终端域对会话的两个事实，槽拿去用；由 `terminal/install.ts` 装配。 */
export interface TerminalFacts {
  pid(sessionId: string): number | undefined;
  remote(sessionId: string): boolean;
  env?(sessionId: string, name: string): string | undefined;
  screen?(sessionId: string): Promise<string | undefined>;
}

export interface SourceManagerOptions {
  readonly database: DatabaseSync;
  readonly timers?: TailTimers;
  readonly watch?: WatchFn;
  readonly stat?: StatFn;
  readonly log?: {
    warn(message: string, fields?: Record<string, unknown>): void;
    debug?(message: string, fields?: Record<string, unknown>): void;
  };
}

export class SourceManager {
  private readonly sources = new Map<string, Source>();
  private readonly slots = new Map<string, OpenSlot>();
  /** 正在 `provider.open()` 里的会话：open 里同步上报会敲门铃叫回这里，不能重复开。 */
  private readonly opening = new Set<string>();
  /** 正在上报的槽：它自己的上报敲出来的门铃不再叫回它（避免同步重入）。 */
  private readonly reporting = new Set<string>();
  private facts: TerminalFacts | undefined;
  private readonly timers: TailTimers;
  private reaper: unknown;
  private closed = false;

  constructor(
    private readonly domain: TimelineDomain,
    private readonly options: SourceManagerOptions,
  ) {
    this.timers = options.timers ?? realTailTimers;
  }

  /** 终端域装配好之后给槽用的会话事实；没装配时 pid 读不到、远程按本机算。 */
  setTerminalFacts(facts: TerminalFacts | undefined): void {
    this.facts = facts;
  }

  /** 测试与诊断：这个会话上开着的状态读取槽。 */
  slotOf(sessionId: string): StateSlot | undefined {
    return this.slots.get(sessionId)?.slot;
  }

  /** 测试与诊断：这条时间线的尾读器。 */
  runnerOf(timelineId: string): TailRunner | undefined {
    const runner = this.sources.get(timelineId)?.runner;
    return runner instanceof TailRunner ? runner : undefined;
  }

  /* ------------------------------ hook 门铃 ------------------------------ */

  /**
   * `ingest` 算完四态之后调。只在这个节点有活着的终端会话、代理有适配器时才动；
   * 任何错误只记日志，不能影响 hook 的应答。
   */
  onHook(nodeId: string, event: AgentEvent): void {
    if (this.closed) return;
    // 槽与转录尾读各自一道 try：一边抛错不能连累另一边。
    try {
      this.pokeSlot(nodeId, event);
    } catch (error) {
      this.options.log?.warn("叫醒状态读取槽失败", {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const adapter = transcriptAdapterFor(event.agentId);
      if (adapter === undefined) return;
      const row = this.runningSession(nodeId);
      if (row === undefined) return;
      const source = this.sourceFor(row, nodeId, adapter, event);
      this.applyActivity(source, event);
      const mapped = mapHookActivity(event, adapter.toolKind);
      if (mapped?.kind === "end") {
        source.runner.poke(() => this.settle(source, event, mapped.outcome));
      } else {
        source.runner.poke();
      }
    } catch (error) {
      this.options.log?.warn("hook 触发转录读取失败", {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private applyActivity(source: Source, event: AgentEvent): void {
    const activity = this.domain.activity;
    const mapped = mapHookActivity(event, source.adapter.toolKind);
    if (mapped === undefined) return;
    const id = source.timelineId;
    if (mapped.kind === "signal") {
      activity.external(id, {
        phase: mapped.phase,
        ...(mapped.detail !== undefined ? { detail: mapped.detail } : {}),
      });
    } else if (mapped.kind === "clear") {
      activity.external(id, null);
    } else {
      activity.external(id, null);
      const current = activity.get(id);
      if (
        current?.turnStartedAt !== undefined ||
        current?.lastOutcome === undefined
      ) {
        activity.turnEnded(id, mapped.outcome);
      }
    }
  }

  /** Stop 之后：转录里没写收尾记录的回合，在这里合上。 */
  private settle(
    source: Source,
    event: AgentEvent,
    outcome: ReturnType<typeof outcomeOf>,
  ): void {
    if (this.sources.get(source.timelineId) !== source) return;
    const cancelled = outcome.kind === "cancelled";
    source.sink.endTurn(this.timers.now(), {
      stopReason: cancelled ? "cancelled" : "end_turn",
      ...(outcome.kind === "failed"
        ? {
            error: {
              code: "stop_failure",
              message: (outcome.error ?? event.lastMessage ?? "failed").slice(
                0,
                4_000,
              ),
            },
          }
        : {}),
    });
  }

  /* ----------------------------- 状态读取槽 ----------------------------- */

  /**
   * 终端会话起来了（`terminal/manager` 的 `onStart`）：这个节点的 CLI 若登记了状态
   * 读取槽，就在这里开——不等任何上报。任何错误只记日志，不影响终端的创建。
   */
  onSessionStart(nodeId: string, sessionId?: string): void {
    if (this.closed) return;
    try {
      const row = this.runningSession(nodeId, sessionId);
      if (row === undefined) return;
      this.openSlot(row, nodeId);
    } catch (error) {
      this.options.log?.warn("开状态读取槽失败", {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private pokeSlot(nodeId: string, event: AgentEvent): void {
    for (const open of [...this.slots.values()]) {
      if (open.nodeId !== nodeId || this.reporting.has(open.sessionId))
        continue;
      try {
        open.slot.poke?.();
      } catch (error) {
        this.options.log?.warn("状态读取槽 poke 失败", {
          sessionId: open.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // hook 先于 `onStart` 到（或 `onStart` 当时开不了）：补开一次。
    if (stateSlotProviderFor(baseAgent(event.agentId)) !== undefined) {
      const row = this.runningSession(nodeId);
      if (row !== undefined) this.openSlot(row, nodeId);
    }
  }

  private openSlot(row: SessionRow, nodeId: string): OpenSlot | undefined {
    const generation = row.generation ?? 0;
    const existing = this.slots.get(row.id);
    if (existing !== undefined) {
      if (existing.generation === generation) return existing;
      // 原地换代（`recycleSession`、休眠唤醒）：会话 id 不变、代次加一，旧槽读的是
      // 上一代的进程、带绑定的上报也会被当成过期丢掉，先停再重开。
      this.dropSlot(existing);
    }
    if (this.opening.has(row.id)) return undefined;
    const agentId = baseAgent(row.agentId);
    const provider = stateSlotProviderFor(agentId);
    if (provider === undefined) return undefined;
    // 同一节点上一个会话行的槽不再需要了。
    for (const old of [...this.slots.values()]) {
      if (old.nodeId === nodeId && old.sessionId !== row.id) this.dropSlot(old);
    }
    this.opening.add(row.id);
    let slot: StateSlot | undefined;
    try {
      slot = provider.open(this.slotContext(row, nodeId, agentId, provider));
    } finally {
      this.opening.delete(row.id);
    }
    if (slot === undefined) return undefined;
    const open: OpenSlot = {
      sessionId: row.id,
      nodeId,
      provider,
      slot,
      generation,
      unrefresh: () => undefined,
    };
    this.slots.set(row.id, open);
    this.armReaper();
    if (slot.readNow !== undefined) {
      const read = slot.readNow.bind(slot);
      open.unrefresh = registerStateRefresher(nodeId, read);
    }
    try {
      slot.start();
    } catch (error) {
      this.options.log?.warn("启动状态读取槽失败", {
        sessionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.dropSlot(open);
      return undefined;
    }
    return open;
  }

  private slotContext(
    row: SessionRow,
    nodeId: string,
    agentId: string,
    provider: StateSlotProvider,
  ): StateSlotContext {
    const log = this.options.log;
    return {
      nodeId,
      workspaceId: row.workspaceId,
      agentId,
      sessionId: row.id,
      generation: row.generation ?? 0,
      cwd: row.cwd,
      startedAtMs: row.createdAtMs,
      pid: () => this.facts?.pid(row.id),
      remote: () => this.facts?.remote(row.id) ?? false,
      env: (name) => this.facts?.env?.(row.id, name),
      screen: () => this.facts?.screen?.(row.id) ?? Promise.resolve(undefined),
      report: (event, options) => {
        const report = internalReporter();
        if (report === undefined) return false;
        // 级别由这里执行，不信槽自己：观察级的事件一律写成 `observed`；上报级的
        // 事件必须自带上报级来源，否则整条丢（槽写错了来源是槽的 bug，不是
        // 偷偷降级成观察的理由）。
        if (provider.level === "observed") {
          event.stateSource = OBSERVED;
        } else if (!stateSourceIsReported(event.stateSource)) {
          log?.warn("上报级的槽写了非上报级的来源，丢弃", {
            agentId,
            stateSource: event.stateSource,
          });
          return false;
        }
        this.reporting.add(row.id);
        try {
          return (
            report({
              nodeId,
              agentId,
              event,
              ...(options?.rawPayload === undefined
                ? {}
                : { rawPayload: options.rawPayload }),
              ...(options?.bind === true
                ? {
                    terminalSession: {
                      sessionId: row.id,
                      generation: row.generation ?? 0,
                    },
                  }
                : {}),
            }) !== undefined
          );
        } finally {
          this.reporting.delete(row.id);
        }
      },
      timers: this.timers,
      watch: this.options.watch,
      stat: this.options.stat,
      log: {
        warn: (message, fields) => log?.warn(message, fields),
        debug: (message, fields) => log?.debug?.(message, fields),
      },
    };
  }

  private dropSlot(open: OpenSlot): void {
    // 先出表再 `stop()`：stop 里同步上报会敲门铃叫回这里，槽还在表里就会再 stop
    // 一次，无限递归。
    if (this.slots.get(open.sessionId) === open) {
      this.slots.delete(open.sessionId);
    }
    open.unrefresh();
    try {
      open.slot.stop();
    } catch (error) {
      this.options.log?.warn("停状态读取槽失败", {
        sessionId: open.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /* ------------------------------ 会话与来源 ------------------------------ */

  private runningSession(
    nodeId: string,
    sessionId?: string,
  ): SessionRow | undefined {
    const row = this.options.database
      .prepare(
        "SELECT id, workspace_id, agent_id, cwd, created_at, generation FROM terminal_sessions " +
          "WHERE owner_node_id = ? AND status = 'running' AND backend_kind != 'acp' " +
          (sessionId === undefined ? "" : "AND id = ? ") +
          "ORDER BY created_at DESC, generation DESC LIMIT 1",
      )
      .get(...(sessionId === undefined ? [nodeId] : [nodeId, sessionId])) as
      | {
          id: string;
          workspace_id: string;
          agent_id: string | null;
          cwd: string;
          created_at: string;
          generation: number;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id ?? "",
      cwd: row.cwd,
      createdAtMs: Date.parse(row.created_at) || 0,
      generation: Number(row.generation) || 0,
    };
  }

  private sourceFor(
    row: SessionRow,
    nodeId: string,
    adapter: TranscriptAdapter,
    event: AgentEvent | undefined,
  ): Source {
    const status = getAgentStatus(this.options.database, nodeId);
    const reported =
      event?.transcriptPath ?? status?.transcriptPath ?? undefined;
    const sessionId = event?.sessionId ?? status?.sessionId ?? undefined;
    const existing = this.sources.get(row.id);
    if (existing !== undefined) {
      const changed =
        reported !== undefined && reported !== existing.hint.transcriptPath;
      existing.hint = {
        ...existing.hint,
        ...(reported !== undefined ? { transcriptPath: reported } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
      if (changed) existing.runner.relocate();
      return existing;
    }
    // 同一节点上一个会话行的来源不再需要了。
    for (const old of [...this.sources.values()]) {
      if (old.nodeId === nodeId && old.timelineId !== row.id) this.drop(old);
    }
    return this.create(row, nodeId, adapter, {
      agentId: baseAgent(row.agentId || adapter.agentId),
      ...(reported !== undefined ? { transcriptPath: reported } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      cwd: row.cwd,
      startedAtMs: row.createdAtMs,
    });
  }

  private create(
    row: SessionRow,
    nodeId: string,
    adapter: TranscriptAdapter,
    hint: SessionHint,
  ): Source {
    const domain = this.domain;
    domain.open({
      timelineId: row.id,
      workspaceId: row.workspaceId,
      nodeId,
      source: "transcript",
    });
    const stored = domain.store.get(row.id);
    const storedCursor =
      stored?.source === "transcript" ? stored.sourceCursor : "";
    const initial: TailCursor | undefined = decodeCursor(storedCursor);
    const sink = new TimelineSink(domain.writer, row.id, {
      onTurnBegin: (turnId) => {
        if (domain.activity.get(row.id)?.turnStartedAt === undefined) {
          domain.activity.prompt(row.id, turnId);
        }
      },
      onTurnEnd: (info) => {
        if (domain.activity.get(row.id)?.turnStartedAt !== undefined) {
          domain.activity.turnEnded(
            row.id,
            outcomeOf(
              info.stopReason,
              info.error === undefined ? undefined : info.error,
            ),
          );
        }
      },
    });
    // 接回时没有 hook 报路径，就沿用游标里的那个（文件来源）。
    if (
      adapter.source === undefined &&
      hint.transcriptPath === undefined &&
      initial !== undefined
    ) {
      hint = { ...hint, transcriptPath: initial.path };
    }
    const source: Source = {
      timelineId: row.id,
      nodeId,
      adapter,
      sink,
      hint,
      runner: undefined as unknown as SourceRunner,
    };
    const onError = (error: unknown) =>
      this.options.log?.warn("读取转录失败", {
        timelineId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    const runner: SourceRunner =
      adapter.source !== undefined
        ? adapter.source({
            hint: () => source.hint,
            initialCursor: storedCursor === "" ? undefined : storedCursor,
            onRead: (batch) =>
              this.consume(source, batch.lines, batch.reset, batch.cursor),
            onError,
            timers: this.options.timers,
            watch: this.options.watch,
            stat: this.options.stat,
          })
        : new TailRunner({
            locate: () => adapter.locate(source.hint),
            initialCursor: initial,
            onRead: (result) =>
              this.consume(
                source,
                result.lines,
                result.reset !== undefined,
                result.cursor === undefined
                  ? undefined
                  : encodeCursor(result.cursor),
              ),
            onError,
            ...(this.options.timers !== undefined
              ? { timers: this.options.timers }
              : {}),
            ...(this.options.watch !== undefined
              ? { watch: this.options.watch }
              : {}),
            ...(this.options.stat !== undefined
              ? { stat: this.options.stat }
              : {}),
          });
    (source as { runner: SourceRunner }).runner = runner;
    this.sources.set(row.id, source);
    this.armReaper();
    runner.start();
    return source;
  }

  /** 读到一批行：交给适配器，然后存游标。 */
  private consume(
    source: Source,
    lines: readonly string[],
    backfill: boolean,
    cursor: string | undefined,
  ): void {
    source.sink.backfill = backfill;
    for (const line of lines) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        source.adapter.convert(record, source.sink);
      } catch (error) {
        this.options.log?.debug?.("转录里有一行没能转换", {
          timelineId: source.timelineId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    source.sink.backfill = false;
    if (cursor !== undefined) {
      this.domain.store.setSourceCursor(
        source.timelineId,
        "transcript",
        cursor,
      );
    }
  }

  /** core 启动时：上次还在读的、会话行仍是 `running` 的，接着读。 */
  resume(): number {
    const rows = this.options.database
      .prepare(
        "SELECT t.id AS id, t.node_id AS nodeId FROM timelines t " +
          "JOIN terminal_sessions s ON s.id = t.id " +
          "WHERE t.source = 'transcript' AND s.status = 'running'",
      )
      .all() as { id: string; nodeId: string }[];
    let resumed = 0;
    for (const { id, nodeId } of rows) {
      const session = this.options.database
        .prepare(
          "SELECT id, workspace_id, agent_id, cwd, created_at FROM terminal_sessions WHERE id = ?",
        )
        .get(id) as
        | {
            id: string;
            workspace_id: string;
            agent_id: string | null;
            cwd: string;
            created_at: string;
          }
        | undefined;
      const adapter = transcriptAdapterFor(session?.agent_id ?? undefined);
      if (session === undefined || adapter === undefined) continue;
      try {
        this.sourceFor(
          {
            id,
            workspaceId: session.workspace_id,
            agentId: session.agent_id ?? "",
            cwd: session.cwd,
            createdAtMs: Date.parse(session.created_at) || 0,
          },
          nodeId,
          adapter,
          undefined,
        );
        resumed++;
      } catch (error) {
        this.options.log?.warn("接回转录读取失败", {
          timelineId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    resumed += this.resumeSlots();
    return resumed;
  }

  /** core 重启：仍在 `running` 的会话上，登记过槽的 CLI 重新开槽（槽自己重放文件尾恢复状态）。 */
  private resumeSlots(): number {
    const rows = this.options.database
      .prepare(
        "SELECT id, owner_node_id AS nodeId, workspace_id, agent_id, cwd, created_at, generation " +
          "FROM terminal_sessions WHERE status = 'running' AND backend_kind != 'acp' " +
          "AND owner_node_id IS NOT NULL",
      )
      .all() as {
      id: string;
      nodeId: string;
      workspace_id: string;
      agent_id: string | null;
      cwd: string;
      created_at: string;
      generation: number;
    }[];
    let opened = 0;
    for (const session of rows) {
      if (stateSlotProviderFor(baseAgent(session.agent_id ?? "")) === undefined)
        continue;
      try {
        const open = this.openSlot(
          {
            id: session.id,
            workspaceId: session.workspace_id,
            agentId: session.agent_id ?? "",
            cwd: session.cwd,
            createdAtMs: Date.parse(session.created_at) || 0,
            generation: Number(session.generation) || 0,
          },
          session.nodeId,
        );
        if (open !== undefined) opened++;
      } catch (error) {
        this.options.log?.warn("接回状态读取槽失败", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return opened;
  }

  /* ------------------------------- 巡检与收尾 ------------------------------- */

  private armReaper(): void {
    if (this.reaper !== undefined || this.closed) return;
    this.reaper = this.timers.setTimeout(() => {
      this.reaper = undefined;
      this.reap();
      if (this.sources.size > 0 || this.slots.size > 0) this.armReaper();
    }, REAP_INTERVAL_MS);
  }

  /** 停掉会话行已经不是 `running` 的来源（最后再读一次）。 */
  reap(): number {
    let stopped = 0;
    for (const open of [...this.slots.values()]) {
      const row = this.options.database
        .prepare("SELECT status FROM terminal_sessions WHERE id = ?")
        .get(open.sessionId) as { status: string } | undefined;
      if (row?.status === "running") continue;
      try {
        open.slot.readNow?.();
      } catch (error) {
        this.options.log?.warn("状态读取槽收尾读取失败", {
          sessionId: open.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.dropSlot(open);
      stopped++;
    }
    for (const source of [...this.sources.values()]) {
      const row = this.options.database
        .prepare("SELECT status FROM terminal_sessions WHERE id = ?")
        .get(source.timelineId) as { status: string } | undefined;
      if (row?.status === "running") continue;
      source.runner.readNow();
      this.drop(source);
      stopped++;
    }
    return stopped;
  }

  private drop(source: Source): void {
    source.runner.stop();
    this.sources.delete(source.timelineId);
  }

  get size(): number {
    return this.sources.size;
  }

  /** 开着的状态读取槽个数（测试与诊断）。 */
  get slotCount(): number {
    return this.slots.size;
  }

  close(): void {
    this.closed = true;
    if (this.reaper !== undefined) this.timers.clearTimeout(this.reaper);
    this.reaper = undefined;
    for (const source of [...this.sources.values()]) this.drop(source);
    for (const open of [...this.slots.values()]) this.dropSlot(open);
  }
}
