/**
 * 旧主机退路（设计 §2.6「远端主机版本较旧」）：没有 `timeline.*` 的主机、或还没写过
 * 时间线的会话，仍然只有 `acp.log`（镜像）+ `acp.update`（实时分块）。这里把它们
 * 喂进共享层同一套 reducer，得到与 `timeline.*` 同形的条目，页面因此只有一条渲染路。
 *
 * 全部是纯函数：状态不可变，时间由调用方给（测试可复现）。B10 下线旧接口时整个文件
 * 连同 `use-legacy-acp.ts` 一起删除。
 */
import {
  acpTurnBeginOps,
  acpTurnEndOps,
  applyTimelineOps,
  emptyTimelineState,
  isTerminalToolStatus,
  reduceAcpUpdate,
  sortedTimelineItems,
  type AcpElicitation,
  type AcpLogResponse,
  type AcpPermissionOption,
  type AcpToolCall,
  type AcpTurnEvent,
  type AcpTurnRecord,
  type SessionActivity,
  type TimelineAttachment,
  type TimelineHead,
  type TimelineItem,
  type TimelineOp,
  type TimelineState,
  type TimelineToolItem,
} from "@armadra/shared";

import { blobFromBase64, putLocalBlob } from "./blobs";

/** 页面发出、还没在镜像里读到的一句。 */
export interface LocalPrompt {
  readonly clientTurnId: string;
  readonly text: string;
  readonly attachments?: readonly TimelineAttachment[];
}

export interface LegacyState {
  readonly timeline: TimelineState;
  /** 最后一个回合的序号；0 = 还没有回合。 */
  readonly turn: number;
  /** 最后一个回合还没结束。 */
  readonly open: boolean;
  /** 还没被镜像确认的本页提问（重读镜像时补回去）。 */
  readonly locals: readonly LocalPrompt[];
}

export function emptyLegacyState(): LegacyState {
  return { timeline: emptyTimelineState(), turn: 0, open: false, locals: [] };
}

const GEN = 1;

function turnIdOf(turn: number): string {
  return `l${turn}`;
}

function ctxOf(turn: number, at: number, source?: "replay") {
  return {
    turnId: turnIdOf(turn),
    turn,
    at,
    gen: GEN,
    ...(source === undefined ? {} : { source }),
    storeBlob: ({
      mimeType,
      data,
    }: {
      kind: "image" | "audio" | "resource";
      mimeType: string;
      data: string;
    }) => {
      try {
        const blob = blobFromBase64(data, mimeType);
        return { blobId: putLocalBlob(blob), bytes: blob.size };
      } catch {
        return null;
      }
    },
  };
}

function withOps(
  state: LegacyState,
  ops: readonly TimelineOp[],
  patch: Partial<Omit<LegacyState, "timeline">> = {},
): LegacyState {
  const timeline =
    ops.length === 0
      ? state.timeline
      : applyTimelineOps(state.timeline, ops).state;
  return { ...state, ...patch, timeline };
}

function turnItems(state: LegacyState, turn: number): TimelineItem[] {
  return Object.values(state.timeline.items).filter(
    (item) => item.turn === turn,
  );
}

function nextOrd(state: LegacyState, turn: number): number {
  return (
    turnItems(state, turn).reduce((max, item) => Math.max(max, item.ord), 0) + 1
  );
}

/** 手工写一条条目（审批、收尾工具）：序号接在状态后面。 */
function put(state: LegacyState, item: TimelineItem): LegacyState {
  const op: TimelineOp = { seq: state.timeline.seq + 1, op: "put", item };
  return withOps(state, [op]);
}

/* -------------------------------- 回合 -------------------------------- */

/** 开一个新回合；上一个没结束的先收尾。`prompt` 给了就连用户消息一起写。 */
export function beginTurn(
  state: LegacyState,
  at: number,
  prompt?: LocalPrompt,
  source?: "replay",
): LegacyState {
  let current = state.open ? endTurn(state, {}, at) : state;
  const turn = current.turn + 1;
  const ops = acpTurnBeginOps(
    current.timeline,
    ctxOf(turn, at, source),
    prompt === undefined
      ? undefined
      : {
          text: prompt.text,
          clientTurnId: prompt.clientTurnId,
          ...(prompt.attachments === undefined ||
          prompt.attachments.length === 0
            ? {}
            : { attachments: [...prompt.attachments] }),
        },
  );
  current = withOps(current, ops, { turn, open: true });
  return prompt === undefined
    ? current
    : { ...current, locals: [...current.locals, prompt] };
}

/** 回合收尾：把还没结束的工具记成完成（出错或被打断时 reducer 记 `cancelled`）。 */
export function endTurn(
  state: LegacyState,
  event: Pick<AcpTurnEvent, "stopReason" | "error">,
  at: number,
): LegacyState {
  if (state.turn === 0) {
    // 还没有回合（重载后只有挂起的审批 / 提问）：只把挂起的收掉。
    let bare: LegacyState = { ...state, open: false };
    for (const item of pendingItems(bare)) {
      if (item.kind === "approval" || item.kind === "elicitation") {
        bare = resolvePending(bare, item.pendingId, "cancelled");
      }
    }
    return bare;
  }
  const ops = acpTurnEndOps(state.timeline, ctxOf(state.turn, at), {
    ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
    ...(event.error === undefined
      ? {}
      : { error: { code: event.error.code, message: event.error.message } }),
  });
  let next = withOps(state, ops, { open: false });
  for (const item of turnItems(next, next.turn)) {
    if (item.kind === "tool" && !isTerminalToolStatus(item.status)) {
      next = put(next, { ...item, status: "completed", endedAt: at });
    } else if (item.kind === "elicitation" && item.state === "pending") {
      // 回合结束时挂起的提问 core 已回了 cancel（契约 §26.1）。
      next = put(next, { ...item, state: "cancelled" });
    }
  }
  return next;
}

/* ------------------------------ session/update ------------------------------ */

const CONTENT_UPDATES: ReadonlySet<string> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

/** 一条实时 `session/update`。不画的种类原样返回。 */
export function applyUpdate(
  state: LegacyState,
  update: unknown,
  at: number,
): LegacyState {
  const kind = (update as { sessionUpdate?: unknown } | null)?.sessionUpdate;
  let current = state;
  if (kind === "user_message_chunk") {
    // 本页刚发的那一句已经画着（带 `clientTurnId`）：适配器回显的同一句不再画
    // 第二遍；其余（别处发的、回放里的）开新回合。
    if (current.open) {
      const own = turnItems(current, current.turn).find(
        (item) => item.kind === "user",
      );
      if (own?.kind === "user" && own.clientTurnId !== undefined) {
        return current;
      }
    } else {
      current = beginTurn(current, at);
    }
  } else if (typeof kind === "string" && CONTENT_UPDATES.has(kind)) {
    if (!current.open) current = beginTurn(current, at);
  }
  const ctx = ctxOf(Math.max(current.turn, 0), at);
  const { state: timeline } = reduceAcpUpdate(current.timeline, update, ctx);
  return timeline === current.timeline ? current : { ...current, timeline };
}

/* ------------------------------ 审批与提问 ------------------------------ */

export interface LegacyApproval {
  readonly pendingId: string;
  readonly toolCall: AcpToolCall;
  readonly options: readonly AcpPermissionOption[];
}

export interface LegacyElicitation {
  readonly pendingId: string;
  readonly elicitation: AcpElicitation;
}

function pendingItems(state: LegacyState) {
  return Object.values(state.timeline.items).filter(
    (item) =>
      (item.kind === "approval" || item.kind === "elicitation") &&
      item.state === "pending",
  );
}

/** 一条挂起的审批：写成 `approval` 条目，挂在对应工具所在的回合。 */
export function addApproval(
  state: LegacyState,
  approval: LegacyApproval,
  at: number,
): LegacyState {
  const id = `ap:${approval.pendingId}`;
  if (state.timeline.items[id] !== undefined) return state;
  let current = state;
  // 审批总是针对一个工具调用；它的 `tool_call` 帧没到（重载后只有挂起的请求）时，
  // 用请求里带的那份补一个工具行，卡片的标题和差异预览才有出处。
  if (
    current.timeline.items[`tool:${approval.toolCall.toolCallId}`] === undefined
  ) {
    current = applyUpdate(
      current,
      { ...approval.toolCall, sessionUpdate: "tool_call" },
      at,
    );
  }
  const toolItem =
    current.timeline.items[`tool:${approval.toolCall.toolCallId}`];
  const turn = toolItem?.turn ?? Math.max(current.turn, 0);
  return put(current, {
    id,
    kind: "approval",
    turn,
    ord: nextOrd(current, turn),
    rev: 0,
    source: "acp",
    at,
    gen: GEN,
    pendingId: approval.pendingId,
    protocol: "acp",
    toolCallId: approval.toolCall.toolCallId,
    options: approval.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
    state: "pending",
  });
}

export function addElicitation(
  state: LegacyState,
  view: LegacyElicitation,
  at: number,
): LegacyState {
  const id = `el:${view.pendingId}`;
  if (state.timeline.items[id] !== undefined) return state;
  const turn = Math.max(state.turn, 0);
  const { elicitation } = view;
  return put(state, {
    id,
    kind: "elicitation",
    turn,
    ord: nextOrd(state, turn),
    rev: 0,
    source: "acp",
    at,
    gen: GEN,
    pendingId: view.pendingId,
    message: elicitation.message,
    mode: elicitation.mode,
    ...(elicitation.requestedSchema === undefined
      ? {}
      : { requestedSchema: JSON.stringify(elicitation.requestedSchema) }),
    ...(elicitation.url === undefined ? {} : { url: elicitation.url }),
    state: "pending",
  });
}

/** 答完或过期：审批 / 提问条目收成 `answered`（卡片随之收起）。 */
export function resolvePending(
  state: LegacyState,
  pendingId: string,
  next: "answered" | "cancelled" = "answered",
): LegacyState {
  let current = state;
  for (const id of [`ap:${pendingId}`, `el:${pendingId}`]) {
    const item = current.timeline.items[id];
    if (
      item !== undefined &&
      (item.kind === "approval" || item.kind === "elicitation") &&
      item.state === "pending"
    ) {
      current = put(current, { ...item, state: next });
    }
  }
  return current;
}

/** 以 `log.pending` / `log.elicitations` 为准：列表之外还挂着的收为 `cancelled`。 */
function syncPending(
  state: LegacyState,
  log: AcpLogResponse,
  at: number,
): LegacyState {
  if (log.pending === undefined && log.elicitations === undefined) return state;
  let current = state;
  const live = new Set([
    ...(log.pending ?? []).map((item) => item.pendingId),
    ...(log.elicitations ?? []).map((item) => item.pendingId),
  ]);
  for (const item of pendingItems(current)) {
    if (
      (item.kind === "approval" || item.kind === "elicitation") &&
      !live.has(item.pendingId)
    ) {
      current = resolvePending(current, item.pendingId, "cancelled");
    }
  }
  for (const item of log.pending ?? []) {
    current = addApproval(
      current,
      {
        pendingId: item.pendingId,
        toolCall: item.toolCall,
        options: item.options,
      },
      at,
    );
  }
  for (const item of log.elicitations ?? []) {
    current = addElicitation(
      current,
      { pendingId: item.pendingId, elicitation: item.elicitation },
      at,
    );
  }
  return current;
}

/* ------------------------------ 镜像重建 ------------------------------ */

type Block = AcpLogResponse["entries"][number]["blocks"][number];

function blockUpdates(role: "user" | "assistant", block: Block): unknown[] {
  switch (block.type) {
    case "text":
    case "image":
    case "resource_link":
      return [
        {
          sessionUpdate:
            role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: block,
        },
      ];
    case "tool_use":
      return block.id
        ? [
            {
              sessionUpdate: "tool_call",
              toolCallId: block.id,
              title: block.name,
              status: "in_progress",
              ...(block.kind === undefined ? {} : { kind: block.kind }),
              ...(block.input === undefined ? {} : { rawInput: block.input }),
              ...(block.locations === undefined
                ? {}
                : { locations: block.locations }),
            },
          ]
        : [];
    case "tool_result": {
      if (!block.id) return [];
      const diffs = (block.diffs ?? []).map((diff) => ({
        type: "diff",
        path: diff.path,
        oldText: diff.oldText ?? null,
        newText: diff.newText,
      }));
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: block.id,
          status: block.status === "failed" ? "failed" : "completed",
          ...(block.content === undefined ? {} : { rawOutput: block.content }),
          ...(diffs.length > 0 ? { content: diffs } : {}),
        },
      ];
    }
    default:
      return [];
  }
}

function headFromLog(log: AcpLogResponse): TimelineHead {
  const head: Record<string, unknown> = {};
  if (log.modes !== undefined) head.modes = log.modes;
  if (log.models !== undefined) head.models = log.models;
  const snapshot = log.snapshot;
  if (snapshot !== undefined) {
    head.usage = snapshot.usage;
    head.commands = snapshot.availableCommands;
    head.title = snapshot.title;
  }
  return head as TimelineHead;
}

/**
 * 这一句已经在镜像里：有回合记录时要记录里有它的 `clientTurnId`，并且镜像里最后
 * 一条用户消息就是这句话（记录说 core 收到了、镜像还没来得及写的，仍要补画）。
 */
function confirmedByLog(local: LocalPrompt, log: AcpLogResponse): boolean {
  if (
    log.turns !== undefined &&
    !log.turns.some((turn) => turn.clientTurnId === local.clientTurnId)
  ) {
    return false;
  }
  const lastUser = [...log.entries]
    .reverse()
    .find(
      (entry) =>
        entry.role === "user" &&
        entry.blocks.some((block) => block.type === "text"),
    );
  const text = lastUser?.blocks.find((block) => block.type === "text");
  return text?.type === "text" && text.text === local.text;
}

/**
 * 镜像（`acp.log`）→ 状态：整份重建（这条路径只服务旧主机，量不大）。活进程的
 * 计划、用量、命令、标题、审批与提问一并带上；回合是否还在跑看 `turns`。
 */
export function fromLog(
  log: AcpLogResponse,
  previous: LegacyState,
  now: number,
): LegacyState {
  let state: LegacyState = emptyLegacyState();
  const feed = (current: LegacyState, update: unknown, at: number) => {
    const ctx = ctxOf(current.turn, at, "replay");
    return {
      ...current,
      timeline: reduceAcpUpdate(current.timeline, update, ctx).state,
    };
  };
  for (const entry of log.entries) {
    if (entry.role === "system") continue;
    const role = entry.role;
    const at = Date.parse(entry.at ?? "") || now;
    const speaks = entry.blocks.some(
      (block) =>
        block.type === "text" ||
        block.type === "image" ||
        block.type === "resource_link",
    );
    // 只有工具结果的 user 记录（Claude 的转录这样存）不开新回合。
    if ((role === "user" && speaks) || state.turn === 0) {
      state = beginTurn(state, at, undefined, "replay");
    }
    for (const block of entry.blocks) {
      for (const update of blockUpdates(role, block)) {
        state = feed(state, update, at);
      }
    }
  }
  const records = log.turns ?? [];
  const running =
    records.some((turn) => turn.state !== "ended") ||
    (log.pending?.length ?? 0) > 0 ||
    (log.elicitations?.length ?? 0) > 0;
  // 镜像没有回合边界：最后一个回合只有活进程说它在跑才保持打开；已结束的按
  // 回合记录里的结局收尾（停止原因、错误）。
  if (state.open && !running) {
    const last = records.at(-1);
    state = endTurn(state, last === undefined ? {} : outcomeOf(last), now);
  }
  // 活进程的计划挂在最后一个回合。
  const plan = log.snapshot?.plan ?? [];
  if (plan.length > 0 && state.turn > 0) {
    state = feed(state, { sessionUpdate: "plan", entries: plan }, now);
  }
  const head = headFromLog(log);
  if (Object.keys(head).length > 0) {
    state = withOps(state, [{ seq: state.timeline.seq + 1, op: "head", head }]);
  }
  state = syncPending(state, log, now);
  // 镜像里还没有的本页提问：补回去（对账由调用方按 `turns` 做）。
  const locals: LocalPrompt[] = [];
  for (const local of previous.locals) {
    if (confirmedByLog(local, log)) continue;
    locals.push(local);
    state = beginTurn(state, now, local);
  }
  if (running && locals.length === 0 && !state.open && state.turn > 0) {
    state = { ...state, open: true };
  }
  return { ...state, locals };
}

/** 对账之后：某个提问已被镜像确认，不再需要补回。 */
export function confirmLocal(
  state: LegacyState,
  clientTurnId: string,
): LegacyState {
  return {
    ...state,
    locals: state.locals.filter((item) => item.clientTurnId !== clientTurnId),
  };
}

function outcomeOf(
  record: AcpTurnRecord,
): Pick<AcpTurnEvent, "stopReason" | "error"> {
  return {
    ...(record.stopReason === undefined
      ? {}
      : { stopReason: record.stopReason as AcpTurnEvent["stopReason"] }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

/* --------------------------------- 派生 --------------------------------- */

export function itemsOf(state: LegacyState): TimelineItem[] {
  return sortedTimelineItems(state.timeline);
}

/**
 * 旧路径没有 core 算的活动：从条目推一个够用的（阶段 + 当前工具名 + 起点）。
 * `rev` 随序号走，`bootId` 固定为 `legacy`。
 */
export function activityOf(state: LegacyState): SessionActivity | undefined {
  if (state.turn === 0 && !state.open) return undefined;
  const items = turnItems(state, state.turn);
  const rev = `legacy:${state.timeline.seq}`;
  const turnItem = items.find((item) => item.kind === "turn");
  const last = items.reduce<TimelineItem | undefined>(
    (found, item) =>
      found === undefined || item.at >= found.at ? item : found,
    undefined,
  );
  const since = last?.at ?? turnItem?.at ?? 0;
  if (!state.open) {
    const error = turnItem?.kind === "turn" ? turnItem.error : undefined;
    const stop = turnItem?.kind === "turn" ? turnItem.stopReason : undefined;
    return {
      phase: "idle",
      since,
      rev,
      ...(turnItem?.kind === "turn" && turnItem.endedAt !== undefined
        ? {
            lastOutcome: {
              kind: error
                ? ("failed" as const)
                : stop === "cancelled"
                  ? ("cancelled" as const)
                  : stop === "refusal"
                    ? ("refused" as const)
                    : stop === "max_tokens" || stop === "max_turn_requests"
                      ? ("limit" as const)
                      : ("done" as const),
              at: turnItem.endedAt,
              ...(error ? { error: error.message } : {}),
            },
          }
        : {}),
    };
  }
  const turnStartedAt = turnItem?.kind === "turn" ? turnItem.startedAt : since;
  const base = { since, rev, turnStartedAt } as const;
  const pending = items.find(
    (item) =>
      (item.kind === "approval" || item.kind === "elicitation") &&
      item.state === "pending",
  );
  if (pending !== undefined) {
    return {
      phase:
        pending.kind === "approval" ? "awaiting_approval" : "awaiting_input",
      ...base,
    };
  }
  const running = items.filter(
    (item): item is TimelineToolItem =>
      item.kind === "tool" && !isTerminalToolStatus(item.status),
  );
  if (running.length > 0) {
    const first = running[0] as TimelineToolItem;
    return {
      phase: "tool",
      ...base,
      detail: {
        label: first.title,
        toolKind: first.toolKind,
        count: running.length,
      },
    };
  }
  const tail = items
    .filter((item) => item.kind === "assistant" || item.kind === "thought")
    .at(-1);
  if (tail !== undefined && "streaming" in tail && tail.streaming) {
    return {
      phase: tail.kind === "thought" ? "thinking" : "responding",
      ...base,
    };
  }
  return { phase: items.length <= 2 ? "submitting" : "thinking", ...base };
}
