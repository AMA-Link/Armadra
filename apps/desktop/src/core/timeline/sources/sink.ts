/**
 * 适配器写时间线的统一出口（设计 §5.1「转换器」）。
 *
 * 各家转换器只说「这里来了一条用户消息 / 一个工具调用 / 一段思考…」，怎么编号、
 * 排序、合并、落库都在这里：
 *
 *   * id 用 CLI 自己的 id（`tool:<toolCallId>`、`a:<记录 id>:<块号>`…），同一条重复读到
 *     只是 upsert，不会重复；
 *   * 回合序号取写入器的 `nextTurn`，回合内序取当前最大序 +1；
 *   * 工具按 `toolCallId` 合并（`mergeToolCall`：状态只前进），结果晚到也能补上；
 *   * 内存里已经没有的条目（更早的回合）不再回头改：晚到的工具结果直接丢弃。
 *
 * 转换器本身不持有回合状态：「当前回合」「某个工具是否存在」都从写入器的内存状态
 * 里读，所以 core 重启后接着游标读，不需要重建任何东西。
 */

import {
  type AcpOpsContext,
  type TimelineAssistantItem,
  type TimelineHead,
  type TimelineItem,
  type TimelineNoticeCode,
  type TimelinePlanEntry,
  type TimelineThoughtItem,
  type TimelineToolItem,
  type TimelineTurnItem,
  type TimelineUserItem,
  type ToolPatch,
  acpTurnBeginOps,
  acpTurnEndOps,
  mergeToolCall,
} from "@armadra/shared";

import type { TimelineWriter } from "../writer";

/** 驱动代次：转录来源没有「切换驱动」，固定 0。 */
const GEN = 0;

export interface TurnEndInfo {
  readonly stopReason?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly usage?: { readonly used: number; readonly size: number };
}

/** 回合开始 / 结束的通知：管理器据此推进活动层（回填时不通知）。 */
export interface SinkEvents {
  onTurnBegin?(turnId: string): void;
  onTurnEnd?(info: TurnEndInfo): void;
}

export class TimelineSink {
  /** 回填（第一次接管的尾部导入）时不通知活动层。 */
  backfill = false;

  constructor(
    private readonly writer: TimelineWriter,
    readonly timelineId: string,
    private readonly events: SinkEvents = {},
  ) {}

  /* -------------------------------- 查询 -------------------------------- */

  /** 内存里最新的回合条目（可能已结束）。 */
  latestTurn(): TimelineTurnItem | undefined {
    const state = this.writer.state(this.timelineId);
    if (state === undefined) return undefined;
    let best: TimelineTurnItem | undefined;
    for (const item of Object.values(state.items)) {
      if (item.kind !== "turn") continue;
      if (best === undefined || item.turn > best.turn) best = item;
    }
    return best;
  }

  /** 最新的回合若还没结束就是「打开的」。 */
  openTurn(): TimelineTurnItem | undefined {
    const turn = this.latestTurn();
    return turn !== undefined && turn.endedAt === undefined ? turn : undefined;
  }

  item(id: string): TimelineItem | undefined {
    return this.writer.state(this.timelineId)?.items[id];
  }

  tool(toolCallId: string): TimelineToolItem | undefined {
    const found = this.item(`tool:${toolCallId}`);
    return found?.kind === "tool" ? found : undefined;
  }

  private ctx(turn: TimelineTurnItem, at: number): AcpOpsContext {
    return this.writer.withBlobs(this.timelineId, {
      turnId: turn.turnId,
      turn: turn.turn,
      at,
      gen: GEN,
      source: "transcript",
    });
  }

  /** 给工具内容 / 附件存 blob 用的上下文（不需要回合时给一个占位）。 */
  blobContext(at: number): AcpOpsContext {
    const turn = this.latestTurn();
    return this.writer.withBlobs(this.timelineId, {
      turnId: turn?.turnId ?? "-",
      turn: turn?.turn ?? 0,
      at,
      gen: GEN,
      source: "transcript",
    });
  }

  /* -------------------------------- 回合 -------------------------------- */

  /**
   * 开一个回合（带用户消息）。上一个回合还开着就先收尾（不记停止原因：用户
   * 在回合中间又发了话）。同一个 `turnId` 重复调用不产生操作。
   */
  beginTurn(
    turnId: string,
    at: number,
    prompt?: Pick<TimelineUserItem, "text" | "attachments">,
  ): TimelineTurnItem {
    const existing = this.item(`turn:${turnId}`);
    if (existing?.kind === "turn") return existing;
    const open = this.openTurn();
    if (open !== undefined) this.endTurn(at, {});
    const turn = this.writer.nextTurn(this.timelineId);
    const ctx: AcpOpsContext = this.writer.withBlobs(this.timelineId, {
      turnId,
      turn,
      at,
      gen: GEN,
      source: "transcript",
    });
    const body =
      prompt === undefined
        ? undefined
        : {
            text: prompt.text,
            ...(prompt.attachments !== undefined
              ? { attachments: prompt.attachments }
              : {}),
          };
    this.writer.write(
      this.timelineId,
      (state) => acpTurnBeginOps(state, ctx, body),
      { flush: "now" },
    );
    const created = this.item(`turn:${turnId}`);
    if (!this.backfill) this.events.onTurnBegin?.(turnId);
    return created as TimelineTurnItem;
  }

  /**
   * 给打开的回合补一条用户消息（Codex 的回合先开、用户消息后到）。已经有用户
   * 消息的回合，同样的文本忽略；不同的文本记成这个回合里的追加消息。
   */
  addUserToTurn(
    turn: TimelineTurnItem,
    at: number,
    text: string,
    key: string,
    attachments?: TimelineUserItem["attachments"],
  ): void {
    const first = this.item(`u:${turn.turnId}`);
    let id = `u:${turn.turnId}`;
    if (first?.kind === "user") {
      if (first.text === text) return;
      id = `u:${turn.turnId}:${key}`;
      if (this.item(id) !== undefined) return;
    }
    this.putNext(turn, id, at, (base) => ({
      ...base,
      kind: "user",
      text,
      ...(attachments !== undefined && attachments.length > 0
        ? { attachments: [...attachments] }
        : {}),
    }));
  }

  /** 结束打开的回合；没有打开的回合什么也不做。 */
  endTurn(at: number, end: TurnEndInfo): boolean {
    const turn = this.openTurn();
    if (turn === undefined) return false;
    const ctx = this.ctx(turn, at);
    this.writer.write(
      this.timelineId,
      (state) => acpTurnEndOps(state, ctx, end),
      { flush: "now" },
    );
    if (!this.backfill) this.events.onTurnEnd?.(end);
    return true;
  }

  /**
   * 内容要挂的回合：最新的回合（哪怕已结束——CLI 的收尾记录可能晚于 Stop），
   * 一个都没有（从文件中间开始读）才开一个隐含的。
   */
  turnForContent(at: number, fallbackId: string): TimelineTurnItem {
    return this.latestTurn() ?? this.beginTurn(fallbackId, at);
  }

  /* -------------------------------- 条目 -------------------------------- */

  private nextOrd(turn: number): number {
    const state = this.writer.state(this.timelineId);
    let max = 0;
    if (state !== undefined) {
      for (const item of Object.values(state.items)) {
        if (item.turn === turn && item.ord > max) max = item.ord;
      }
    }
    return max + 1;
  }

  private base(turn: TimelineTurnItem, id: string, ord: number, at: number) {
    return {
      id,
      turn: turn.turn,
      ord,
      rev: 0,
      source: "transcript" as const,
      at,
      gen: GEN,
    };
  }

  /** 放一个新条目（已存在则不动）；序号取回合里下一个。 */
  private putNext(
    turn: TimelineTurnItem,
    id: string,
    at: number,
    make: (base: ReturnType<TimelineSink["base"]>) => TimelineItem,
  ): void {
    if (this.item(id) !== undefined) return;
    const item = make(this.base(turn, id, this.nextOrd(turn.turn), at));
    this.writer.put(this.timelineId, item);
  }

  assistant(
    turn: TimelineTurnItem,
    id: string,
    at: number,
    parts: TimelineAssistantItem["parts"],
  ): void {
    if (parts.length === 0) return;
    this.putNext(turn, id, at, (base) => ({
      ...base,
      kind: "assistant",
      parts: [...parts],
      streaming: false,
    }));
  }

  thought(turn: TimelineTurnItem, id: string, at: number, text: string): void {
    this.putNext(turn, id, at, (base) => {
      const item: TimelineThoughtItem = {
        ...base,
        kind: "thought",
        text,
        streaming: false,
      };
      return item;
    });
  }

  notice(
    turn: TimelineTurnItem,
    id: string,
    at: number,
    code: TimelineNoticeCode,
    params: Record<string, string | number | boolean | null> = {},
  ): void {
    this.putNext(turn, id, at, (base) => ({
      ...base,
      kind: "notice",
      code,
      params,
    }));
  }

  /** 新建或合并一个工具调用；条目已不在内存里又不是新工具的补丁丢弃。 */
  upsertTool(
    turn: TimelineTurnItem,
    toolCallId: string,
    at: number,
    patch: ToolPatch,
    options: { readonly create?: boolean } = {},
  ): TimelineToolItem | undefined {
    const id = `tool:${toolCallId}`;
    const existing = this.tool(toolCallId);
    if (existing === undefined && options.create !== true) return undefined;
    const fields = mergeToolCall(existing, patch, at);
    const item: TimelineToolItem = {
      ...(existing ?? this.base(turn, id, this.nextOrd(turn.turn), at)),
      ...fields,
      kind: "tool",
      toolCallId,
    };
    if (existing !== undefined && same(existing, item)) return existing;
    this.writer.put(this.timelineId, item);
    return item;
  }

  plan(
    turn: TimelineTurnItem,
    at: number,
    entries: readonly TimelinePlanEntry[],
  ): void {
    const id = `plan:${turn.turn}`;
    const existing = this.item(id);
    if (existing?.kind === "plan") {
      if (JSON.stringify(existing.entries) === JSON.stringify(entries)) return;
      this.writer.put(this.timelineId, {
        ...existing,
        entries: [...entries],
      });
      return;
    }
    this.putNext(turn, id, at, (base) => ({
      ...base,
      kind: "plan",
      entries: [...entries],
    }));
  }

  /* -------------------------------- 头部 -------------------------------- */

  usage(usage: { used: number; size: number }): void {
    const head = this.writer.state(this.timelineId)?.head;
    if (JSON.stringify(head?.usage) === JSON.stringify(usage)) return;
    this.writer.head(this.timelineId, { usage });
  }

  /** 头部现在的用量（回合结束时记进回合条目）。 */
  usageNow(): { used: number; size: number } | undefined {
    const usage = this.writer.state(this.timelineId)?.head.usage;
    return usage === undefined || usage === null
      ? undefined
      : { used: usage.used, size: usage.size };
  }

  title(title: string): void {
    const trimmed = title.trim().slice(0, 1_000);
    if (trimmed === "") return;
    const head = this.writer.state(this.timelineId)?.head;
    if (head?.title === trimmed) return;
    const patch: TimelineHead = { title: trimmed };
    this.writer.head(this.timelineId, patch);
  }
}

function same(a: TimelineItem, b: TimelineItem): boolean {
  return JSON.stringify({ ...a, rev: 0 }) === JSON.stringify({ ...b, rev: 0 });
}
