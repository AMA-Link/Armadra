import type {
  TimelineAssistantItem,
  TimelineDelta,
  TimelineHead,
  TimelineItem,
  TimelineItemRecord,
  TimelineOp,
  TimelineSyncResult,
  TimelineThoughtItem,
  TimelineToolItem,
  TimelineToolStatus,
  TurnIndex,
} from "./timeline.js";

/**
 * 时间线的归约（设计 §2.3）：core 与页面共用这一份，所以两边的结果一定一致。
 *
 * 规则只有三条：
 *  - 帧按 `from === 本地 seq` 顺序应用；`to <= 本地 seq` 是重复帧，丢弃；
 *    `from > 本地 seq` 是缺口，丢弃并按 `syncAfter` 发起 `timeline.sync`。
 *  - 每个操作只在 `op.seq` 大于它要改的条目的 `rev` 时才生效（条目级幂等），
 *    所以与同步结果交叠的帧、部分重放的帧都不会把条目改回去。
 *  - 同步返回 `rev > after` 的完整值（含墓碑），任何游标一次补齐。
 *
 * 全部是纯函数；状态不可变（每次调用至多复制一次表）。
 */

/* -------------------------------- 状态 -------------------------------- */

export interface TimelineState {
  /** 已经应用到的最后一个序号。 */
  readonly seq: number;
  readonly head: TimelineHead;
  /** 头部值最后一次修改的序号。 */
  readonly headRev: number;
  /** 活的条目，键是条目 id。 */
  readonly items: Readonly<Record<string, TimelineItem>>;
  /** 被删条目的 id → 删除时的序号，挡住迟到的旧 `put`。 */
  readonly tombstones: Readonly<Record<string, number>>;
}

export function emptyTimelineState(): TimelineState {
  return { seq: 0, head: {}, headRev: 0, items: {}, tombstones: {} };
}

/** 条目的显示顺序：回合、回合内序、id（兜底，保证全序）。 */
export function compareTimelineItems(
  a: Pick<TimelineItem, "turn" | "ord" | "id">,
  b: Pick<TimelineItem, "turn" | "ord" | "id">,
): number {
  if (a.turn !== b.turn) return a.turn - b.turn;
  if (a.ord !== b.ord) return a.ord - b.ord;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 按显示顺序排好的活条目。 */
export function sortedTimelineItems(state: TimelineState): TimelineItem[] {
  return Object.values(state.items).sort(compareTimelineItems);
}

/** 从快照 / 缓存恢复状态：条目按完整值落下，`seq` 取快照头。 */
export function timelineStateFrom(input: {
  headSeq: number;
  head?: TimelineHead;
  headRev?: number;
  items: readonly TimelineItem[];
}): TimelineState {
  const items: Record<string, TimelineItem> = {};
  for (const item of input.items) items[item.id] = item;
  return {
    seq: input.headSeq,
    head: input.head ?? {},
    headRev: input.headRev ?? 0,
    items,
    tombstones: {},
  };
}

/* ------------------------------ 应用操作 ------------------------------ */

export interface ApplyOpsResult {
  readonly state: TimelineState;
  /** 生效的操作数。 */
  readonly applied: number;
  /** 目标条目不在本地（也没有墓碑）的 `append`：页面只取了尾部，或有缺口。 */
  readonly orphans: number;
}

function mergeHead(head: TimelineHead, patch: TimelineHead): TimelineHead {
  const next: Record<string, unknown> = { ...head };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return next as TimelineHead;
}

/** 把一段流式文本接到条目上；这种条目不接文本时答 `null`。 */
export function appendToItem(
  item: TimelineItem,
  delta: { text: string; part?: number | undefined },
): TimelineItem | null {
  switch (item.kind) {
    case "user":
    case "thought":
      return { ...item, text: item.text + delta.text };
    case "assistant": {
      const parts = item.parts.slice();
      let index = delta.part ?? -1;
      if (delta.part === undefined) {
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i]?.type === "text") {
            index = i;
            break;
          }
        }
      }
      const target = parts[index];
      if (target?.type === "text") {
        parts[index] = { type: "text", text: target.text + delta.text };
      } else if (target === undefined) {
        parts.push({ type: "text", text: delta.text });
      } else {
        return null;
      }
      return { ...item, parts } satisfies TimelineAssistantItem;
    }
    default:
      return null;
  }
}

/**
 * 应用一批操作（按 `seq` 升序；传入的顺序不要紧）。同一批里 `seq` 必须严格
 * 递增，条目级的 `seq` 守卫保证重放无害。
 */
export function applyTimelineOps(
  state: TimelineState,
  ops: readonly TimelineOp[],
): ApplyOpsResult {
  if (ops.length === 0) return { state, applied: 0, orphans: 0 };
  const sorted = ops.length > 1 ? [...ops].sort((a, b) => a.seq - b.seq) : ops;
  const items: Record<string, TimelineItem> = { ...state.items };
  const tombstones: Record<string, number> = { ...state.tombstones };
  let head = state.head;
  let headRev = state.headRev;
  let seq = state.seq;
  let applied = 0;
  let orphans = 0;

  for (const op of sorted) {
    if (op.seq > seq) seq = op.seq;
    switch (op.op) {
      case "put": {
        const id = op.item.id;
        const floor = Math.max(items[id]?.rev ?? -1, tombstones[id] ?? -1);
        if (op.seq <= floor) break;
        items[id] = { ...op.item, rev: op.seq };
        delete tombstones[id];
        applied++;
        break;
      }
      case "append": {
        const current = items[op.itemId];
        if (current === undefined) {
          if (tombstones[op.itemId] === undefined) orphans++;
          break;
        }
        if (op.seq <= current.rev) break;
        const next = appendToItem(current, op.delta);
        if (next === null) break;
        items[op.itemId] = { ...next, rev: op.seq };
        applied++;
        break;
      }
      case "remove": {
        const floor = Math.max(
          items[op.itemId]?.rev ?? -1,
          tombstones[op.itemId] ?? -1,
        );
        if (op.seq <= floor) break;
        delete items[op.itemId];
        tombstones[op.itemId] = op.seq;
        applied++;
        break;
      }
      case "head": {
        if (op.seq <= headRev) break;
        head = mergeHead(head, op.head);
        headRev = op.seq;
        applied++;
        break;
      }
    }
  }
  return {
    state: { seq, head, headRev, items, tombstones },
    applied,
    orphans,
  };
}

export type FrameOutcome = "applied" | "duplicate" | "gap";

export interface ApplyFrameResult {
  readonly state: TimelineState;
  readonly outcome: FrameOutcome;
  /** `gap` 时：用这个游标调 `timeline.sync`。 */
  readonly syncAfter?: number;
  readonly orphans: number;
}

/**
 * 应用一帧 `timeline.delta`。`from <= seq < to` 的交叠帧也应用（条目级守卫
 * 挡住已经有的部分）；缺口返回 `gap`，本地状态不变。
 */
export function applyTimelineFrame(
  state: TimelineState,
  frame: Pick<TimelineDelta, "from" | "to" | "ops">,
): ApplyFrameResult {
  if (frame.to <= state.seq) {
    return { state, outcome: "duplicate", orphans: 0 };
  }
  if (frame.from > state.seq) {
    return { state, outcome: "gap", syncAfter: state.seq, orphans: 0 };
  }
  const result = applyTimelineOps(state, frame.ops);
  const next =
    result.state.seq >= frame.to
      ? result.state
      : { ...result.state, seq: frame.to };
  return { state: next, outcome: "applied", orphans: result.orphans };
}

/* ------------------------------ 增量同步 ------------------------------ */

/**
 * 应用 `timeline.sync` / `timeline.open` 的答。每项按 `rev` 守卫：比本地新的
 * 才生效，所以应答和并发到达的帧可以任意交叠。
 */
export function applyTimelineSync(
  state: TimelineState,
  result: TimelineSyncResult,
): TimelineState {
  const items: Record<string, TimelineItem> = { ...state.items };
  const tombstones: Record<string, number> = { ...state.tombstones };
  for (const record of result.items as readonly TimelineItemRecord[]) {
    const floor = Math.max(
      items[record.id]?.rev ?? -1,
      tombstones[record.id] ?? -1,
    );
    if (record.rev <= floor) continue;
    if ("deleted" in record) {
      delete items[record.id];
      tombstones[record.id] = record.rev;
    } else {
      items[record.id] = record;
      delete tombstones[record.id];
    }
  }
  let head = state.head;
  let headRev = state.headRev;
  if (result.head !== undefined) {
    const rev = result.headRev ?? result.headSeq;
    if (rev > headRev) {
      head = result.head;
      headRev = rev;
    }
  }
  return {
    seq: Math.max(state.seq, result.headSeq),
    head,
    headRev,
    items,
    tombstones,
  };
}

/**
 * 参考实现：由一份完整状态答 `timeline.sync(after)`。core 用 SQL 答同一个问题；
 * 这份给测试、内存缓存与对拍用。
 */
export function timelineChangesSince(
  state: TimelineState,
  after: number,
): TimelineSyncResult {
  const records: TimelineItemRecord[] = [];
  for (const item of Object.values(state.items)) {
    if (item.rev > after) records.push(item);
  }
  for (const [id, rev] of Object.entries(state.tombstones)) {
    if (rev > after) records.push({ id, rev, deleted: true });
  }
  records.sort((a, b) => a.rev - b.rev);
  return {
    headSeq: state.seq,
    ...(state.headRev > after
      ? { head: state.head, headRev: state.headRev }
      : {}),
    items: records,
  };
}

/**
 * 把一批连续的操作压实：同一条目相邻的 `append` 合并，被后面的 `put` /
 * `remove` 盖掉的丢弃，`head` 合并成一条。压实后每个条目的最终 `rev` 等于
 * 它最后一个保留的操作的 `seq`；core 对库和对帧用同一份压实结果，两边的 `rev`
 * 才一致。
 */
export function compactTimelineOps(ops: readonly TimelineOp[]): TimelineOp[] {
  const sorted = [...ops].sort((a, b) => a.seq - b.seq);
  const out: (TimelineOp | null)[] = [];
  const last = new Map<string, number>();
  const HEAD_KEY = "\u0000head";
  for (const op of sorted) {
    const key =
      op.op === "head" ? HEAD_KEY : op.op === "put" ? op.item.id : op.itemId;
    const at = last.get(key);
    const previous = at === undefined ? null : (out[at] ?? null);
    let next: TimelineOp = op;
    let supersede = op.op === "put" || op.op === "remove";
    if (previous !== null) {
      if (op.op === "head" && previous.op === "head") {
        next = {
          seq: op.seq,
          op: "head",
          head: mergeHead(previous.head, op.head),
        };
        supersede = true;
      } else if (
        op.op === "append" &&
        previous.op === "append" &&
        previous.delta.part === op.delta.part
      ) {
        next = {
          seq: op.seq,
          op: "append",
          itemId: op.itemId,
          delta: {
            text: previous.delta.text + op.delta.text,
            ...(op.delta.part !== undefined ? { part: op.delta.part } : {}),
          },
        };
        supersede = true;
      } else if (op.op === "append" && previous.op === "put") {
        const merged = appendToItem(previous.item, op.delta);
        if (merged !== null) {
          next = { seq: op.seq, op: "put", item: merged };
          supersede = true;
        }
      }
    }
    if (supersede && at !== undefined) out[at] = null;
    last.set(key, out.length);
    out.push(next);
  }
  return out.filter((op): op is TimelineOp => op !== null);
}

/* ----------------------------- 流式文本合并 ----------------------------- */

/**
 * 短于这个长度的分块一律追加：真实流里 `\n`、`ha`、`--` 这样的短 token 会重复，
 * 去重规则会把它们吞掉。适配器重发整段或快照式分块时，分块都远长于此。
 */
export const STREAM_DEDUP_MIN_CHARS = 16;

export type StreamMergeMode = "append" | "snapshot" | "duplicate";

export interface StreamMerge {
  readonly text: string;
  readonly mode: StreamMergeMode;
}

/**
 * 把一个分块并进已有文本，处理适配器重发和快照式分块：
 *  - 新块以已有文本开头（且更长）：当作快照，直接替换；
 *  - 已有文本以新块结尾（或两者相同）：当作重复，跳过；
 *  - 否则追加。
 */
export function mergeStreamChunk(
  existing: string,
  chunk: string,
  minChars: number = STREAM_DEDUP_MIN_CHARS,
): StreamMerge {
  if (chunk === "") return { text: existing, mode: "duplicate" };
  if (existing === "") return { text: chunk, mode: "append" };
  if (chunk.length >= minChars) {
    if (chunk === existing || existing.endsWith(chunk)) {
      return { text: existing, mode: "duplicate" };
    }
    if (chunk.length > existing.length && chunk.startsWith(existing)) {
      return { text: chunk, mode: "snapshot" };
    }
  }
  return { text: existing + chunk, mode: "append" };
}

/* ------------------------------ 工具调用合并 ------------------------------ */

const TERMINAL_STATUSES: ReadonlySet<TimelineToolStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalToolStatus(status: TimelineToolStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function statusRank(status: TimelineToolStatus): number {
  return status === "pending" ? 0 : status === "in_progress" ? 1 : 2;
}

/** 一次 `tool_call` / `tool_call_update` 带来的字段；没带的不动。 */
export interface ToolPatch {
  toolKind?: TimelineToolItem["toolKind"] | undefined;
  title?: string | undefined;
  status?: TimelineToolStatus | undefined;
  locations?: TimelineToolItem["locations"] | undefined;
  input?: TimelineToolItem["input"] | undefined;
  content?: TimelineToolItem["content"] | undefined;
  permission?: TimelineToolItem["permission"] | undefined;
  parentToolCallId?: string | undefined;
}

export type ToolFields = Pick<
  TimelineToolItem,
  | "toolKind"
  | "title"
  | "status"
  | "locations"
  | "input"
  | "content"
  | "permission"
  | "parentToolCallId"
  | "startedAt"
  | "endedAt"
>;

/**
 * 按 `toolCallId` 合并一次更新：`content` 整体替换；`status` 只前进不后退
 * （终态之后的更新不改状态）；标题只在非空时替换；第一次到终态时记 `endedAt`。
 */
export function mergeToolCall(
  previous: TimelineToolItem | undefined,
  patch: ToolPatch,
  at: number,
): ToolFields {
  let status: TimelineToolStatus = previous?.status ?? "pending";
  if (patch.status !== undefined) {
    if (previous === undefined) status = patch.status;
    else if (
      !isTerminalToolStatus(previous.status) &&
      statusRank(patch.status) >= statusRank(previous.status)
    ) {
      status = patch.status;
    }
  }
  const title =
    patch.title !== undefined && patch.title !== ""
      ? patch.title
      : (previous?.title ?? "");
  const endedAt =
    previous?.endedAt ?? (isTerminalToolStatus(status) ? at : undefined);
  const input = patch.input ?? previous?.input;
  const permission = patch.permission ?? previous?.permission;
  const parent = patch.parentToolCallId ?? previous?.parentToolCallId;
  return {
    toolKind: patch.toolKind ?? previous?.toolKind ?? "other",
    title,
    status,
    locations: patch.locations ?? previous?.locations ?? [],
    content: patch.content ?? previous?.content ?? [],
    startedAt: previous?.startedAt ?? at,
    ...(input !== undefined ? { input } : {}),
    ...(permission !== undefined ? { permission } : {}),
    ...(parent !== undefined ? { parentToolCallId: parent } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

/* -------------------------------- 活动组 -------------------------------- */

export interface ActivitySummary {
  reads: number;
  /** edit / delete / move。 */
  edits: number;
  commands: number;
  searches: number;
  fetches: number;
  thoughts: number;
  /** think / switch_mode / other / subagent。 */
  others: number;
  failed: number;
}

export type ActivityGroupMember = TimelineToolItem | TimelineThoughtItem;

export type ActivityEntry =
  | {
      readonly type: "item";
      readonly item: TimelineItem;
      /** 子代理工具的内部调用（挂在它下面，默认折叠）。 */
      readonly children?: readonly TimelineToolItem[];
    }
  | {
      readonly type: "group";
      /** `g:<第一个成员的 id>`，稳定，流式追加成员时不变。 */
      readonly id: string;
      readonly items: readonly ActivityGroupMember[];
      readonly summary: ActivitySummary;
      /** 有工具没结束或思考还在流：渲染时保持展开。 */
      readonly running: boolean;
    };

export interface ActivityGroupOptions {
  /** 少于这么多个连续成员就不折叠，缺省 2。 */
  minRun?: number;
}

export function summarizeActivity(
  members: readonly ActivityGroupMember[],
): ActivitySummary {
  const summary: ActivitySummary = {
    reads: 0,
    edits: 0,
    commands: 0,
    searches: 0,
    fetches: 0,
    thoughts: 0,
    others: 0,
    failed: 0,
  };
  for (const member of members) {
    if (member.kind === "thought") {
      summary.thoughts++;
      continue;
    }
    if (member.status === "failed") summary.failed++;
    switch (member.toolKind) {
      case "read":
        summary.reads++;
        break;
      case "edit":
      case "delete":
      case "move":
        summary.edits++;
        break;
      case "execute":
        summary.commands++;
        break;
      case "search":
        summary.searches++;
        break;
      case "fetch":
        summary.fetches++;
        break;
      default:
        summary.others++;
    }
  }
  return summary;
}

function isMember(item: TimelineItem): item is ActivityGroupMember {
  return item.kind === "tool" || item.kind === "thought";
}

function isRunning(member: ActivityGroupMember): boolean {
  return member.kind === "thought"
    ? member.streaming
    : !isTerminalToolStatus(member.status);
}

/**
 * 渲染层的派生（不存储）：把同一回合里连续的工具调用和思考折成一个活动组，
 * 并给出摘要；子代理里的调用挂到子代理那一行下面。`items` 要按显示顺序给。
 */
export function activityGroups(
  items: readonly TimelineItem[],
  options: ActivityGroupOptions = {},
): ActivityEntry[] {
  const minRun = Math.max(1, options.minRun ?? 2);
  const toolIds = new Set<string>();
  for (const item of items) {
    if (item.kind === "tool") toolIds.add(item.toolCallId);
  }
  const children = new Map<string, TimelineToolItem[]>();
  const top: TimelineItem[] = [];
  for (const item of items) {
    const parent = item.kind === "tool" ? item.parentToolCallId : undefined;
    if (
      item.kind === "tool" &&
      parent !== undefined &&
      parent !== item.toolCallId &&
      toolIds.has(parent)
    ) {
      const list = children.get(parent) ?? [];
      list.push(item);
      children.set(parent, list);
    } else {
      top.push(item);
    }
  }

  const out: ActivityEntry[] = [];
  let run: ActivityGroupMember[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const first = run[0] as ActivityGroupMember;
    if (run.length >= minRun) {
      out.push({
        type: "group",
        id: `g:${first.id}`,
        items: run,
        summary: summarizeActivity(run),
        running: run.some(isRunning),
      });
    } else {
      for (const member of run) out.push(entryFor(member, children));
    }
    run = [];
  };
  for (const item of top) {
    if (isMember(item)) {
      const last = run[run.length - 1];
      if (last !== undefined && last.turn !== item.turn) flush();
      run.push(item);
    } else {
      flush();
      out.push({ type: "item", item });
    }
  }
  flush();
  return out;
}

function entryFor(
  member: ActivityGroupMember,
  children: ReadonlyMap<string, TimelineToolItem[]>,
): ActivityEntry {
  const nested =
    member.kind === "tool" ? children.get(member.toolCallId) : undefined;
  return nested !== undefined
    ? { type: "item", item: member, children: nested }
    : { type: "item", item: member };
}

/* -------------------------------- 回合索引 -------------------------------- */

/** 由完整的条目列表算回合索引（core 用 SQL 算同一个东西；这份给缓存与测试）。 */
export function turnIndexOf(items: readonly TimelineItem[]): TurnIndex[] {
  const byTurn = new Map<number, TurnIndex>();
  const sorted = [...items].sort(compareTimelineItems);
  for (const item of sorted) {
    let entry = byTurn.get(item.turn);
    if (entry === undefined) {
      entry = {
        turnId: `turn-${item.turn}`,
        turn: item.turn,
        startedAt: item.at,
        headText: "",
        counts: { items: 0, tools: 0, thoughts: 0, messages: 0 },
      };
      byTurn.set(item.turn, entry);
    }
    if (item.kind === "turn") {
      entry.turnId = item.turnId;
      entry.startedAt = item.startedAt;
      if (item.endedAt !== undefined) entry.endedAt = item.endedAt;
      continue;
    }
    entry.counts.items++;
    if (item.kind === "tool") entry.counts.tools++;
    else if (item.kind === "thought") entry.counts.thoughts++;
    else if (item.kind === "assistant") entry.counts.messages++;
    else if (item.kind === "user" && entry.headText === "") {
      entry.headText = Array.from(item.text).slice(0, 80).join("");
    }
  }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}
