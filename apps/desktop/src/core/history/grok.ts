import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

import {
  type Candidate,
  type Parsed,
  MAX_FILES_PER_PROVIDER,
  readLines,
  title,
} from "../conversations/scan";
import {
  recordReportedCost,
  record as recordTokens,
} from "../usage/cost-buckets";
import { asRecord, duplicate, number } from "./cost-lines";
import { isFile, readRange } from "./files";
import { configRoot } from "./home";
import type {
  AbsorbContext,
  AgentCostSource,
  Block,
  EntryRange,
  HistoryAdapter,
  Located,
  SessionHint,
  TranscriptEntry,
} from "./types";

/**
 * Grok Build 的会话（契约 §124）：`$GROK_HOME/sessions/<编码后的 cwd>/<会话 id>/`。
 *
 * 一个会话一个目录，目录名是会话 id，里面用得上的两份：
 *
 *   * `summary.json`：`info.id`、`info.cwd`、`generated_title`（没有则
 *     `session_summary`）、`updated_at`——会话索引的标题与 cwd 来自这里；
 *   * `updates.jsonl`：逐行的 ACP 形状更新（`user_message_chunk`、`agent_message_chunk`、
 *     `tool_call`、`_x.ai/session/update` 里的 `turn_completed` 带每回合用量），转录与
 *     成本都读它。
 *
 * 不读 `session_search.sqlite`（grok 自己的全文索引，格式随版本变）、`events.jsonl`
 * （状态源读的，不是对话）、`chat_history.jsonl`（模型侧历史，带系统提示）。
 *
 * 格式没有公开，所以：认得的转，认不得的略过，`summary.json` 读不出来退到首条用户
 * 消息与目录名，永不抛到扫描路径上。目录名是 `encodeURIComponent(cwd)`，与平台无关：
 * 这里不做任何路径分隔符的假设，cwd 取 `summary.json` 里 grok 自己记的那个字符串。
 *
 * 读失败不清空索引：会话索引见到空列表就清掉这一家的行。根目录读不了（不是「没有」）
 * 时回上一趟读成功的；从没成功过则 {@link unreadable} 为真，索引这一趟不对账。
 */

export const UPDATES_FILE = "updates.jsonl";
const SUMMARY_FILE = "summary.json";
/** `summary.json` 实测不到 2 KB；留足余量，超过的当读不出。 */
const SUMMARY_MAX_BYTES = 256 * 1024;
const HEAD_BYTES = 256 * 1024;
const HEAD_LINES = 200;
const UNNAMED_TOOL = "未命名工具";
/** xAI 的费用计量：1 美元 = 10^10 个 tick（见 https://docs.x.ai 的 `cost_in_usd_ticks`）。 */
const TICKS_PER_USD = 1e10;

/** `<GROK_HOME>/sessions`；没有家目录也没有 `GROK_HOME` 时一个都没有。 */
export function roots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = configRoot("grok", env);
  return home === undefined ? [] : [join(home, "sessions")];
}

/* ---------------------------------- 列表 ---------------------------------- */

/** 每个根上一趟读成功的候选，按分组目录存，读不了的分组沿用它。 */
const lastGood = new Map<string, Map<string, Candidate[]>>();
const unreadableRoots = new Set<string>();

function readDir(path: string): string[] | "unreadable" | "absent" {
  try {
    return readdirSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "unreadable";
  }
}

function groupCandidates(group: string): Candidate[] | "unreadable" {
  const ids = readDir(group);
  if (ids === "absent") return [];
  if (ids === "unreadable") return "unreadable";
  const found: Candidate[] = [];
  for (const id of ids) {
    const path = join(group, id, UPDATES_FILE);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      found.push({
        path,
        updatedAt: new Date(stats.mtimeMs).toISOString(),
        bytes: stats.size,
      });
    } catch {
      // 没有 updates.jsonl（空会话或别的东西）：不是候选。
    }
  }
  return found;
}

/**
 * `<root>/<分组>/<会话 id>/updates.jsonl`。分组目录读不了就用上一趟那一组的；根
 * 目录读不了且从没读成功过，{@link unreadable} 为真。根不存在是「这台机器上没有」，
 * 照常答空。
 */
export function candidates(root: string): Candidate[] {
  const groups = readDir(root);
  if (groups === "absent") {
    lastGood.delete(root);
    unreadableRoots.delete(root);
    return [];
  }
  const previous = lastGood.get(root);
  if (groups === "unreadable") {
    unreadableRoots.add(root);
    if (previous === undefined) return [];
    unreadableRoots.delete(root);
    return [...previous.values()].flat();
  }
  unreadableRoots.delete(root);
  const next = new Map<string, Candidate[]>();
  const found: Candidate[] = [];
  for (const name of groups) {
    if (found.length >= MAX_FILES_PER_PROVIDER) break;
    const group = join(root, name);
    const listed = groupCandidates(group);
    const kept = listed === "unreadable" ? previous?.get(group) : listed;
    if (kept === undefined) continue;
    next.set(group, kept);
    found.push(...kept);
  }
  lastGood.set(root, next);
  return found;
}

/** 这个根上一趟读不了、又没有可回的上一趟：会话索引这一趟不对账。 */
export function unreadable(root: string): boolean {
  return unreadableRoots.has(root);
}

/** 测试用：忘掉上一趟的结果。 */
export function forgetListingsForTest(): void {
  lastGood.clear();
  unreadableRoots.clear();
}

/* ---------------------------------- 解析 ---------------------------------- */

function summaryOf(dir: string): Record<string, unknown> | undefined {
  const path = join(dir, SUMMARY_FILE);
  try {
    if (statSync(path).size > SUMMARY_MAX_BYTES) return undefined;
    return asRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 会话 id、标题、cwd；`path` 是会话目录里的 `updates.jsonl` 或 `summary.json`。 */
export function parse(path: string): Parsed | undefined {
  const dir = dirname(path);
  const directory = basename(dir);
  if (directory === "") return undefined;
  const summary = summaryOf(dir);
  const info = asRecord(summary?.info);
  const sessionId = text(info?.id) || directory;
  const cwd = text(info?.cwd);
  let found =
    text(summary?.generated_title) ||
    text(summary?.session_summary) ||
    text(summary?.title);
  if (found === "") {
    for (const line of readLines(
      join(dir, UPDATES_FILE),
      HEAD_BYTES,
      HEAD_LINES,
    )) {
      const entry = entryFrom(line, 0);
      const first = entry?.role === "user" ? entry.blocks[0] : undefined;
      if (first?.type === "text" && first.text.trim() !== "") {
        found = first.text;
        break;
      }
    }
  }
  return { sessionId, title: found === "" ? "" : title(found), cwd };
}

/* ---------------------------------- 定位 ---------------------------------- */

/** 会话 id 要拼进路径：空、`.`、`..`、带路径分隔符的都不要。 */
export function safeId(id: string | undefined): id is string {
  return (
    id !== undefined &&
    id !== "" &&
    id !== "." &&
    id !== ".." &&
    !/[/\\]/.test(id)
  );
}

/**
 * 按会话 id 找 `updates.jsonl`：先试 `encodeURIComponent(cwd)` 那一组，再在根下一层
 * 里按 id 找（cwd 与记下的不一样、长路径用了摘要名、符号链接）。上报的转录路径由
 * 注册表先认，这里只按 id 找。
 */
export function locate(hint: SessionHint): Located | undefined {
  if (!safeId(hint.sessionId)) return undefined;
  for (const root of roots()) {
    const candidatesAt: string[] = [];
    if (hint.cwd !== undefined && hint.cwd !== "") {
      candidatesAt.push(
        join(root, encodeURIComponent(hint.cwd), hint.sessionId, UPDATES_FILE),
      );
    }
    for (const path of candidatesAt) {
      if (isFile(path)) return located(path);
    }
    const groups = readDir(root);
    if (typeof groups === "string") continue;
    for (const group of groups) {
      const path = join(root, group, hint.sessionId, UPDATES_FILE);
      if (isFile(path)) return located(path);
    }
  }
  return undefined;
}

function located(path: string): Located {
  return { key: path, path, origin: `Grok 会话记录 ${path}` };
}

/* ---------------------------------- 行信息 --------------------------------- */

/**
 * 一行的时间（毫秒）：`params._meta.agentTimestampMs`，没有再退回 `timestamp_us`，
 * 再退回 `timestamp`（秒）。老版本的会话（2026-11-07 及更早）没有 `timestamp_us`；
 * 读不出来是 `undefined`，由调用方决定怎么办。
 */
export function recordMs(line: Record<string, unknown>): number | undefined {
  const meta = asRecord(asRecord(line.params)?._meta);
  const agent = meta?.agentTimestampMs;
  if (typeof agent === "number" && agent > 0) return agent;
  if (typeof line.timestamp_us === "number" && line.timestamp_us > 0) {
    return Math.floor(line.timestamp_us / 1000);
  }
  if (typeof line.timestamp === "number" && line.timestamp > 0) {
    return line.timestamp * 1000;
  }
  return undefined;
}

/**
 * 一行的稳定 id：`params._meta.eventId`（grok 自己给的，每个会话内唯一），没有再用
 * `timestamp_us`，再没有就取行内容的摘要。整段重读得到同一个 id，写入是幂等的。
 */
export function recordId(line: Record<string, unknown>): string {
  const meta = asRecord(asRecord(line.params)?._meta);
  if (typeof meta?.eventId === "string" && meta.eventId !== "") {
    return meta.eventId;
  }
  if (typeof line.timestamp_us === "number" && line.timestamp_us > 0) {
    return String(line.timestamp_us);
  }
  return createHash("sha1")
    .update(JSON.stringify(line.params ?? line))
    .digest("hex")
    .slice(0, 16);
}

/* ---------------------------------- 读取 ---------------------------------- */

function entryFrom(
  raw: string,
  endOffset: number,
): TranscriptEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const line = asRecord(value);
  const update = asRecord(asRecord(line?.params)?.update);
  if (line === undefined || update === undefined) return undefined;
  const ms = recordMs(line);
  const stamp = ms === undefined ? {} : { at: new Date(ms).toISOString() };
  const content = asRecord(update.content);
  const body =
    content?.type === "text" && typeof content.text === "string"
      ? content.text
      : "";
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      if (body.trim() === "") return undefined;
      return {
        role: "user",
        blocks: [{ type: "text", text: body }],
        endOffset,
        ...stamp,
      };
    case "agent_message_chunk":
      if (body.trim() === "") return undefined;
      return {
        role: "assistant",
        blocks: [{ type: "text", text: body }],
        endOffset,
        ...stamp,
      };
    case "tool_call": {
      const meta = asRecord(asRecord(update._meta)?.["x.ai/tool"]);
      const name = text(meta?.name) || text(update.title) || UNNAMED_TOOL;
      const id = text(update.toolCallId);
      const block: Block = {
        type: "tool_use",
        name,
        ...(id === "" ? {} : { id }),
        ...(update.rawInput === undefined ? {} : { input: update.rawInput }),
      };
      return { role: "assistant", blocks: [block], endOffset, ...stamp };
    }
    default:
      return undefined;
  }
}

/** 按行解析，偏移是那一行（含换行）结束的字节，与 `entries.ts` 同一套。 */
export function updateEntries(source: string): TranscriptEntry[] {
  const total = Buffer.byteLength(source, "utf8");
  const entries: TranscriptEntry[] = [];
  let offset = 0;
  for (const raw of source.split("\n")) {
    offset += Buffer.byteLength(raw, "utf8") + 1;
    const line = raw.trim();
    if (line === "") continue;
    const entry = entryFrom(line, Math.min(offset, total));
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

export function readEntries(
  located: Located,
  fromOffset: number,
  maxBytes: number,
): EntryRange {
  if (located.path === undefined) {
    return { entries: [], startOffset: 0, endOffset: 0 };
  }
  const range = readRange(located.path, fromOffset, maxBytes);
  let source = range.text;
  let startOffset = range.startOffset;
  const requested =
    fromOffset > range.endOffset || fromOffset < 0 ? 0 : fromOffset;
  if (startOffset > requested && source !== "") {
    const newline = source.indexOf("\n");
    const skipped = newline === -1 ? source : source.slice(0, newline + 1);
    startOffset += Buffer.byteLength(skipped, "utf8");
    source = newline === -1 ? "" : source.slice(newline + 1);
  }
  return {
    entries: updateEntries(source),
    startOffset,
    endOffset: range.endOffset,
  };
}

/* ---------------------------------- 成本 ---------------------------------- */

/**
 * 每回合一条 `_x.ai/session/update` 的 `turn_completed`，`usage.modelUsage` 按模型
 * 分开：`inputTokens` **含**缓存读（`totalTokens` = `inputTokens + outputTokens`，
 * 实测），所以记 `input` 要减掉缓存读与缓存写；`reasoningTokens` 已在
 * `outputTokens` 里。`costUsdTicks` 是 grok 自己算的费用（10^10 tick = 1 美元，xAI 官方文档 https://docs.x.ai），
 * 价格表不认 grok 的模型时汇总拿它兜底。`grok usage <会话 id>` 打出来的就是同一份
 * 记录（`usage.json`），所以不另走命令：读文件不起进程、不要登录。按
 * `prompt_id` 去重（分叉出来的会话会逐字重复前面的回合）。
 *
 * 未验证：减掉 `cacheCreationTokens` 这一步没有真实样本——手头的会话里它恒为 0，
 * 是照 `inputTokens` 含缓存读的口径推的。
 */
const costSource: AgentCostSource = {
  agentId: "grok",
  roots: () => roots(),
  owns: (path) => basename(path) === UPDATES_FILE,
  needles: [Buffer.from('"turn_completed"')],
  absorb(state, value, context) {
    const line = asRecord(value);
    const params = asRecord(line?.params);
    const update = asRecord(params?.update);
    if (update?.sessionUpdate !== "turn_completed") return;
    const usage = asRecord(update.usage);
    if (usage === undefined) return;
    const promptId =
      typeof update.prompt_id === "string" && update.prompt_id !== ""
        ? update.prompt_id
        : undefined;
    // `prompt_id` 是 UUID，分叉出来的会话逐字重复前面的回合时带的是同一个，所以键里
    // 不放会话 id。
    if (
      duplicate(
        context,
        promptId === undefined ? undefined : `grok:${promptId}`,
      )
    ) {
      return;
    }
    const ms = line === undefined ? undefined : recordMs(line);
    const timestamp = ms === undefined ? undefined : new Date(ms).toISOString();
    const perModel = asRecord(usage.modelUsage);
    const entries: [string, Record<string, unknown>][] = [];
    if (perModel !== undefined) {
      for (const [model, item] of Object.entries(perModel)) {
        const record = asRecord(item);
        if (record !== undefined) entries.push([model, record]);
      }
    }
    if (entries.length === 0) entries.push(["unknown", usage]);
    for (const [model, item] of entries)
      absorbModel(state, model, item, timestamp, context);
  },
};

function absorbModel(
  state: Parameters<AgentCostSource["absorb"]>[0],
  model: string,
  item: Record<string, unknown>,
  timestamp: string | undefined,
  context: AbsorbContext,
): void {
  const cacheRead = number(item.cachedReadTokens);
  const cacheCreation = number(item.cacheCreationTokens);
  const tokens = {
    input: Math.max(0, number(item.inputTokens) - cacheRead - cacheCreation),
    output: number(item.outputTokens),
    cacheRead,
    cacheCreation,
  };
  const empty =
    tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation ===
    0;
  if (empty) return;
  recordTokens(state, model, timestamp, tokens, context.nowMs);
  recordReportedCost(
    state,
    model,
    timestamp,
    number(item.costUsdTicks) / TICKS_PER_USD,
    context.nowMs,
  );
}

/* --------------------------------- 适配器 --------------------------------- */

export const grokAdapter: HistoryAdapter = {
  agentId: "grok",
  roots,
  locate,
  list: candidates,
  parse: (candidate) => parse(candidate.path),
  readEntries,
  unreadable,
  cost: { kind: "jsonl", source: costSource },
};
