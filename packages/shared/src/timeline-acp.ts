import {
  type TimelineAssistantItem,
  type TimelineHead,
  type TimelineItem,
  type TimelineNoticeCode,
  type TimelineOp,
  type TimelinePart,
  type TimelineSource,
  type TimelineState,
  type TimelineThoughtItem,
  type TimelineToolContent,
  type TimelineToolInput,
  type TimelineToolItem,
  type TimelineToolKind,
  type TimelineToolStatus,
  type TimelineTurnItem,
  type TimelineUserItem,
  TIMELINE_TOOL_KINDS,
  TIMELINE_TOOL_STATUSES,
  applyTimelineOps,
  isTerminalToolStatus,
  mergeStreamChunk,
  mergeToolCall,
} from "./domain/index.js";

/**
 * ACP `session/update` → 时间线操作（设计 §2.3、§3）。core 的 `TimelineWriter`
 * 逐帧调用，页面的 reducer 共用同一份，所以两边对同一帧得到同一个结果。
 *
 * 用法约定：每次调用都从 `state.seq + 1` 起给操作编号，**调用方要先把返回的
 * 操作应用到状态上，再处理下一帧**（{@link reduceAcpUpdate} 帮你做这一步）。
 * 同一个刷写窗口里累积的操作，写库和发帧之前过一遍 `compactTimelineOps`。
 *
 * 帧里的 JSON 来自适配器，形状不可信：不认识的种类原样忽略，缺字段的块跳过，
 * 不抛错。
 */

/** 工具输出只留尾部这么多字节（设计 §3.2）。 */
export const TOOL_TEXT_TAIL_BYTES = 64 * 1024;
/** 单份 diff 超过这么多字节就只记路径与行数。 */
export const DIFF_MAX_BYTES = 1024 * 1024;

export interface BlobStored {
  readonly blobId: string;
  readonly bytes: number;
}

export interface AcpOpsContext {
  /** 这一帧属于哪个回合：回合 id 与回合序号（每条用户消息开一回合）。 */
  readonly turnId: string;
  readonly turn: number;
  /** 当前时间（毫秒）；由调用方给，保证重放可复现。 */
  readonly at: number;
  /** 驱动代次。 */
  readonly gen: number;
  /** 缺省 `acp`；第一次接管旧会话的回放写 `replay`。 */
  readonly source?: TimelineSource;
  /**
   * 把图片 / 音频 / blob 资源的 base64 存成 blob（设计 §3.2）。不给、返回
   * `null` 或超限时，部件只留 `dropped`，条目里永远不带 base64。
   */
  readonly storeBlob?: (blob: {
    readonly kind: "image" | "audio" | "resource";
    readonly mimeType: string;
    readonly data: string;
  }) => BlobStored | null;
}

/* ------------------------------ 小工具 ------------------------------ */

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Clipped {
  readonly text: string;
  readonly truncated?: true;
  readonly originalBytes?: number;
}

/** 只留尾部 `maxBytes` 字节（在字符边界上切）；没超限原样返回。 */
export function clipTail(
  text: string,
  maxBytes: number = TOOL_TEXT_TAIL_BYTES,
): Clipped {
  // UTF-8 一个码元最多 3 字节，长度够短的直接放行，免得编码一遍。
  if (text.length * 3 <= maxBytes) return { text };
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) {
    start++;
  }
  return {
    text: decoder.decode(bytes.subarray(start)),
    truncated: true,
    originalBytes: bytes.length,
  };
}

/** {@link clipTail} 的结果放进别的字段名下（文本之外的 `truncated` / `originalBytes` 照旧）。 */
function clipTailAs(
  field: "output",
  text: string,
): { output: string; truncated?: true; originalBytes?: number } {
  const { text: clipped, ...rest } = clipTail(text);
  return { [field]: clipped, ...rest } as {
    output: string;
    truncated?: true;
    originalBytes?: number;
  };
}

function lineCount(text: string | null | undefined): number {
  if (text === undefined || text === null || text === "") return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/* --------------------------- 内容块 → 部件 --------------------------- */

function storeFor(
  ctx: AcpOpsContext,
  kind: "image" | "audio" | "resource",
  mimeType: string,
  data: string | undefined,
): { blobId: string; bytes: number } | { dropped: true } {
  if (data === undefined || data === "" || ctx.storeBlob === undefined) {
    return { dropped: true };
  }
  const stored = ctx.storeBlob({ kind, mimeType, data });
  return stored === null
    ? { dropped: true }
    : { blobId: stored.blobId, bytes: stored.bytes };
}

/** 一个 ACP 内容块 → 助手消息的部件；不认识的块答 `null`。 */
export function partOfBlock(
  block: unknown,
  ctx: AcpOpsContext,
): TimelinePart | null {
  const b = obj(block);
  if (b === null) return null;
  switch (b.type) {
    case "text": {
      const text = str(b.text);
      return text === undefined ? null : { type: "text", text };
    }
    case "image": {
      const mimeType = str(b.mimeType) ?? "image/*";
      return {
        type: "image",
        mimeType,
        ...storeFor(ctx, "image", mimeType, str(b.data)),
      };
    }
    case "audio": {
      const mimeType = str(b.mimeType) ?? "audio/*";
      return {
        type: "audio",
        mimeType,
        ...storeFor(ctx, "audio", mimeType, str(b.data)),
      };
    }
    case "resource_link": {
      const uri = str(b.uri);
      if (uri === undefined) return null;
      const mimeType = str(b.mimeType);
      const title = str(b.title);
      return {
        type: "resource_link",
        uri,
        name: str(b.name) ?? uri,
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(title !== undefined ? { title } : {}),
      };
    }
    case "resource": {
      const resource = obj(b.resource);
      const uri = str(resource?.uri);
      if (resource === null || uri === undefined) return null;
      const mimeType = str(resource.mimeType);
      const text = str(resource.text);
      if (text !== undefined) {
        return {
          type: "resource",
          uri,
          text,
          ...(mimeType !== undefined ? { mimeType } : {}),
        };
      }
      return {
        type: "resource",
        uri,
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...storeFor(ctx, "resource", mimeType ?? "", str(resource.blob)),
      };
    }
    default:
      return null;
  }
}

/** 工具调用 `content[]` 里的一项 → 时间线的工具内容；不认识的答 `null`。 */
export function toolContentOf(
  entry: unknown,
  ctx: AcpOpsContext,
): TimelineToolContent | null {
  const e = obj(entry);
  if (e === null) return null;
  if (e.type === "diff") {
    const path = str(e.path);
    if (path === undefined) return null;
    const oldText = typeof e.oldText === "string" ? e.oldText : null;
    const newText = str(e.newText) ?? "";
    const bytes = (oldText?.length ?? 0) + newText.length;
    // 字符数乘 3 是字节数的上界；超过上限的再精确量一遍。
    if (
      bytes * 3 > DIFF_MAX_BYTES &&
      encoder.encode(newText).length +
        (oldText ? encoder.encode(oldText).length : 0) >
        DIFF_MAX_BYTES
    ) {
      return {
        type: "diff",
        path,
        truncated: true,
        addedLines: lineCount(newText),
        removedLines: lineCount(oldText),
      };
    }
    return { type: "diff", path, oldText, newText };
  }
  if (e.type === "terminal") {
    const terminalId = str(e.terminalId);
    if (terminalId === undefined) return null;
    // 宿主（core 的 `terminal/*` 实现）把输出尾部与退出码一并带在这条内容里；
    // Agent 自己发的只有 `terminalId`。输出过长只留尾部。
    const command = str(e.command);
    const output = str(e.output);
    const exitCode = e.exitCode;
    return {
      type: "terminal",
      terminalId,
      ...(command !== undefined ? { command: command.slice(0, 10_000) } : {}),
      ...(output !== undefined ? clipTailAs("output", output) : {}),
      ...(typeof exitCode === "number" && Number.isInteger(exitCode)
        ? { exitCode }
        : exitCode === null
          ? { exitCode: null }
          : {}),
    };
  }
  if (e.type === "content") {
    const part = partOfBlock(e.content, ctx);
    if (part === null) return null;
    switch (part.type) {
      case "text":
        return { type: "text", ...clipTail(part.text) };
      case "image":
        return part;
      case "resource_link":
        return {
          type: "resource",
          uri: part.uri,
          name: part.title ?? part.name,
          ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}),
        };
      case "resource": {
        if (part.text === undefined) return part;
        const { text, ...rest } = part;
        return { ...rest, ...clipTail(text) };
      }
      default:
        return null;
    }
  }
  return null;
}

/** 没有 `content` 时，从 `rawOutput` 里捞一段能读的文本（对象只认常见的文本字段）。 */
function rawOutputText(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw === "" ? undefined : raw;
  const o = obj(raw);
  if (o === null) return undefined;
  for (const key of ["output", "stdout", "text", "content", "result"]) {
    const value = o[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/* --------------------------- 工具入参摘要 --------------------------- */

const COMMAND_KEYS = ["command", "cmd"];
const PATH_KEYS = ["file_path", "filePath", "path", "file", "notebook_path"];
const QUERY_KEYS = ["query", "pattern", "q", "search"];
const URL_KEYS = ["url", "uri"];

function firstString(o: Json, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = o[key];
    if (typeof value === "string" && value !== "") return value;
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((part) => typeof part === "string")
    ) {
      return (value as string[]).join(" ");
    }
  }
  return undefined;
}

/**
 * `rawInput` → 结构化摘要（设计 §3.2）：命令、路径与行号、查询、URL 取出来，
 * 其余标量折成最多 12 个键值，值截到 400 字；不贴 JSON 原文。拿不到任何信息
 * 时答 `undefined`。
 */
export function toolInputSummary(
  rawInput: unknown,
): TimelineToolInput | undefined {
  if (typeof rawInput === "string") {
    return rawInput === "" ? undefined : { command: rawInput.slice(0, 10_000) };
  }
  const o = obj(rawInput);
  if (o === null) return undefined;
  const used = new Set<string>();
  const take = (keys: readonly string[]): string | undefined => {
    const value = firstString(o, keys);
    if (value !== undefined) for (const key of keys) used.add(key);
    return value;
  };
  const command = take(COMMAND_KEYS);
  const path = take(PATH_KEYS);
  const query = take(QUERY_KEYS);
  const url = take(URL_KEYS);
  const lineValue = o.line ?? o.offset;
  const line =
    typeof lineValue === "number" && Number.isInteger(lineValue)
      ? lineValue
      : undefined;
  if (line !== undefined) {
    used.add("line");
    used.add("offset");
  }
  const fields: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(o)) {
    if (used.has(key) || fields.length >= 12) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      fields.push({
        key: key.slice(0, 100),
        value: String(value).slice(0, 400),
      });
    }
  }
  const summary: TimelineToolInput = {
    ...(command !== undefined ? { command: command.slice(0, 10_000) } : {}),
    ...(path !== undefined ? { path: path.slice(0, 4_000) } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(query !== undefined ? { query: query.slice(0, 2_000) } : {}),
    ...(url !== undefined ? { url: url.slice(0, 4_000) } : {}),
    ...(fields.length > 0 ? { fields } : {}),
  };
  return Object.keys(summary).length === 0 ? undefined : summary;
}

/* ----------------------------- 状态查询 ----------------------------- */

function turnItems(state: TimelineState, turn: number): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const item of Object.values(state.items)) {
    if (item.turn === turn) out.push(item);
  }
  return out;
}

/** 回合里的下一个序（回合条目占 0，其余从 1 起）。 */
function nextOrd(items: readonly TimelineItem[]): number {
  let max = 0;
  for (const item of items) if (item.ord > max) max = item.ord;
  return max + 1;
}

/** 回合里最后一个正文条目（不含回合条目本身）。 */
function lastItem(items: readonly TimelineItem[]): TimelineItem | undefined {
  let last: TimelineItem | undefined;
  for (const item of items) {
    if (item.kind === "turn") continue;
    if (last === undefined || item.ord > last.ord) last = item;
  }
  return last;
}

function isStreaming(
  item: TimelineItem | undefined,
): item is TimelineAssistantItem | TimelineThoughtItem {
  return (
    item !== undefined &&
    (item.kind === "assistant" || item.kind === "thought") &&
    item.streaming
  );
}

/** 给操作编号并累积；`seq` 从状态之后接着数。 */
class Emitter {
  readonly ops: TimelineOp[] = [];
  private seq: number;
  constructor(state: TimelineState) {
    this.seq = state.seq;
  }
  next(): number {
    return this.seq + 1;
  }
  put(item: TimelineItem): void {
    this.ops.push({ seq: ++this.seq, op: "put", item });
  }
  append(itemId: string, text: string): void {
    this.ops.push({
      seq: ++this.seq,
      op: "append",
      itemId,
      delta: { text },
    });
  }
  head(head: TimelineHead): void {
    this.ops.push({ seq: ++this.seq, op: "head", head });
  }
}

function base(ctx: AcpOpsContext, id: string, ord: number) {
  return {
    id,
    turn: ctx.turn,
    ord,
    rev: 0,
    source: ctx.source ?? "acp",
    at: ctx.at,
    gen: ctx.gen,
  } as const;
}

function closeStreaming(
  item: TimelineAssistantItem | TimelineThoughtItem,
  at: number,
  out: Emitter,
): void {
  out.put(
    item.kind === "thought"
      ? { ...item, streaming: false, durationMs: Math.max(0, at - item.at) }
      : { ...item, streaming: false },
  );
}

/* --------------------------- session/update --------------------------- */

/**
 * 一条 `session/update` → 操作。返回的操作从 `state.seq + 1` 起编号，
 * 空数组表示这一帧不改变时间线（不认识、重复、没有实质变化）。
 */
export function acpUpdateToOps(
  state: TimelineState,
  update: unknown,
  ctx: AcpOpsContext,
): TimelineOp[] {
  const body = obj(update);
  if (body === null) return [];
  const out = new Emitter(state);
  switch (body.sessionUpdate) {
    case "user_message_chunk":
      userChunk(state, body, ctx, out);
      break;
    case "agent_message_chunk":
      streamChunk(state, "assistant", body, ctx, out);
      break;
    case "agent_thought_chunk":
      streamChunk(state, "thought", body, ctx, out);
      break;
    case "tool_call":
    case "tool_call_update":
      toolUpdate(state, body, ctx, out);
      break;
    case "plan":
      planUpdate(state, body, ctx, out);
      break;
    case "current_mode_update":
      modeUpdate(state, body, ctx, out);
      break;
    case "config_option_update":
      configUpdate(state, body, ctx, out);
      break;
    case "usage_update":
      usageUpdate(state, body, out);
      break;
    case "available_commands_update":
      commandsUpdate(state, body, out);
      break;
    case "session_info_update":
      titleUpdate(state, body, out);
      break;
    default:
      break;
  }
  return out.ops;
}

/** 应用一帧并把操作一并交出来：core 的写入器与页面的归约都走它。 */
export function reduceAcpUpdate(
  state: TimelineState,
  update: unknown,
  ctx: AcpOpsContext,
): { state: TimelineState; ops: TimelineOp[] } {
  const ops = acpUpdateToOps(state, update, ctx);
  return { state: applyTimelineOps(state, ops).state, ops };
}

function userChunk(
  state: TimelineState,
  body: Json,
  ctx: AcpOpsContext,
  out: Emitter,
): void {
  const part = partOfBlock(body.content, ctx);
  if (part === null) return;
  const id = `u:${ctx.turnId}`;
  const existing = state.items[id];
  if (existing !== undefined && existing.kind !== "user") return;
  if (part.type === "text") {
    if (existing === undefined) {
      out.put({
        ...base(ctx, id, nextOrd(turnItems(state, ctx.turn))),
        kind: "user",
        text: part.text,
      });
      return;
    }
    // 页面先画上的那一句、适配器回显的同一句：重复不再追加。
    const merged = mergeStreamChunk(existing.text, part.text);
    if (merged.mode === "append") out.append(id, part.text);
    else if (merged.mode === "snapshot")
      out.put({ ...existing, text: merged.text });
    return;
  }
  const attachment =
    part.type === "image"
      ? ({
          kind: "image",
          mimeType: part.mimeType,
          ...(part.blobId !== undefined ? { blobId: part.blobId } : {}),
          ...(part.bytes !== undefined ? { bytes: part.bytes } : {}),
        } as const)
      : part.type === "resource_link"
        ? ({
            kind: "file",
            name: part.name,
            uri: part.uri,
            ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}),
          } as const)
        : part.type === "resource"
          ? ({
              kind: "file",
              uri: part.uri,
              ...(part.name !== undefined ? { name: part.name } : {}),
              ...(part.mimeType !== undefined
                ? { mimeType: part.mimeType }
                : {}),
              ...(part.blobId !== undefined ? { blobId: part.blobId } : {}),
              ...(part.bytes !== undefined ? { bytes: part.bytes } : {}),
            } as const)
          : null;
  if (attachment === null) return;
  const user: TimelineUserItem =
    existing?.kind === "user"
      ? existing
      : {
          ...base(ctx, id, nextOrd(turnItems(state, ctx.turn))),
          kind: "user",
          text: "",
        };
  out.put({ ...user, attachments: [...(user.attachments ?? []), attachment] });
}

function streamChunk(
  state: TimelineState,
  kind: "assistant" | "thought",
  body: Json,
  ctx: AcpOpsContext,
  out: Emitter,
): void {
  const part = partOfBlock(body.content, ctx);
  if (part === null) return;
  if (kind === "thought" && part.type !== "text") return;
  const items = turnItems(state, ctx.turn);
  const tail = lastItem(items);
  const open = isStreaming(tail) && tail.kind === kind ? tail : undefined;

  if (open === undefined) {
    if (isStreaming(tail)) closeStreaming(tail, ctx.at, out);
    const prefix = kind === "assistant" ? "a" : "th";
    let n = items.filter((item) => item.kind === kind).length + 1;
    while (state.items[`${prefix}:${ctx.turn}:${n}`] !== undefined) n++;
    const id = `${prefix}:${ctx.turn}:${n}`;
    const ord = nextOrd(items);
    if (kind === "thought" && part.type === "text") {
      out.put({
        ...base(ctx, id, ord),
        kind: "thought",
        text: part.text,
        streaming: true,
      });
    } else {
      out.put({
        ...base(ctx, id, ord),
        kind: "assistant",
        parts: [part],
        streaming: true,
      });
    }
    return;
  }

  if (open.kind === "thought") {
    if (part.type !== "text") return;
    const merged = mergeStreamChunk(open.text, part.text);
    if (merged.mode === "append") out.append(open.id, part.text);
    else if (merged.mode === "snapshot")
      out.put({ ...open, text: merged.text });
    return;
  }
  if (open.kind !== "assistant") return;
  const last = open.parts[open.parts.length - 1];
  if (part.type === "text" && last?.type === "text") {
    const merged = mergeStreamChunk(last.text, part.text);
    if (merged.mode === "append") {
      out.append(open.id, part.text);
    } else if (merged.mode === "snapshot") {
      const parts = open.parts.slice();
      parts[parts.length - 1] = { type: "text", text: merged.text };
      out.put({ ...open, parts });
    }
    return;
  }
  out.put({ ...open, parts: [...open.parts, part] });
}

const KINDS: ReadonlySet<string> = new Set(TIMELINE_TOOL_KINDS);
const STATUSES: ReadonlySet<string> = new Set(TIMELINE_TOOL_STATUSES);

function subagentInfo(body: Json): {
  isSubagent: boolean;
  parent: string | undefined;
} {
  const meta = obj(body._meta);
  const claude = obj(meta?.claudeCode);
  const name = str(claude?.toolName);
  return {
    isSubagent: name === "Task" || name === "Agent",
    parent: str(claude?.parentToolUseId),
  };
}

function toolUpdate(
  state: TimelineState,
  body: Json,
  ctx: AcpOpsContext,
  out: Emitter,
): void {
  const toolCallId = str(body.toolCallId);
  if (toolCallId === undefined || toolCallId === "") return;
  const id = `tool:${toolCallId}`;
  const found = state.items[id];
  const existing = found?.kind === "tool" ? found : undefined;
  if (found !== undefined && existing === undefined) return;

  const rawKind = str(body.kind);
  const sub = subagentInfo(body);
  const toolKind: TimelineToolKind | undefined = sub.isSubagent
    ? "subagent"
    : rawKind === undefined
      ? undefined
      : KINDS.has(rawKind)
        ? (rawKind as TimelineToolKind)
        : "other";
  const rawStatus = str(body.status);
  const status = STATUSES.has(rawStatus ?? "")
    ? (rawStatus as TimelineToolStatus)
    : undefined;
  const locations = Array.isArray(body.locations)
    ? body.locations.flatMap((entry) => {
        const o = obj(entry);
        const path = str(o?.path);
        if (o === null || path === undefined) return [];
        return [
          {
            path,
            ...(typeof o.line === "number" ? { line: o.line } : {}),
          },
        ];
      })
    : undefined;
  let content: TimelineToolContent[] | undefined = Array.isArray(body.content)
    ? body.content.flatMap((entry) => {
        const converted = toolContentOf(entry, ctx);
        return converted === null ? [] : [converted];
      })
    : undefined;
  if (content === undefined || content.length === 0) {
    const text = rawOutputText(body.rawOutput);
    if (text !== undefined) content = [{ type: "text", ...clipTail(text) }];
  }
  const input =
    body.rawInput !== undefined ? toolInputSummary(body.rawInput) : undefined;
  const title = str(body.title);

  const tail = lastItem(turnItems(state, ctx.turn));
  const ord = existing?.ord ?? nextOrd(turnItems(state, ctx.turn));
  const fields = mergeToolCall(
    existing,
    {
      toolKind,
      title,
      status,
      locations,
      input,
      content,
      parentToolCallId: sub.parent,
    },
    ctx.at,
  );
  const item: TimelineToolItem = {
    ...(existing ?? base(ctx, id, ord)),
    ...fields,
    kind: "tool",
    toolCallId,
  };
  if (existing !== undefined && sameItem(existing, item)) return;
  // 新工具打断了流式的文本或思考：先把它们收尾。
  if (existing === undefined && isStreaming(tail)) {
    closeStreaming(tail, ctx.at, out);
  }
  out.put(item);
}

function sameItem(a: TimelineItem, b: TimelineItem): boolean {
  // `rev` 随每次写入变化，不参与比较。
  return JSON.stringify({ ...a, rev: 0 }) === JSON.stringify({ ...b, rev: 0 });
}

function planUpdate(
  state: TimelineState,
  body: Json,
  ctx: AcpOpsContext,
  out: Emitter,
): void {
  if (!Array.isArray(body.entries)) return;
  const entries = body.entries.flatMap((entry) => {
    const o = obj(entry);
    const content = str(o?.content);
    if (o === null || content === undefined) return [];
    const status = str(o.status);
    const priority = str(o.priority);
    return [
      {
        content,
        ...(status !== undefined ? { status } : {}),
        ...(priority !== undefined ? { priority } : {}),
      },
    ];
  });
  const id = `plan:${ctx.turn}`;
  const existing = state.items[id];
  const item: TimelineItem =
    existing?.kind === "plan"
      ? { ...existing, entries }
      : {
          ...base(ctx, id, nextOrd(turnItems(state, ctx.turn))),
          kind: "plan",
          entries,
        };
  if (existing !== undefined && sameItem(existing, item)) return;
  out.put(item);
}

function notice(
  state: TimelineState,
  ctx: AcpOpsContext,
  out: Emitter,
  code: TimelineNoticeCode,
  params: Record<string, string | number | boolean | null>,
): void {
  const seq = out.next();
  out.put({
    ...base(
      ctx,
      `n:${ctx.turn}:${code}:${seq}`,
      nextOrd(turnItems(state, ctx.turn)),
    ),
    kind: "notice",
    code,
    params,
  });
}

/** 写一条提示（驱动切换、休眠、退出、出错…）；`n:<turn>:<code>:<seq>`。 */
export function timelineNoticeOps(
  state: TimelineState,
  ctx: AcpOpsContext,
  code: TimelineNoticeCode,
  params: Record<string, string | number | boolean | null> = {},
): TimelineOp[] {
  const out = new Emitter(state);
  notice(state, ctx, out, code, params);
  return out.ops;
}

function modeUpdate(
  state: TimelineState,
  body: Json,
  ctx: AcpOpsContext,
  out: Emitter,
): void {
  const modeId = str(body.currentModeId);
  const modes = state.head.modes;
  if (modeId === undefined || !modes || modes.currentModeId === modeId) return;
  const name =
    modes.availableModes.find((mode) => mode.id === modeId)?.name ?? modeId;
  out.head({ modes: { ...modes, currentModeId: modeId } });
  notice(state, ctx, out, "mode_changed", { modeId, name });
}

/**
 * `config_option_update` 的配置项 → 模型目录：`category: "model"`（没有分类时
 * id 为 `model`），分组摊平。认不出模型项时答 `null`。
 */
export function modelCatalogOf(configOptions: unknown): {
  currentModelId: string;
  availableModels: { modelId: string; name: string; description?: string }[];
} | null {
  if (!Array.isArray(configOptions)) return null;
  const options = configOptions.flatMap((entry) => {
    const o = obj(entry);
    return o !== null && typeof o.id === "string" && Array.isArray(o.options)
      ? [o]
      : [];
  });
  const option =
    options.find((o) => o.category === "model") ??
    options.find((o) => (o.category ?? null) === null && o.id === "model");
  if (option === undefined) return null;
  const models: { modelId: string; name: string; description?: string }[] = [];
  const walk = (list: readonly unknown[]): void => {
    for (const entry of list) {
      const o = obj(entry);
      if (o === null) continue;
      if (Array.isArray(o.options)) {
        walk(o.options);
        continue;
      }
      const value = str(o.value);
      if (value === undefined || models.some((m) => m.modelId === value)) {
        continue;
      }
      const description = str(o.description);
      models.push({
        modelId: value,
        name: str(o.name) ?? value,
        ...(description ? { description } : {}),
      });
    }
  };
  walk(option.options as unknown[]);
  const first = models[0];
  if (first === undefined) return null;
  const current = str(option.currentValue);
  return {
    currentModelId:
      current !== undefined && models.some((m) => m.modelId === current)
        ? current
        : first.modelId,
    availableModels: models,
  };
}

function configUpdate(
  state: TimelineState,
  body: Json,
  ctx: AcpOpsContext,
  out: Emitter,
): void {
  // 已经有目录时才跟：没有改模型的路，就不画选择器。
  const previous = state.head.models;
  if (!previous) return;
  const models = modelCatalogOf(body.configOptions);
  if (models === null || JSON.stringify(models) === JSON.stringify(previous)) {
    return;
  }
  out.head({ models });
  if (models.currentModelId !== previous.currentModelId) {
    const name =
      models.availableModels.find((m) => m.modelId === models.currentModelId)
        ?.name ?? models.currentModelId;
    notice(state, ctx, out, "model_changed", {
      modelId: models.currentModelId,
      name,
    });
  }
}

function usageUpdate(state: TimelineState, body: Json, out: Emitter): void {
  const used = body.used;
  const size = body.size;
  if (typeof used !== "number" || typeof size !== "number") return;
  const cost = obj(body.cost);
  const amount = cost?.amount;
  const currency = str(cost?.currency);
  const usage = {
    used: Math.max(0, Math.trunc(used)),
    size: Math.max(0, Math.trunc(size)),
    ...(typeof amount === "number" && currency !== undefined
      ? { cost: { amount, currency } }
      : {}),
  };
  if (JSON.stringify(usage) === JSON.stringify(state.head.usage)) return;
  out.head({ usage });
}

function commandsUpdate(state: TimelineState, body: Json, out: Emitter): void {
  if (!Array.isArray(body.availableCommands)) return;
  const commands = body.availableCommands.flatMap((entry) => {
    const o = obj(entry);
    const name = str(o?.name);
    return o === null || name === undefined || name === ""
      ? []
      : [{ name, description: str(o.description) ?? "" }];
  });
  if (JSON.stringify(commands) === JSON.stringify(state.head.commands)) return;
  out.head({ commands });
}

function titleUpdate(state: TimelineState, body: Json, out: Emitter): void {
  let title: string | null;
  if (typeof body.title === "string")
    title = body.title === "" ? null : body.title;
  else if (body.title === null) title = null;
  else return;
  if (title === (state.head.title ?? null) && state.head.title !== undefined) {
    return;
  }
  out.head({ title });
}

/* --------------------------------- 回合 --------------------------------- */

export interface AcpPrompt {
  readonly text: string;
  readonly attachments?: TimelineUserItem["attachments"];
  readonly author?: string;
  readonly clientTurnId?: string;
}

/**
 * 回合开始：回合条目（序 0）与用户消息（`u:<turnId>`）。同一个回合重复调用
 * 不产生操作（重发的提示答同一个回合）。
 */
export function acpTurnBeginOps(
  state: TimelineState,
  ctx: AcpOpsContext,
  prompt?: AcpPrompt,
): TimelineOp[] {
  const out = new Emitter(state);
  const turnId = `turn:${ctx.turnId}`;
  if (state.items[turnId] === undefined) {
    const turnItem: TimelineTurnItem = {
      ...base(ctx, turnId, 0),
      kind: "turn",
      turnId: ctx.turnId,
      startedAt: ctx.at,
      permissionWaitMs: 0,
    };
    out.put(turnItem);
  }
  const userId = `u:${ctx.turnId}`;
  if (prompt !== undefined && state.items[userId] === undefined) {
    out.put({
      ...base(ctx, userId, 1),
      kind: "user",
      text: prompt.text,
      ...(prompt.attachments !== undefined && prompt.attachments.length > 0
        ? { attachments: [...prompt.attachments] }
        : {}),
      ...(prompt.author !== undefined ? { author: prompt.author } : {}),
      ...(prompt.clientTurnId !== undefined
        ? { clientTurnId: prompt.clientTurnId }
        : {}),
    });
  }
  return out.ops;
}

export interface AcpTurnEnd {
  readonly stopReason?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly usage?: { readonly used: number; readonly size: number };
  /** 回合里累计等审批的毫秒数；不给就保持原值。 */
  readonly permissionWaitMs?: number;
}

/**
 * 回合结束：流式的文本与思考收尾，被打断或出错时还没结束的工具记 `cancelled`，
 * 回合条目写 `endedAt`、停止原因与错误。已经结束的回合重复调用不产生操作。
 */
export function acpTurnEndOps(
  state: TimelineState,
  ctx: AcpOpsContext,
  end: AcpTurnEnd = {},
): TimelineOp[] {
  const out = new Emitter(state);
  const items = turnItems(state, ctx.turn);
  const found = state.items[`turn:${ctx.turnId}`];
  const turnItem = found?.kind === "turn" ? found : undefined;
  if (turnItem?.endedAt !== undefined) return [];
  const aborted = end.stopReason === "cancelled" || end.error !== undefined;
  for (const item of items.sort((a, b) => a.ord - b.ord)) {
    if (isStreaming(item)) closeStreaming(item, ctx.at, out);
    else if (
      aborted &&
      item.kind === "tool" &&
      !isTerminalToolStatus(item.status)
    ) {
      out.put({ ...item, status: "cancelled", endedAt: ctx.at });
    } else if (item.kind === "approval" && item.state === "pending") {
      out.put({ ...item, state: "cancelled" });
    }
  }
  const closed: TimelineTurnItem = {
    ...(turnItem ?? {
      ...base(ctx, `turn:${ctx.turnId}`, 0),
      kind: "turn" as const,
      turnId: ctx.turnId,
      startedAt: ctx.at,
      permissionWaitMs: 0,
    }),
    endedAt: ctx.at,
    ...(end.stopReason !== undefined ? { stopReason: end.stopReason } : {}),
    ...(end.error !== undefined ? { error: end.error } : {}),
    ...(end.usage !== undefined ? { usage: end.usage } : {}),
    ...(end.permissionWaitMs !== undefined
      ? { permissionWaitMs: end.permissionWaitMs }
      : {}),
  };
  out.put(closed);
  return out.ops;
}
