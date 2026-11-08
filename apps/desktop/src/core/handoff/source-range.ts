import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { summarizeInput } from "../collab/transcript";
import { blocksOf } from "../history/entries";
import { KEY_PREFIX } from "../history/opencode";
import {
  describeHistoryCursor,
  historyCursorUnit,
  parseHistoryText,
  readHistoryEntries,
} from "../history/registry";
import type { Located, TranscriptEntry } from "../history/types";
import { redactSecrets, sanitize } from "./bundle";

/**
 * 来源转录的「冻结游标」与按游标分页读（设计 handoff-v2 §2.1、§2.2）。
 *
 * 这一层跑在**转录所在的那台机器**上：本机来源在控制端直接调，SSH 来源经那台
 * 主机 Worker 的 `handoff.capture`（`transcriptRange`）调同一个函数。授权不在这里——
 * 谁能读哪一份交接由 `store.ts::readForCaller` 在调用之前判完。
 */

/** 单页字节上限，与 `context transcript` 的 `MAX_TRANSCRIPT_BYTES` 同一个数。 */
export const PAGE_BYTES = 32 * 1024;
/** 文件来源一次读这么多字节的窗口。 */
const WINDOW_BYTES = 128 * 1024;
/** 一行超过这个长度就不再往后找换行：整行丢掉。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** 一页最多读这么多个窗口，免得一份几乎全是跳过行的文件让一次读取读到天亮。 */
const MAX_WINDOWS = 128;
/** 一条记录的正文最多留这么多字符，其余用 `--raw` 取原文。 */
const MAX_TEXT_CHARS = 16_000;
const MAX_RESULT_CHARS = 400;

export type CursorUnit = "bytes" | "entries" | "opaque";

/** 冻结时记在包里的来源边界（`HandoffBundle.sourceCursor`）。 */
export interface SourceCursor {
  readonly agentId: string;
  /** `Located.key`：文件路径、`opencode:<id>`、ACP 时间线路径。 */
  readonly locatedKey: string;
  /** `local-runtime` 或 `execution-host:<id>`：转录在哪台机器上。 */
  readonly executionHost: string;
  /** `readHistoryEntries` 的游标：冻结时转录末尾。 */
  readonly endOffset: number;
  /** 文件来源：`[0, endOffset)` 的 sha256；其余是 `null`。 */
  readonly prefixSha256: string | null;
  readonly unit: CursorUnit;
}

/** 主机侧算出来的那一半（`agentId` 与 `executionHost` 由控制端补）。 */
export interface FrozenCursor {
  readonly locatedKey: string;
  readonly endOffset: number;
  readonly prefixSha256: string | null;
  readonly unit: CursorUnit;
}

/** 归一化之后的一条记录，各家 CLI 一个形状。 */
export interface SourceEntry {
  readonly role: "user" | "assistant" | "system";
  readonly at?: string;
  readonly text: string;
  readonly tools: readonly { name: string; inputSummary: string }[];
  readonly results: readonly { summary: string; truncated: boolean }[];
}

export interface RangeRequest {
  readonly agentId: string;
  readonly locatedKey: string;
  readonly unit: CursorUnit;
  readonly endOffset: number;
  readonly prefixSha256: string | null;
  readonly fromOffset: number;
  readonly maxBytes: number;
  /** 最多多少条（原文模式：多少行）；缺省只受字节上限约束。 */
  readonly maxItems?: number;
  readonly raw: boolean;
}

export type RangeAnswer =
  | {
      readonly state: "ok";
      readonly entries?: readonly SourceEntry[];
      readonly rawLines?: readonly string[];
      /** 原文模式下被截到单页上限的行数。 */
      readonly truncatedLines?: number;
      readonly nextOffset: number;
      readonly done: boolean;
      readonly cursorText: string;
    }
  /** `[0, endOffset)` 的哈希对不上（被压缩或改写）或文件变短了。 */
  | { readonly state: "changed" }
  /** 来源读不到了（文件没了、库没了、时间线空了）。 */
  | { readonly state: "missing" }
  | { readonly state: "badCursor" };

/* --------------------------------- locating -------------------------------- */

function locatedOf(key: string): Located {
  return key.startsWith(KEY_PREFIX)
    ? { key, origin: "OpenCode 会话库" }
    : { key, path: key, origin: `转录文件 ${key}` };
}

function usableKey(key: string): boolean {
  if (key.includes("\0")) return false;
  return key.startsWith(KEY_PREFIX) || isAbsolute(key);
}

/* --------------------------------- freezing -------------------------------- */

function fileSize(path: string): number {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : -1;
  } catch {
    return -1;
  }
}

/** 最后一个换行之后的位置；整份没有换行（单个 JSON 文档）就是文件尾。 */
function lastLineEnd(path: string, size: number): number {
  if (size === 0) return 0;
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const read = readSync(fd, chunk, 0, end - start, start);
      const at = chunk.subarray(0, read).lastIndexOf(0x0a);
      if (at !== -1) return start + at + 1;
      end = start;
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

function prefixDigestSync(path: string, end: number): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < end) {
      const read = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, end - position),
        position,
      );
      if (read === 0) return "";
      hash.update(chunk.subarray(0, read));
      position += read;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * 冻结此刻转录的末尾。文件来源把边界收在最后一个完整行，并算前缀哈希；没有文件
 * 的来源只记游标。读不出来是 `undefined`（交接照常，只是没有往后读原文的路）。
 */
export function freezeCursor(
  agentId: string,
  located: Located,
): FrozenCursor | undefined {
  const unit = historyCursorUnit(located);
  try {
    if (unit === "bytes") {
      const path = located.path as string;
      const size = fileSize(path);
      if (size < 0) return undefined;
      const end = lastLineEnd(path, size);
      const sha = prefixDigestSync(path, end);
      if (sha === "") return undefined;
      return {
        locatedKey: located.key,
        endOffset: end,
        prefixSha256: sha,
        unit,
      };
    }
    // 时间线按条数；OpenCode 只要最新那条的游标，不把整段会话读进来。
    const range = readHistoryEntries(
      agentId,
      located,
      0,
      unit === "entries" ? Number.MAX_SAFE_INTEGER : 1,
    );
    if (range.entries.length === 0) return undefined;
    return {
      locatedKey: located.key,
      endOffset: range.endOffset,
      prefixSha256: null,
      unit,
    };
  } catch {
    return undefined;
  }
}

/* ------------------------------- normalizing ------------------------------- */

function cut(text: string, max: number): { text: string; cut: boolean } {
  const characters = [...text];
  return characters.length <= max
    ? { text, cut: false }
    : { text: `${characters.slice(0, max).join("")}…`, cut: true };
}

function collapse(text: string): string {
  return text.trim().split(/\s+/).filter(Boolean).join(" ");
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((part) => part !== "")
    .join("\n");
}

/** 归一化记录 → 统一形状；密钥与控制字符在这里就收掉，不跨主机、不进答复。 */
export function normalizeEntry(entry: TranscriptEntry): SourceEntry {
  const texts: string[] = [];
  const tools: { name: string; inputSummary: string }[] = [];
  const results: { summary: string; truncated: boolean }[] = [];
  for (const block of entry.blocks) {
    if (block.loose === true) continue;
    if (block.type === "text") {
      texts.push(block.text);
    } else if (block.type === "tool_use") {
      tools.push({
        name: sanitize(block.name),
        inputSummary:
          block.input === undefined
            ? ""
            : sanitize(summarizeInput(block.input)),
      });
    } else {
      const summary = cut(
        sanitize(collapse(resultText(block.content))),
        MAX_RESULT_CHARS,
      );
      results.push({ summary: summary.text, truncated: summary.cut });
    }
  }
  const text = cut(sanitize(texts.join("\n").trim()), MAX_TEXT_CHARS);
  return {
    role: entry.role,
    ...(entry.at === undefined ? {} : { at: entry.at }),
    text: text.text,
    tools,
    results,
  };
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
}

/** 原文行里的密钥换掉，换完仍是合法 JSON。 */
function redactRaw(line: string): string {
  if (line.includes("-----BEGIN") && line.includes("PRIVATE KEY-----")) {
    return JSON.stringify({ redacted: "private key" });
  }
  return redactSecrets(line);
}

/* --------------------------------- reading --------------------------------- */

function readBytes(path: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    let filled = 0;
    while (filled < length) {
      const read = readSync(
        fd,
        buffer,
        filled,
        length - filled,
        start + filled,
      );
      if (read === 0) break;
      filled += read;
    }
    return buffer.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

function describe(
  request: RangeRequest,
  located: Located,
  offset: number,
): string {
  return describeHistoryCursor(request.agentId, located, offset);
}

/**
 * 读一页：从 `fromOffset` 往后，**到 `endOffset` 为止**，一页不超过 `maxBytes`
 * （上限 {@link PAGE_BYTES}）。冻结之后追加到来源的内容在 `endOffset` 之后，读不到。
 */
export function readSourceRange(request: RangeRequest): RangeAnswer {
  if (!usableKey(request.locatedKey)) return { state: "missing" };
  const from = request.fromOffset;
  if (!Number.isSafeInteger(from) || from < 0 || from > request.endOffset) {
    return { state: "badCursor" };
  }
  const maxBytes = Math.min(Math.max(request.maxBytes, 256), PAGE_BYTES);
  const maxItems =
    request.maxItems === undefined
      ? Number.POSITIVE_INFINITY
      : request.maxItems;
  const located = locatedOf(request.locatedKey);
  try {
    return request.unit === "bytes"
      ? readFileRange(request, located, from, maxBytes, maxItems)
      : readCursorRange(request, located, from, maxBytes, maxItems);
  } catch {
    return { state: "missing" };
  }
}

function readFileRange(
  request: RangeRequest,
  located: Located,
  from: number,
  maxBytes: number,
  maxItems: number,
): RangeAnswer {
  const path = located.path as string;
  const end = request.endOffset;
  const size = fileSize(path);
  if (size < 0) return { state: "missing" };
  if (size < end) return { state: "changed" };
  if (
    request.prefixSha256 !== null &&
    prefixDigestSync(path, end) !== request.prefixSha256
  ) {
    return { state: "changed" };
  }
  // 游标必须在行首，否则是读者自己编的数。
  if (from > 0 && readBytes(path, from - 1, from)[0] !== 0x0a) {
    return { state: "badCursor" };
  }
  const entries: SourceEntry[] = [];
  const rawLines: string[] = [];
  let truncatedLines = 0;
  let used = 2;
  let position = from;
  let full = false;
  for (let windows = 0; position < end && !full; windows += 1) {
    if (windows >= MAX_WINDOWS) break;
    let windowEnd = Math.min(end, position + WINDOW_BYTES);
    let buffer = readBytes(path, position, windowEnd);
    if (windowEnd < end) {
      let newline = buffer.lastIndexOf(0x0a);
      // 一行比窗口还长：往后找它的换行，最多找到 MAX_LINE_BYTES。
      while (newline === -1 && windowEnd < end) {
        if (windowEnd - position >= MAX_LINE_BYTES) break;
        windowEnd = Math.min(end, windowEnd + WINDOW_BYTES);
        buffer = readBytes(path, position, windowEnd);
        newline = buffer.lastIndexOf(0x0a);
      }
      if (newline === -1) {
        // 超长的一行：整行丢掉，从这个窗口之后接着读。
        position = windowEnd;
        continue;
      }
      buffer = buffer.subarray(0, newline + 1);
      windowEnd = position + newline + 1;
    }
    if (request.raw) {
      let offset = position;
      for (const line of buffer.toString("utf8").split("\n")) {
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        const lineEnd = offset + lineBytes;
        if (line.trim() === "") {
          offset = lineEnd;
          continue;
        }
        if (rawLines.length >= maxItems) {
          full = true;
          break;
        }
        let text = redactRaw(line);
        if (Buffer.byteLength(text, "utf8") + 1 > maxBytes) {
          // 单行就超一页：只给得下的前半截，并数一笔。
          if (rawLines.length > 0) {
            full = true;
            break;
          }
          text = text.slice(0, maxBytes - 64);
          truncatedLines += 1;
        }
        const size = Buffer.byteLength(text, "utf8") + 1;
        if (rawLines.length > 0 && used + size > maxBytes) {
          full = true;
          break;
        }
        rawLines.push(text);
        used += size;
        offset = lineEnd;
        position = lineEnd;
      }
      if (!full) position = windowEnd;
      continue;
    }
    const parsed = parseHistoryText(
      request.agentId,
      located,
      buffer.toString("utf8"),
    );
    let consumed = 0;
    for (const entry of parsed) {
      const normalized = normalizeEntry(entry);
      const size = sizeOf(normalized);
      if (
        entries.length >= maxItems ||
        (entries.length > 0 && used + size > maxBytes)
      ) {
        full = true;
        break;
      }
      entries.push(normalized);
      used += size;
      consumed = entry.endOffset;
    }
    position = full ? position + consumed : windowEnd;
  }
  const done = position >= end;
  const nextOffset = done ? end : position;
  return {
    state: "ok",
    ...(request.raw ? { rawLines, truncatedLines } : { entries }),
    nextOffset,
    done,
    cursorText: describe(request, located, nextOffset),
  };
}

/** 时间线（按条）与 OpenCode（不透明游标）：适配器只给「从某处往后」，这里截到边界。 */
function readCursorRange(
  request: RangeRequest,
  located: Located,
  from: number,
  maxBytes: number,
  maxItems: number,
): RangeAnswer {
  const range = readHistoryEntries(
    request.agentId,
    located,
    from,
    Number.MAX_SAFE_INTEGER,
  );
  const eligible = range.entries.filter(
    (entry) => range.startOffset + entry.endOffset <= request.endOffset,
  );
  if (eligible.length === 0 && from < request.endOffset) {
    return range.entries.length === 0 && request.unit === "opaque"
      ? { state: "missing" }
      : request.unit === "entries" && range.endOffset < request.endOffset
        ? { state: "missing" }
        : finishedEmpty(request, located);
  }
  const entries: SourceEntry[] = [];
  const rawLines: string[] = [];
  let used = 2;
  let taken = 0;
  let lastOffset = from;
  for (const entry of eligible) {
    const normalized = normalizeEntry(entry);
    const text = request.raw
      ? redactRaw(
          JSON.stringify({
            role: entry.role,
            ...(entry.at === undefined ? {} : { at: entry.at }),
            blocks: entry.blocks,
          }),
        )
      : undefined;
    const size = sizeOf(text ?? normalized);
    if (taken >= maxItems || (taken > 0 && used + size > maxBytes)) break;
    if (text === undefined) entries.push(normalized);
    else rawLines.push(text);
    used += size;
    taken += 1;
    lastOffset = range.startOffset + entry.endOffset;
  }
  const finished = taken === eligible.length;
  const nextOffset = finished ? request.endOffset : lastOffset;
  return {
    state: "ok",
    ...(request.raw ? { rawLines, truncatedLines: 0 } : { entries }),
    nextOffset,
    done: finished,
    cursorText: describe(request, located, nextOffset),
  };
}

function finishedEmpty(request: RangeRequest, located: Located): RangeAnswer {
  return {
    state: "ok",
    ...(request.raw ? { rawLines: [], truncatedLines: 0 } : { entries: [] }),
    nextOffset: request.endOffset,
    done: true,
    cursorText: describe(request, located, request.endOffset),
  };
}

/* ------------------------------- wire parsing ------------------------------ */

const UNITS = new Set<string>(["bytes", "entries", "opaque"]);

/** Worker 收到的参数（外来数据）逐项核对。 */
export function rangeRequestOf(value: unknown): RangeRequest | undefined {
  const raw = value as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object") return undefined;
  const text = (key: string): string | undefined =>
    typeof raw[key] === "string" && raw[key] !== ""
      ? (raw[key] as string)
      : undefined;
  const count = (key: string): number | undefined =>
    typeof raw[key] === "number" && Number.isSafeInteger(raw[key])
      ? (raw[key] as number)
      : undefined;
  const agentId = text("agentId");
  const locatedKey = text("locatedKey");
  const unit = text("unit");
  const endOffset = count("endOffset");
  const fromOffset = count("fromOffset");
  const maxBytes = count("maxBytes");
  if (
    agentId === undefined ||
    locatedKey === undefined ||
    unit === undefined ||
    !UNITS.has(unit) ||
    endOffset === undefined ||
    fromOffset === undefined ||
    maxBytes === undefined
  ) {
    return undefined;
  }
  const maxItems = count("maxItems");
  const sha = raw.prefixSha256;
  return {
    agentId,
    locatedKey,
    unit: unit as CursorUnit,
    endOffset,
    prefixSha256: typeof sha === "string" ? sha : null,
    fromOffset,
    maxBytes,
    ...(maxItems === undefined ? {} : { maxItems }),
    raw: raw.raw === true,
  };
}

/** Worker 的答复同样是外来数据：只认这几种形状，超过两页当作读不了。 */
export function rangeAnswerOf(value: unknown): RangeAnswer | undefined {
  const raw = value as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object") return undefined;
  if (
    raw.state === "changed" ||
    raw.state === "missing" ||
    raw.state === "badCursor"
  ) {
    return { state: raw.state };
  }
  if (raw.state !== "ok") return undefined;
  if (
    typeof raw.nextOffset !== "number" ||
    !Number.isSafeInteger(raw.nextOffset) ||
    typeof raw.done !== "boolean" ||
    typeof raw.cursorText !== "string"
  ) {
    return undefined;
  }
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > PAGE_BYTES * 4) {
    return undefined;
  }
  const entries = Array.isArray(raw.entries) ? raw.entries : undefined;
  const rawLines = Array.isArray(raw.rawLines) ? raw.rawLines : undefined;
  if (
    (entries === undefined && rawLines === undefined) ||
    (rawLines !== undefined &&
      !rawLines.every((line) => typeof line === "string")) ||
    (entries !== undefined &&
      !entries.every((entry) => entryOk(entry as Record<string, unknown>)))
  ) {
    return undefined;
  }
  return {
    state: "ok",
    ...(entries === undefined
      ? {}
      : { entries: entries as readonly SourceEntry[] }),
    ...(rawLines === undefined
      ? {}
      : { rawLines: rawLines as readonly string[] }),
    ...(typeof raw.truncatedLines === "number"
      ? { truncatedLines: raw.truncatedLines }
      : {}),
    nextOffset: raw.nextOffset,
    done: raw.done,
    cursorText: raw.cursorText,
  };
}

function entryOk(entry: Record<string, unknown> | null): boolean {
  return (
    entry !== null &&
    typeof entry === "object" &&
    (entry.role === "user" ||
      entry.role === "assistant" ||
      entry.role === "system") &&
    typeof entry.text === "string" &&
    Array.isArray(entry.tools) &&
    Array.isArray(entry.results)
  );
}
