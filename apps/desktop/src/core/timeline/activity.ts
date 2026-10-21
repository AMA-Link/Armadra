/**
 * 活动状态机（设计 §2.4）：粗状态 `agent_status.state` 之外更细的一层，只在内存里。
 *
 * 输入三类：
 *   * 时间线写入（{@link ActivityTracker.observe}）：从内存状态里推导文本流、思考流、
 *     工具、审批与提问；
 *   * 会话生命周期（`starting` / `restoring` / `ready` / `prompt` / `turnEnded` /
 *     `switching` / `sleeping` / `exited`）：由 ACP 会话与终端域调用；
 *   * 外部信号（{@link ActivityTracker.external}）：终端驱动的 CLI 经 hook 来的阶段。
 *
 * 阶段优先级：`awaiting_approval` > `awaiting_input` > `tool` > `responding` >
 * `thinking` > `submitting`。工具全部结束后回到最近一个文本或思考阶段；回合结束
 * 回到 `idle` 并写 `lastOutcome`。生命周期阶段（启动、恢复、切换、休眠、退出）盖过
 * 内容推导，直到 `ready` / `prompt` 把它们解除。
 *
 * 变化时通过 `publish` 发 `timeline.activity`（只在阶段或细节真的变了才发，文本流
 * 里每个分块都不发）；`rev` 是 `${bootId}:${n}`，`bootId` 每次进程启动换一个，
 * 页面比较时先比 bootId 再比 n（共享层 `compareActivityRev`）。
 */

import {
  type ActivityOutcomeKind,
  type ActivityPhase,
  type SessionActivity,
  type TimelineItem,
  type TimelineState,
  type TimelineToolItem,
  isTerminalToolStatus,
} from "@armadra/shared";

/** 恢复历史（`session/load` 回放）静默超过这么久就不再显示「恢复中」。 */
export const RESTORE_SILENCE_MS = 120_000;

/** 生命周期阶段：盖过内容推导。 */
const LIFECYCLE: ReadonlySet<ActivityPhase> = new Set([
  "starting",
  "restoring",
  "switching",
  "sleeping",
  "exited",
]);

export interface ActivityTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: ActivityTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface ActivityTrackerOptions {
  /** 每次进程启动换一个；活动 `rev` 的前缀。 */
  readonly bootId: string;
  readonly publish: (change: {
    readonly timelineId: string;
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly activity: SessionActivity;
  }) => void;
  readonly timers?: ActivityTimers;
}

export interface TurnOutcome {
  readonly kind: ActivityOutcomeKind;
  readonly error?: string;
}

/** ACP 的停止原因 → 活动里的结局种类。 */
export function outcomeOf(
  stopReason: string | undefined,
  error?: { readonly message: string },
): TurnOutcome {
  if (error !== undefined) return { kind: "failed", error: error.message };
  switch (stopReason) {
    case "cancelled":
      return { kind: "cancelled" };
    case "refusal":
      return { kind: "refused" };
    case "max_tokens":
    case "max_turn_requests":
      return { kind: "limit" };
    default:
      return { kind: "done" };
  }
}

interface Record_ {
  readonly timelineId: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  /** 生命周期或外部信号强加的阶段；没有就按内容推导。 */
  forced?: { phase: ActivityPhase; detail?: SessionActivity["detail"] };
  /** 回合进行中（提示发出，还没结束）。 */
  turn?: { turnId: string | undefined; startedAt: number };
  lastOutcome?: SessionActivity["lastOutcome"];
  lastOutputAt?: number;
  /** 最近一次内存状态（写入器每写一批给一次）。 */
  state?: TimelineState;
  current: SessionActivity;
  count: number;
  restoreTimer?: unknown;
}

function detailKey(detail: SessionActivity["detail"]): string {
  return detail === undefined
    ? ""
    : `${detail.label ?? ""}|${detail.toolKind ?? ""}|${detail.count ?? ""}|${detail.step ?? ""}`;
}

export class ActivityTracker {
  private readonly records = new Map<string, Record_>();
  private readonly timers: ActivityTimers;

  constructor(private readonly options: ActivityTrackerOptions) {
    this.timers = options.timers ?? realTimers;
  }

  /** 登记一条时间线（带它的归属）；已登记的原样保留。 */
  bind(timelineId: string, workspaceId: string, nodeId: string): void {
    if (this.records.has(timelineId)) return;
    this.records.set(timelineId, {
      timelineId,
      workspaceId,
      nodeId,
      count: 0,
      current: this.initial(),
    });
  }

  /** 此刻的活动；core 重启后没有登记过的是 `undefined`（调用方按会话行补）。 */
  get(timelineId: string): SessionActivity | undefined {
    return this.records.get(timelineId)?.current;
  }

  /** 按会话行推出重启后的活动：活着是 `idle`，休眠是 `sleeping`，其余 `exited`。 */
  fallback(
    liveness: "alive" | "sleeping" | "gone",
    sinceMs: number,
  ): SessionActivity {
    return {
      phase:
        liveness === "alive"
          ? "idle"
          : liveness === "sleeping"
            ? "sleeping"
            : "exited",
      since: sinceMs,
      rev: `${this.options.bootId}:0`,
    };
  }

  /* ------------------------------- 生命周期 ------------------------------- */

  starting(
    timelineId: string,
    step: "spawn" | "initialize" | "session" | "configure",
  ): void {
    this.force(timelineId, "starting", { step });
  }

  /** 回放中：`replayed` 是已回放的条数；每来一帧重新计 {@link RESTORE_SILENCE_MS}。 */
  restoring(timelineId: string, replayed: number): void {
    const record = this.records.get(timelineId);
    if (record === undefined) return;
    if (record.restoreTimer !== undefined) {
      this.timers.clearTimeout(record.restoreTimer);
    }
    record.restoreTimer = this.timers.setTimeout(() => {
      record.restoreTimer = undefined;
      if (record.forced?.phase === "restoring") this.ready(timelineId);
    }, RESTORE_SILENCE_MS);
    this.force(timelineId, "restoring", { count: replayed });
  }

  /** 就绪：解除生命周期阶段，回到按内容推导（没有进行中的回合就是 `idle`）。 */
  ready(timelineId: string): void {
    const record = this.records.get(timelineId);
    if (record === undefined) return;
    this.clearRestoreTimer(record);
    delete record.forced;
    this.refresh(record, undefined);
  }

  /** 提示已发出：`submitting`，回合开始。休眠和退出的会话也由它唤起。 */
  prompt(timelineId: string, turnId?: string): void {
    const record = this.records.get(timelineId);
    if (record === undefined) return;
    this.clearRestoreTimer(record);
    delete record.forced;
    record.turn = { turnId, startedAt: this.timers.now() };
    this.refresh(record, undefined);
  }

  /** 回合结束：回到 `idle`，记 `lastOutcome`。 */
  turnEnded(timelineId: string, outcome: TurnOutcome): void {
    const record = this.records.get(timelineId);
    if (record === undefined) return;
    delete record.turn;
    record.lastOutcome = {
      kind: outcome.kind,
      at: this.timers.now(),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
    this.refresh(record, undefined);
  }

  switching(timelineId: string): void {
    this.force(timelineId, "switching");
  }

  sleeping(timelineId: string): void {
    const record = this.records.get(timelineId);
    if (record !== undefined) delete record.turn;
    this.force(timelineId, "sleeping");
  }

  exited(timelineId: string): void {
    const record = this.records.get(timelineId);
    if (record !== undefined) delete record.turn;
    this.force(timelineId, "exited");
  }

  /**
   * 外部信号（终端驱动的 CLI 经 hook 来的阶段，设计 §5）：它自己说「在跑工具」
   * 「在等审批」时直接给阶段；`null` 撤销，回到按内容推导。
   */
  external(
    timelineId: string,
    signal: {
      readonly phase: ActivityPhase;
      readonly detail?: SessionActivity["detail"];
      readonly turnId?: string;
    } | null,
  ): void {
    const record = this.records.get(timelineId);
    if (record === undefined) return;
    if (signal === null) {
      delete record.forced;
    } else {
      if (signal.turnId !== undefined || record.turn === undefined) {
        if (signal.phase !== "idle") {
          record.turn ??= {
            turnId: signal.turnId,
            startedAt: this.timers.now(),
          };
        }
      }
      record.forced = {
        phase: signal.phase,
        ...(signal.detail !== undefined ? { detail: signal.detail } : {}),
      };
      if (signal.phase === "idle") delete record.turn;
    }
    this.refresh(record, undefined);
  }

  /** 这条时间线不再需要状态（节点删除）。 */
  drop(timelineId: string): void {
    const record = this.records.get(timelineId);
    if (record !== undefined) this.clearRestoreTimer(record);
    this.records.delete(timelineId);
  }

  /** 停所有计时器（关库之前）。 */
  close(): void {
    for (const record of this.records.values()) this.clearRestoreTimer(record);
    this.records.clear();
  }

  /* ------------------------------- 内容推导 ------------------------------- */

  /** 写入器每写一批操作之后调：按内存状态推导内容阶段。 */
  observe(timelineId: string, state: TimelineState, sawOutput = true): void {
    const record = this.records.get(timelineId);
    if (record === undefined) return;
    this.refresh(record, { state, sawOutput });
  }

  private force(
    timelineId: string,
    phase: ActivityPhase,
    detail?: SessionActivity["detail"],
  ): void {
    const record = this.records.get(timelineId);
    if (record === undefined) return;
    if (phase !== "restoring") this.clearRestoreTimer(record);
    record.forced = { phase, ...(detail !== undefined ? { detail } : {}) };
    this.refresh(record, undefined);
  }

  private clearRestoreTimer(record: Record_): void {
    if (record.restoreTimer !== undefined) {
      this.timers.clearTimeout(record.restoreTimer);
      record.restoreTimer = undefined;
    }
  }

  private initial(): SessionActivity {
    return {
      phase: "idle",
      since: this.timers.now(),
      rev: `${this.options.bootId}:0`,
    };
  }

  private refresh(
    record: Record_,
    observed: { state: TimelineState; sawOutput: boolean } | undefined,
  ): void {
    const now = this.timers.now();
    if (observed !== undefined) {
      record.state = observed.state;
      if (observed.sawOutput) record.lastOutputAt = now;
    }
    const state = record.state;
    const next = this.derive(record, state);
    const previous = record.current;
    const changed =
      next.phase !== previous.phase ||
      detailKey(next.detail) !== detailKey(previous.detail) ||
      next.turnId !== previous.turnId ||
      next.lastOutcome !== previous.lastOutcome;
    if (!changed) {
      // 没有可见变化：只让 `lastOutputAt` 随内存里最新的走，不发事件。
      if (record.lastOutputAt !== previous.lastOutputAt) {
        record.current = {
          ...previous,
          ...(record.lastOutputAt !== undefined
            ? { lastOutputAt: record.lastOutputAt }
            : {}),
        };
      }
      return;
    }
    record.count++;
    record.current = {
      ...next,
      since: next.phase === previous.phase ? previous.since : now,
      rev: `${this.options.bootId}:${record.count}`,
    };
    this.options.publish({
      timelineId: record.timelineId,
      workspaceId: record.workspaceId,
      nodeId: record.nodeId,
      activity: record.current,
    });
  }

  private derive(
    record: Record_,
    state: TimelineState | undefined,
  ): Omit<SessionActivity, "rev"> {
    const base = {
      ...(record.turn?.turnId !== undefined
        ? { turnId: record.turn.turnId }
        : {}),
      ...(record.turn !== undefined
        ? { turnStartedAt: record.turn.startedAt }
        : {}),
      ...(record.lastOutcome !== undefined
        ? { lastOutcome: record.lastOutcome }
        : {}),
      ...(record.lastOutputAt !== undefined
        ? { lastOutputAt: record.lastOutputAt }
        : {}),
      since: record.current.since,
    };
    const forced = record.forced;
    if (forced !== undefined && LIFECYCLE.has(forced.phase)) {
      return {
        ...base,
        phase: forced.phase,
        ...(forced.detail !== undefined ? { detail: forced.detail } : {}),
      };
    }
    const content: ContentPhase | undefined =
      state === undefined
        ? undefined
        : contentPhase(state, record.turn?.turnId, record.turn !== undefined);
    // 外部信号（hook）给的阶段与内容推导里优先级高的那个取其重。
    if (forced !== undefined) {
      if (content === undefined || rank(forced.phase) >= rank(content.phase)) {
        return {
          ...base,
          phase: forced.phase,
          ...(forced.detail !== undefined ? { detail: forced.detail } : {}),
        };
      }
    }
    if (content !== undefined && content.phase !== "idle") {
      return {
        ...base,
        phase: content.phase,
        ...(content.detail !== undefined ? { detail: content.detail } : {}),
      };
    }
    if (content === undefined ? record.turn !== undefined : content.active) {
      // 回合进行中但此刻没有流式的东西：提示刚发出（还没有第一帧）是 `submitting`；
      // 工具刚结束则回到回合里最近一次内容的种类。
      return { ...base, phase: content?.resting ?? "submitting" };
    }
    return { ...base, phase: "idle" };
  }
}

/* --------------------------------- 推导 --------------------------------- */

const RANK: Record<ActivityPhase, number> = {
  awaiting_approval: 7,
  awaiting_input: 6,
  tool: 5,
  responding: 4,
  thinking: 3,
  submitting: 2,
  idle: 1,
  starting: 0,
  restoring: 0,
  switching: 0,
  sleeping: 0,
  exited: 0,
};

function rank(phase: ActivityPhase): number {
  return RANK[phase];
}

interface ContentPhase {
  readonly phase: ActivityPhase;
  readonly detail?: SessionActivity["detail"];
  /** 回合进行中（`phase` 为 `idle` 时说明此刻没有流式的东西）。 */
  readonly active: boolean;
  /** 回合里最近一次内容的种类，工具结束后回到它。 */
  readonly resting?: "responding" | "thinking";
}

function runningTools(items: readonly TimelineItem[]): TimelineToolItem[] {
  return items.filter(
    (item): item is TimelineToolItem =>
      item.kind === "tool" && !isTerminalToolStatus(item.status),
  );
}

/**
 * 从内存状态里看此刻内容层在做什么。回合是否进行中由生命周期说了算（`prompted`：
 * 提示发出、`turnEnded` 还没来）；`promptedTurnId` 给了的话，状态里那个回合条目
 * 一旦写上 `endedAt` 也算收尾（写入器先写回合结束、生命周期随后才报，中间不闪）。
 * 挂起的审批 / 提问不看回合，一直算数。
 */
export function contentPhase(
  state: TimelineState,
  promptedTurnId: string | undefined,
  prompted: boolean,
): ContentPhase {
  const all = Object.values(state.items);
  let maxTurn = -1;
  for (const item of all) if (item.turn > maxTurn) maxTurn = item.turn;
  const turnItem =
    promptedTurnId === undefined
      ? undefined
      : all.find(
          (item) => item.kind === "turn" && item.turnId === promptedTurnId,
        );
  const active =
    prompted && !(turnItem?.kind === "turn" && turnItem.endedAt !== undefined);

  if (
    all.some((item) => item.kind === "approval" && item.state === "pending")
  ) {
    return { phase: "awaiting_approval", active };
  }
  if (
    all.some((item) => item.kind === "elicitation" && item.state === "pending")
  ) {
    return { phase: "awaiting_input", active };
  }
  if (!active) return { phase: "idle", active };

  const items = all
    .filter((item) => item.turn === (turnItem?.turn ?? maxTurn))
    .sort((a, b) => a.ord - b.ord);
  const tools = runningTools(items);
  if (tools.length > 0) {
    const latest = tools[tools.length - 1] as TimelineToolItem;
    return {
      phase: "tool",
      active,
      detail: {
        ...(latest.title !== "" ? { label: latest.title } : {}),
        toolKind: latest.toolKind,
        count: tools.length,
      },
    };
  }
  const streaming = [...items]
    .reverse()
    .find(
      (item) =>
        (item.kind === "assistant" || item.kind === "thought") &&
        item.streaming,
    );
  if (streaming !== undefined) {
    return {
      phase: streaming.kind === "assistant" ? "responding" : "thinking",
      active,
    };
  }
  const lastContent = [...items]
    .reverse()
    .find((item) => item.kind === "assistant" || item.kind === "thought");
  if (lastContent !== undefined) {
    return {
      phase: "idle",
      active,
      resting: lastContent.kind === "assistant" ? "responding" : "thinking",
    };
  }
  // 有过工具但都结束了、没有任何文本或思考：首帧后暂无可见输出。
  return items.some((item) => item.kind === "tool")
    ? { phase: "idle", active, resting: "thinking" }
    : { phase: "idle", active };
}
