import { closeSync, openSync, readSync, statSync } from "node:fs";

import type { TimelineItem } from "@armadra/shared";

import type { Block, EntryRange, TranscriptEntry } from "./types";

/**
 * ACP 会话的转录：派生给上下文读取、摘要、交接用（会话时间线设计 §10，B10）。
 *
 * core 以 ACP 驱动一个节点时，会话内容只写进会话时间线（契约 §82）。CLI 自己的
 * 转录对不上 ACP 会话 id 时（Copilot，SSH 节点，或者还没落盘的新会话），节点的
 * `transcriptPath` 仍指向 `<数据目录>/acp/<nodeId>/<sessionId>.acp.jsonl`，于是
 * 连线读取、摘要、交接这些吃 `TranscriptEntry` 的读取方不必知道会话是哪种驱动起
 * 的——`history/registry.ts` 在适配器之前先认这个后缀：
 *
 *   * 时间线有内容：由 {@link entriesFromTimeline} 从时间线条目派生，游标是记录序号；
 *   * 时间线为空（升级前的会话）：按文件读旧镜像，游标是字节偏移。
 *
 * 旧镜像一行一条记录：`{ role, blocks, at }`，`blocks` 与 `TranscriptEntry` 同形。
 * 助手的回复是逐块写下的，读的时候把相邻的纯文本助手行并成一条——一次回复在
 * 读取方眼里仍是一条记录。core 不再写这份文件。
 */

export const ACP_MIRROR_SUFFIX = ".acp.jsonl";

/** 这个路径是不是一份 ACP 镜像。 */
export function isAcpMirror(path: string | undefined): boolean {
  return path !== undefined && path.endsWith(ACP_MIRROR_SUFFIX);
}

/** 工具结果附带的文件差异（契约 §49）：整份保留，不随正文截断。 */
export interface MirrorDiff {
  readonly path: string;
  readonly oldText?: string | null;
  readonly newText: string;
}

/**
 * 只有会话视图（`…/log`）读的块（契约 §49）：图片、资源链接，以及带差异的工具
 * 结果。连线读取、摘要、渲染这些吃 {@link Block} 的读取方看不到它们——一张
 * base64 图片不该进别人的上下文。
 */
export type MirrorMediaBlock =
  | {
      readonly type: "image";
      readonly mimeType: string;
      /** base64；超过上限时不记，`dropped` 为真。 */
      readonly data?: string;
      readonly dropped?: true;
    }
  | {
      readonly type: "resource_link";
      readonly uri: string;
      readonly name: string;
      readonly mimeType?: string;
      readonly title?: string;
    };

/** 工具调用涉及的文件（契约 §49）。 */
export interface MirrorLocation {
  readonly path: string;
  readonly line?: number;
}

export type MirrorBlock =
  | Block
  | MirrorMediaBlock
  | (Extract<Block, { type: "tool_use" }> & {
      readonly kind?: string;
      readonly locations?: readonly MirrorLocation[];
    })
  | (Extract<Block, { type: "tool_result" }> & {
      readonly status?: "failed";
      readonly diffs?: readonly MirrorDiff[];
    });

/** 会话视图读到的一条记录：块里可以有 {@link MirrorMediaBlock}。 */
export type MirrorEntry = Omit<TranscriptEntry, "blocks"> & {
  readonly blocks: readonly MirrorBlock[];
};

/** 一行镜像记录（写入与读取同一个形状）。 */
export interface MirrorRecord {
  readonly role: "user" | "assistant";
  readonly blocks: readonly MirrorBlock[];
  readonly at?: string;
}

/** 读镜像的选项：`rich` 时连 {@link MirrorMediaBlock} 与差异一起读。 */
export interface MirrorReadOptions {
  readonly rich?: boolean;
}

const ROLES = new Set(["user", "assistant"]);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function diffsOf(value: unknown): MirrorDiff[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const diffs: MirrorDiff[] = [];
  for (const item of value) {
    const raw = item as Record<string, unknown> | null;
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof raw.path !== "string" ||
      typeof raw.newText !== "string"
    ) {
      continue;
    }
    diffs.push({
      path: raw.path,
      ...(typeof raw.oldText === "string" ? { oldText: raw.oldText } : {}),
      newText: raw.newText,
    });
  }
  return diffs.length > 0 ? diffs : undefined;
}

function locationsOf(value: unknown): MirrorLocation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations: MirrorLocation[] = [];
  for (const item of value) {
    const raw = item as { path?: unknown; line?: unknown } | null;
    if (typeof raw?.path !== "string" || raw.path === "") continue;
    locations.push({
      path: raw.path,
      ...(typeof raw.line === "number" ? { line: raw.line } : {}),
    });
  }
  return locations.length > 0 ? locations : undefined;
}

function mediaOf(raw: Record<string, unknown>): MirrorMediaBlock | undefined {
  if (raw.type === "image") {
    const mimeType = optionalString(raw.mimeType);
    if (mimeType === undefined) return undefined;
    if (typeof raw.data === "string") {
      return { type: "image", mimeType, data: raw.data };
    }
    return raw.dropped === true
      ? { type: "image", mimeType, dropped: true }
      : undefined;
  }
  if (raw.type === "resource_link") {
    const uri = optionalString(raw.uri);
    if (uri === undefined) return undefined;
    const mimeType = optionalString(raw.mimeType);
    const title = optionalString(raw.title);
    return {
      type: "resource_link",
      uri,
      name: optionalString(raw.name) ?? uri,
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(title === undefined ? {} : { title }),
    };
  }
  return undefined;
}

function blockOf(value: unknown, rich = false): MirrorBlock | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (rich && (raw.type === "image" || raw.type === "resource_link")) {
    return mediaOf(raw);
  }
  switch (raw.type) {
    case "text":
      return typeof raw.text === "string"
        ? { type: "text", text: raw.text }
        : undefined;
    case "tool_use": {
      if (typeof raw.name !== "string") return undefined;
      const kind = rich ? optionalString(raw.kind) : undefined;
      const locations = rich ? locationsOf(raw.locations) : undefined;
      return {
        type: "tool_use",
        name: raw.name,
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        ...(raw.input === undefined ? {} : { input: raw.input }),
        ...(kind === undefined ? {} : { kind }),
        ...(locations === undefined ? {} : { locations }),
      };
    }
    case "tool_result": {
      const diffs = rich ? diffsOf(raw.diffs) : undefined;
      return {
        type: "tool_result",
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
        ...(raw.content === undefined ? {} : { content: raw.content }),
        ...(rich && raw.status === "failed"
          ? { status: "failed" as const }
          : {}),
        ...(diffs === undefined ? {} : { diffs }),
      };
    }
    default:
      return undefined;
  }
}

/** 一行文本 → 一条记录；认不出来的行跳过（半行、别人写进来的东西）。 */
export function parseMirrorLine(
  line: string,
  endOffset: number,
): TranscriptEntry | undefined;
export function parseMirrorLine(
  line: string,
  endOffset: number,
  options: MirrorReadOptions,
): MirrorEntry | undefined;
export function parseMirrorLine(
  line: string,
  endOffset: number,
  options: MirrorReadOptions = {},
): MirrorEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.role !== "string" || !ROLES.has(raw.role)) return undefined;
  if (!Array.isArray(raw.blocks)) return undefined;
  const blocks = raw.blocks
    .map((block) => blockOf(block, options.rich === true))
    .filter((block): block is MirrorBlock => block !== undefined);
  if (blocks.length === 0) return undefined;
  return {
    role: raw.role as "user" | "assistant",
    blocks,
    endOffset,
    ...(typeof raw.at === "string" ? { at: raw.at } : {}),
  };
}

function textOnly(entry: MirrorEntry): boolean {
  return entry.blocks.every((block) => block.type === "text");
}

/**
 * 相邻的纯文本助手记录并成一条：逐块写下的一次回复读回来是一段话。偏移取后
 * 一条的，增量读取从合并之后接着读。
 */
export function coalesce<E extends MirrorEntry>(entries: readonly E[]): E[] {
  const out: E[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (
      last !== undefined &&
      last.role === "assistant" &&
      entry.role === "assistant" &&
      textOnly(last) &&
      textOnly(entry)
    ) {
      const text =
        last.blocks.map((block) => (block as { text: string }).text).join("") +
        entry.blocks.map((block) => (block as { text: string }).text).join("");
      out[out.length - 1] = {
        role: "assistant",
        blocks: [{ type: "text", text }],
        endOffset: entry.endOffset,
        ...(last.at === undefined ? {} : { at: last.at }),
      } as unknown as E;
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** 文件的字节数；不存在答 0。 */
export function mirrorSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * 从 `fromOffset` 起读最多 `maxBytes` 字节的完整行。`fromOffset` 落在行中间
 * （调用方给的不是记录边界）时跳过那半行。文件不在答空。
 */
export function readMirrorEntries(
  path: string,
  fromOffset: number,
  maxBytes: number,
): EntryRange;
export function readMirrorEntries(
  path: string,
  fromOffset: number,
  maxBytes: number,
  options: MirrorReadOptions,
): Omit<EntryRange, "entries"> & { readonly entries: readonly MirrorEntry[] };
export function readMirrorEntries(
  path: string,
  fromOffset: number,
  maxBytes: number,
  options: MirrorReadOptions = {},
): Omit<EntryRange, "entries"> & { readonly entries: readonly MirrorEntry[] } {
  const size = mirrorSize(path);
  const start = fromOffset < 0 || fromOffset > size ? 0 : fromOffset;
  if (size === 0 || start >= size) {
    return { entries: [], startOffset: start, endOffset: size };
  }
  const length = Math.min(size - start, Math.max(0, maxBytes));
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    while (read < length) {
      const got = readSync(fd, buffer, read, length - read, start + read);
      if (got === 0) break;
      read += got;
    }
  } finally {
    closeSync(fd);
  }
  let cursor = 0;
  // 不在行首：前一个字节不是换行就跳过半行。
  if (start > 0) {
    const previous = Buffer.alloc(1);
    const probe = openSync(path, "r");
    try {
      readSync(probe, previous, 0, 1, start - 1);
    } finally {
      closeSync(probe);
    }
    if (previous[0] !== 0x0a) {
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        return { entries: [], startOffset: start, endOffset: start };
      }
      cursor = newline + 1;
    }
  }
  const startOffset = start + cursor;
  const entries: MirrorEntry[] = [];
  let consumed = cursor;
  while (cursor < read) {
    const newline = buffer.indexOf(0x0a, cursor);
    // 最后半行（还在写、或被 maxBytes 截断）留给下一次。
    if (newline === -1 || newline >= read) break;
    const line = buffer.subarray(cursor, newline).toString("utf8");
    const entry = parseMirrorLine(line, start + newline + 1, options);
    if (entry !== undefined) entries.push(entry);
    cursor = newline + 1;
    consumed = cursor;
  }
  return {
    entries: coalesce(entries),
    startOffset,
    endOffset: start + consumed,
  };
}

/** 一条工具结果在派生记录里最多占这么多字符：整份文件的 diff 不该撑大转录。 */
const RESULT_LIMIT = 8_000;

function toolResultOf(item: Extract<TimelineItem, { kind: "tool" }>): string {
  const texts: string[] = [];
  for (const content of item.content) {
    if (content.type === "text" && content.text !== "") {
      texts.push(content.text);
    } else if (
      content.type === "terminal" &&
      content.output !== undefined &&
      content.output !== ""
    ) {
      texts.push(content.output);
    }
  }
  const text =
    texts.length > 0 ? texts.join("\n") : `{"status":"${item.status}"}`;
  return text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}…` : text;
}

/**
 * 时间线条目（已按显示顺序）→ 归一化记录。用户消息、助手文本、工具调用与终态结果
 * 进来，与旧镜像同形；思考、计划、审批、通知、回合这些不是对话，不进。游标是记录序号
 * （{@link sliceTimelineEntries} 填 `endOffset`）。
 */
export function entriesFromTimeline(
  items: readonly TimelineItem[],
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const push = (
    role: "user" | "assistant",
    blocks: Block[],
    at: number,
  ): void => {
    if (blocks.length === 0) return;
    entries.push({
      role,
      blocks,
      endOffset: 0,
      at: new Date(at).toISOString(),
    });
  };
  for (const item of items) {
    switch (item.kind) {
      case "user":
        push(
          "user",
          item.text === "" ? [] : [{ type: "text", text: item.text }],
          item.at,
        );
        break;
      case "assistant": {
        const text = item.parts
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        push("assistant", text === "" ? [] : [{ type: "text", text }], item.at);
        break;
      }
      case "tool": {
        push(
          "assistant",
          [
            {
              type: "tool_use",
              name: item.title || item.toolKind,
              id: item.toolCallId,
              ...(item.input === undefined ? {} : { input: item.input }),
            },
          ],
          item.startedAt,
        );
        if (item.status === "completed" || item.status === "failed") {
          push(
            "user",
            [
              {
                type: "tool_result",
                id: item.toolCallId,
                content: toolResultOf(item),
              },
            ],
            item.endedAt ?? item.at,
          );
        }
        break;
      }
      default:
        break;
    }
  }
  return coalesce(entries as unknown as MirrorEntry[]) as TranscriptEntry[];
}

/** {@link entriesFromTimeline} 的结果按游标（记录序号）与字节上限切一段。 */
export function sliceTimelineEntries(
  all: readonly TranscriptEntry[],
  fromOffset: number,
  maxBytes: number,
): EntryRange {
  const start =
    Number.isInteger(fromOffset) && fromOffset > 0 && fromOffset <= all.length
      ? fromOffset
      : fromOffset > all.length
        ? all.length
        : 0;
  const entries: TranscriptEntry[] = [];
  let bytes = 0;
  for (const entry of all.slice(start)) {
    bytes += JSON.stringify(entry.blocks).length;
    // 至少给一条，否则一条超大的记录会让增量读取永远不前进。
    if (entries.length > 0 && bytes > maxBytes) break;
    // `endOffset` 相对 `startOffset`：记录序号。
    entries.push({ ...entry, endOffset: entries.length + 1 });
  }
  return {
    entries,
    startOffset: start,
    endOffset: start + entries.length,
  };
}
