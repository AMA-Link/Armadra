/**
 * 一个 ACP 会话写时间线的那一侧（设计 §2、§2.4；契约 §82）。
 *
 * `AcpSession` 只说「发生了什么」，这里把它翻成对 `TimelineWriter` 与
 * `ActivityTracker` 的调用，次序固定：
 *
 *   * 回合开始：先 `writer.turnBegin`，再 `activity.prompt`；
 *   * 回合结束：先 `writer.turnEnd`，再 `activity.turnEnded`；
 *   * 内容阶段（思考、文本、工具、审批）由写入器每写一批自动推导，不手动设。
 *
 * 时间线以会话行 id 为键；驱动切换不换行 id，所以同一条时间线跨代次延续。
 * 时间线已有内容时，`session/load` 的回放不写条目，只让活动显示「恢复中」；
 * 时间线为空（第一次接管旧会话）时回放经 reducer 写入，条目带 `source = replay`。
 */

import type {
  AcpOpsContext,
  AcpPrompt,
  TimelineHead,
  TimelineItem,
  TimelineNoticeCode,
  TimelineToolItem,
} from "@armadra/shared";

import { renderEntries } from "../collab/transcript";
import { entriesFromTimeline } from "../history/acp-mirror";
import type { TimelineDomain } from "../timeline";
import { outcomeOf } from "../timeline";
import type {
  AcpElicitationSettlement,
  AcpPendingElicitation,
  AcpPendingPermission,
  AcpPermissionSettlement,
} from "./client";
import { storedElicitation } from "./elicitation";
import type { MirrorFrame } from "./mirror-import";

export interface AcpFeedIdentity {
  readonly rowId: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly generation: number;
}

/** 回放期间每多少帧向活动报一次进度（每帧报一次会让事件流被回放淹没）。 */
const RESTORE_REPORT_EVERY = 25;

interface TurnRef {
  readonly turnId: string;
  readonly turn: number;
}

export class AcpFeed {
  private active: TurnRef | undefined;
  private last: TurnRef | undefined;
  /** 打开时时间线是不是空的：决定回放要不要写、恢复要不要回放。 */
  readonly hadHistory: boolean;
  private replayed = 0;
  private replayTurns = 0;
  private replayTurn: TurnRef | undefined;
  private replayLastKind: string | undefined;
  private readonly waits = new Map<string, number>();
  private waitedMs = 0;
  /** 导入旧镜像时用记录的时间代替「现在」。 */
  private clock: number | undefined;

  constructor(
    private readonly domain: TimelineDomain,
    private readonly id: AcpFeedIdentity,
  ) {
    domain.open({
      timelineId: id.rowId,
      workspaceId: id.workspaceId,
      nodeId: id.nodeId,
      source: "acp",
    });
    this.hadHistory = domain.writer.currentTurn(id.rowId) !== undefined;
  }

  private get writer() {
    return this.domain.writer;
  }

  private get activity() {
    return this.domain.activity;
  }

  private ctx(replay = false, turn?: TurnRef): AcpOpsContext {
    const ref = turn ?? this.active ?? this.last;
    return {
      turnId: ref?.turnId ?? `${this.id.generation}-0`,
      turn: ref?.turn ?? this.writer.currentTurn(this.id.rowId) ?? 0,
      at: this.clock ?? Date.now(),
      gen: this.id.generation,
      source: replay ? "replay" : "acp",
    };
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  starting(step: "spawn" | "initialize" | "session" | "configure"): void {
    this.activity.starting(this.id.rowId, step);
  }

  /** 开始接回（`session/load` 回放前）。 */
  restoring(): void {
    this.replayed = 0;
    this.activity.restoring(this.id.rowId, 0);
  }

  /**
   * 会话开好（或配置之后）把模式、模型目录与提示能力写进时间线头部（B10）。
   * 只写与头部现值不同的项；这一次没有而头部有的清成 `null`。
   */
  catalog(next: {
    readonly modes: TimelineHead["modes"];
    readonly models: TimelineHead["models"];
    readonly promptCapabilities: TimelineHead["promptCapabilities"];
  }): void {
    const head = this.writer.state(this.id.rowId)?.head ?? {};
    const patch: Record<string, unknown> = {};
    for (const key of ["modes", "models", "promptCapabilities"] as const) {
      const value = next[key] ?? null;
      const current = head[key] ?? null;
      if (JSON.stringify(value) !== JSON.stringify(current)) {
        patch[key] = value;
      }
    }
    if (Object.keys(patch).length === 0) return;
    this.writer.head(this.id.rowId, patch as TimelineHead, { flush: "soon" });
  }

  /** 时间线渲染出的最后几行（桥的 `capture`：`context terminal`、自动命名）。 */
  capture(lines: number): string {
    this.writer.flush(this.id.rowId);
    const rendered = renderEntries(
      entriesFromTimeline(this.domain.store.tailItems(this.id.rowId, 3)),
    )
      .map((record) => record.line)
      .join("\n")
      .split("\n");
    return lines <= 0
      ? rendered.join("\n")
      : rendered.slice(Math.max(0, rendered.length - lines)).join("\n");
  }

  ready(): void {
    this.finishReplay();
    this.activity.ready(this.id.rowId);
  }

  notice(
    code: TimelineNoticeCode,
    params?: Record<string, string | number | boolean | null>,
  ): void {
    this.writer.notice(this.id.rowId, this.ctx(), code, params);
  }

  sleeping(): void {
    this.notice("hibernated");
    this.activity.sleeping(this.id.rowId);
  }

  exited(params?: Record<string, string | number | boolean | null>): void {
    this.settleOpen("cancelled");
    this.notice("exited", params);
    this.activity.exited(this.id.rowId);
  }

  /** 起会话失败：记一条错误提示，活动落到 `exited`。 */
  failed(code: string): void {
    this.notice("error", { code });
    this.activity.exited(this.id.rowId);
  }

  /* -------------------------------- 回合 -------------------------------- */

  beginTurn(turnId: string, prompt?: AcpPrompt): void {
    this.finishReplay();
    const turn = this.writer.nextTurn(this.id.rowId);
    this.active = { turnId, turn };
    this.waitedMs = 0;
    this.writer.turnBegin(this.id.rowId, this.ctx(), prompt);
    this.activity.prompt(this.id.rowId, turnId);
  }

  endTurn(
    end: {
      readonly stopReason?: string;
      readonly error?: { readonly code: string; readonly message: string };
    },
    usage?: { readonly used: number; readonly size: number } | null,
  ): void {
    const ref = this.active;
    if (ref === undefined) return;
    this.settleOpen("cancelled");
    this.writer.turnEnd(this.id.rowId, this.ctx(false, ref), {
      ...end,
      ...(usage ? { usage: { used: usage.used, size: usage.size } } : {}),
      permissionWaitMs: this.waitedMs,
    });
    this.activity.turnEnded(
      this.id.rowId,
      outcomeOf(end.stopReason, end.error),
    );
    this.last = ref;
    this.active = undefined;
  }

  /* -------------------------------- 更新 -------------------------------- */

  update(update: unknown, replay: boolean): void {
    if (!replay) {
      this.writer.acpUpdate(this.id.rowId, update, this.ctx());
      return;
    }
    this.replayed += 1;
    if (this.replayed === 1 || this.replayed % RESTORE_REPORT_EVERY === 0) {
      this.activity.restoring(this.id.rowId, this.replayed);
    }
    if (this.hadHistory) return;
    const kind = (update as { sessionUpdate?: string } | null)?.sessionUpdate;
    if (kind === "user_message_chunk" && this.replayLastKind !== kind) {
      this.closeReplayTurn();
      this.replayTurns += 1;
      const turn = this.writer.nextTurn(this.id.rowId);
      this.replayTurn = {
        turnId: `${this.id.generation}-r${this.replayTurns}`,
        turn,
      };
      this.writer.turnBegin(this.id.rowId, this.ctx(true, this.replayTurn));
    } else if (this.replayTurn === undefined) {
      this.replayTurns += 1;
      const turn = this.writer.nextTurn(this.id.rowId);
      this.replayTurn = {
        turnId: `${this.id.generation}-r${this.replayTurns}`,
        turn,
      };
      this.writer.turnBegin(this.id.rowId, this.ctx(true, this.replayTurn));
    }
    this.replayLastKind = kind;
    this.writer.acpUpdate(
      this.id.rowId,
      update,
      this.ctx(true, this.replayTurn),
    );
  }

  /**
   * 把旧镜像的帧导入时间线（设计 §2.6）：没有 `session/load` 的适配器接回升级前的
   * 会话时用。时间线已有内容（含这次回放已经写了的）时什么都不做，所以重复接回
   * 幂等；写出的条目与回放一样带 `source = replay`。答写没写。
   */
  importFrames(frames: readonly MirrorFrame[]): boolean {
    if (
      this.hadHistory ||
      frames.length === 0 ||
      this.writer.currentTurn(this.id.rowId) !== undefined
    ) {
      return false;
    }
    try {
      for (const frame of frames) {
        this.clock = frame.at;
        this.update(frame.update, true);
      }
      this.finishReplay();
    } finally {
      this.clock = undefined;
    }
    return true;
  }

  private closeReplayTurn(): void {
    const ref = this.replayTurn;
    if (ref === undefined) return;
    this.writer.turnEnd(this.id.rowId, this.ctx(true, ref), {
      stopReason: "end_turn",
    });
    this.last = ref;
    this.replayTurn = undefined;
  }

  private finishReplay(): void {
    this.closeReplayTurn();
    this.replayLastKind = undefined;
  }

  /* ------------------------------ 审批 / 提问 ------------------------------ */

  private nextOrd(turn: number): number {
    const state = this.writer.state(this.id.rowId);
    let max = 0;
    for (const item of Object.values(state?.items ?? {})) {
      if (item.turn === turn && item.ord > max) max = item.ord;
    }
    return max + 1;
  }

  private putPending(
    build: (ctx: AcpOpsContext, ord: number) => TimelineItem,
  ): void {
    const ctx = this.ctx();
    this.writer.write(
      this.id.rowId,
      (state) => [
        {
          seq: state.seq + 1,
          op: "put",
          item: build(ctx, this.nextOrd(ctx.turn)),
        },
      ],
      { flush: "now" },
    );
  }

  private setToolPermission(
    toolCallId: string,
    permission: NonNullable<TimelineToolItem["permission"]>,
  ): void {
    this.writer.write(
      this.id.rowId,
      (state) => {
        const tool = Object.values(state.items).find(
          (item): item is TimelineToolItem =>
            item.kind === "tool" && item.toolCallId === toolCallId,
        );
        return tool === undefined
          ? []
          : [{ seq: state.seq + 1, op: "put", item: { ...tool, permission } }];
      },
      { flush: "now" },
    );
  }

  permission(pendingId: string, pending: AcpPendingPermission): void {
    this.waits.set(pendingId, Date.now());
    const toolCallId = pending.toolCall.toolCallId;
    this.putPending((ctx, ord) => ({
      id: `ap:${pendingId}`,
      turn: ctx.turn,
      ord,
      rev: 0,
      source: "acp",
      at: ctx.at,
      gen: ctx.gen,
      kind: "approval",
      pendingId,
      protocol: "acp",
      ...(toolCallId ? { toolCallId } : {}),
      options: pending.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
      state: "pending",
    }));
    if (toolCallId) {
      this.setToolPermission(toolCallId, { pendingId, outcome: "pending" });
    }
  }

  permissionSettled(
    pendingId: string,
    pending: AcpPendingPermission,
    settlement: AcpPermissionSettlement,
  ): void {
    this.endWait(pendingId);
    const optionId =
      settlement.by === "answer" && settlement.outcome.outcome === "selected"
        ? settlement.outcome.optionId
        : undefined;
    const option = pending.options.find((o) => o.optionId === optionId);
    const outcome =
      optionId === undefined
        ? "cancelled"
        : option?.kind.startsWith("reject")
          ? "denied"
          : "allowed";
    this.writer.write(
      this.id.rowId,
      (state) => {
        const item = state.items[`ap:${pendingId}`];
        if (item?.kind !== "approval" || item.state !== "pending") return [];
        return [
          {
            seq: state.seq + 1,
            op: "put",
            item: {
              ...item,
              state: outcome === "cancelled" ? "cancelled" : "answered",
              ...(optionId === undefined ? {} : { answer: { optionId } }),
            },
          },
        ];
      },
      { flush: "now" },
    );
    const toolCallId = pending.toolCall.toolCallId;
    if (toolCallId) {
      this.setToolPermission(toolCallId, {
        pendingId,
        outcome,
        ...(optionId === undefined ? {} : { optionId }),
      });
    }
  }

  elicitation(pendingId: string, pending: AcpPendingElicitation): void {
    this.waits.set(pendingId, Date.now());
    const stored = storedElicitation(pending.request);
    this.putPending((ctx, ord) => ({
      id: `el:${pendingId}`,
      turn: ctx.turn,
      ord,
      rev: 0,
      source: "acp",
      at: ctx.at,
      gen: ctx.gen,
      kind: "elicitation",
      pendingId,
      message: stored.message,
      mode: stored.mode,
      ...(stored.requestedSchema === undefined
        ? {}
        : { requestedSchema: JSON.stringify(stored.requestedSchema) }),
      ...(stored.url === undefined ? {} : { url: stored.url }),
      state: "pending",
    }));
  }

  elicitationSettled(
    pendingId: string,
    settlement: AcpElicitationSettlement,
  ): void {
    this.endWait(pendingId);
    const action = settlement.result.action;
    this.writer.write(
      this.id.rowId,
      (state) => {
        const item = state.items[`el:${pendingId}`];
        if (item?.kind !== "elicitation" || item.state !== "pending") return [];
        return [
          {
            seq: state.seq + 1,
            op: "put",
            item: {
              ...item,
              state: settlement.by === "cancelled" ? "cancelled" : "answered",
              answer: { action },
            },
          },
        ];
      },
      { flush: "now" },
    );
  }

  private endWait(pendingId: string): void {
    const started = this.waits.get(pendingId);
    if (started === undefined) return;
    this.waits.delete(pendingId);
    this.waitedMs += Math.max(0, Date.now() - started);
  }

  /** 回合收尾 / 退出时还挂着的审批：回合结束的 reducer 会把审批条目记 cancelled。 */
  private settleOpen(_how: "cancelled"): void {
    this.waits.clear();
  }
}
