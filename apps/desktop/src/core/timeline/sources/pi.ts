/**
 * Pi 与 OMP 转录 → 时间线（设计 §5.2）。
 *
 * 文件：`<agentDir>/sessions/<编码 cwd>/<ISO 时间>_<uuid>.jsonl`，路径由扩展的
 * `transcriptPath` 报来。两家是同一份格式（OMP 是 Pi 的分支），所以同一个转换器
 * 造两个适配器。一行一条记录 `{type, id, parentId, timestamp, …}`，用到的几种：
 *
 *   * `message`：`role` 为 `user`（文本和图片块）、`assistant`（`text` / `thinking` /
 *     `toolCall` 块，带 `usage` 和 `stopReason`）、`toolResult`（`toolCallId`、文本块、
 *     `isError`、`details`）；`system` 与扩展自定义的 role 跳过；
 *   * `session_info.name`（Pi）、`title.title` / `title_change.title`（OMP）→ 标题；
 *   * `compaction` → 压缩边界提示。
 *
 * 条目 id 用记录自己的 id（`a:<id>:<块号>`、`th:<id>:<块号>`），工具用 `toolCall.id`。
 *
 * 能拿到：用户文本与附图；助手文本；思考（有的模型只给签名，正文为空，条目留着显示
 * 「已隐藏」）；工具调用及其结果：`bash` 的输出和退出码（Pi 从结果末尾的
 * `Command exited with code N` 读，OMP 有 `details.exitCode`）、`edit` / `write` 的
 * diff（从调用参数的 `edits[].oldText / newText` 或 `content` 推出，没有参数时退到
 * `details.diff`）；`usage` → 用量；`stopReason` → 回合收尾（`aborted` → 已取消，
 * `error` → 出错）。
 *
 * 拿不到：逐 token 的流；子代理（`subagent` / `task` 工具）内部的调用；OMP 的 `todo`
 * 工具不转计划（参数是操作而非清单）；模型的上下文窗口（转录里没有，按 200k）。
 *
 * Pi 与 OMP 共用 `PI_CODING_AGENT_DIR` 时一个文件只归写它的那一家（OMP 的文件开头有
 * 一行 `title` 记录）：兜底定位只在自己写的文件里挑，不会接到别家的会话上。
 */

import { resolve } from "node:path";

import {
  type TimelineAttachment,
  type TimelineToolContent,
  type TimelineToolKind,
  type ToolPatch,
  toolContentOf,
  toolInputSummary,
} from "@armadra/shared";

import { reportedFile } from "../../history/files";
import { configRoot } from "../../history/home";
import { historyAdapter, locateHistory } from "../../history/registry";
import type { SessionHint } from "../../history/types";
import {
  type Json,
  diffContent,
  firstLine,
  kindByName,
  num,
  obj,
  sidesOfLines,
  str,
  terminalContent,
  textContent,
  timeOf,
  windowOf,
} from "./convert-util";
import type { TimelineSink } from "./sink";
import type { TranscriptAdapter } from "./types";

const KIND_TABLE: ReadonlyArray<readonly [RegExp, TimelineToolKind]> = [
  [/^(bash|shell|exec)$/i, "execute"],
  [/^(read|view)$/i, "read"],
  [/^(edit|write|multiedit|apply_patch|ast_edit)$/i, "edit"],
  [/^(grep|find|glob|ls|list|web_search|search|ast_grep)/i, "search"],
  [/^(web_fetch|fetch)/i, "fetch"],
  [/^(subagent|task)$/i, "subagent"],
];

export function piToolKind(name: string): TimelineToolKind {
  return kindByName(name, KIND_TABLE);
}

/* --------------------------------- 工具 --------------------------------- */

function titleOf(name: string, args: Json | undefined): string {
  const command = str(args?.command);
  if (/^bash$/i.test(name) && command !== undefined) {
    return firstLine(command, 160);
  }
  if (/^(subagent|task)$/i.test(name)) {
    const task = str(args?.task) ?? str(args?.description) ?? str(args?.agent);
    return firstLine(task ?? name, 160);
  }
  const target =
    str(args?.path) ?? str(args?.pattern) ?? str(args?.query) ?? str(args?.url);
  return target === undefined ? name : `${name} ${firstLine(target, 160)}`;
}

/** `edit` 的每一处替换（新旧两种参数形状）。 */
function replacementsOf(args: Json): { oldText: string; newText: string }[] {
  const out: { oldText: string; newText: string }[] = [];
  const edits = args.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const o = obj(edit);
      const oldText = str(o?.oldText) ?? str(o?.old_string);
      const newText = str(o?.newText) ?? str(o?.new_string);
      if (oldText !== undefined && newText !== undefined) {
        out.push({ oldText, newText });
      }
    }
  }
  const oldText = str(args.oldText) ?? str(args.old_string);
  const newText = str(args.newText) ?? str(args.new_string);
  if (oldText !== undefined && newText !== undefined) {
    out.push({ oldText, newText });
  }
  return out;
}

function editContent(
  name: string,
  args: Json | undefined,
  sink: TimelineSink,
  at: number,
): TimelineToolContent[] {
  const path = str(args?.path);
  if (args === undefined || path === undefined) return [];
  const ctx = sink.blobContext(at);
  const out: TimelineToolContent[] = [];
  if (/^write$/i.test(name)) {
    const body = str(args.content);
    const diff = body === undefined ? null : diffContent(path, null, body, ctx);
    if (diff !== null) out.push(diff);
    return out;
  }
  for (const { oldText, newText } of replacementsOf(args).slice(0, 8)) {
    const diff = diffContent(path, oldText, newText, ctx);
    if (diff !== null) out.push(diff);
  }
  return out;
}

/** Pi 的 `details.diff`：`+1373 text` / `-1370 text` / ` 1369 text` / `...`。 */
function piDiffSides(diff: string) {
  const lines: string[] = [];
  for (const raw of diff.split("\n")) {
    if (raw.trim() === "..." || raw.trim() === "") continue;
    const match = /^([+\- ])\s*\d+ (.*)$/.exec(raw);
    if (match !== null) lines.push(`${match[1]}${match[2]}`);
  }
  return sidesOfLines(lines);
}

function startTool(
  sink: TimelineSink,
  turn: ReturnType<TimelineSink["turnForContent"]>,
  at: number,
  block: Json,
): void {
  const id = str(block.id);
  const name = str(block.name);
  if (id === undefined || name === undefined) return;
  const args = obj(block.arguments);
  const kind = piToolKind(name);
  const patch: ToolPatch = {
    toolKind: kind,
    title: titleOf(name, args),
    status: "in_progress",
    locations: [],
  };
  const summary = args === undefined ? undefined : toolInputSummary(args);
  if (summary !== undefined) patch.input = summary;
  const path = str(args?.path);
  if (path !== undefined) {
    const line = num(args?.offset);
    patch.locations = [{ path, ...(line !== undefined ? { line } : {}) }];
  }
  if (kind === "edit") patch.content = editContent(name, args, sink, at);
  sink.upsertTool(turn, id, at, patch, { create: true });
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => str(obj(block)?.text) ?? "")
    .filter((text) => text !== "")
    .join("\n");
}

function finishTool(sink: TimelineSink, message: Json, at: number): void {
  const id = str(message.toolCallId);
  if (id === undefined) return;
  const existing = sink.tool(id);
  const turn = sink.latestTurn();
  if (existing === undefined || turn === undefined) return;
  const text = resultText(message.content);
  const details = obj(message.details);
  const isError = message.isError === true;

  if (existing.toolKind === "execute") {
    const trailer = /\n*Command exited with code (-?\d+)\s*$/.exec(text);
    const exitCode =
      num(details?.exitCode) ??
      (trailer !== null ? Number(trailer[1]) : undefined);
    sink.upsertTool(turn, id, at, {
      status:
        isError || (exitCode !== undefined && exitCode !== 0)
          ? "failed"
          : "completed",
      content: [
        terminalContent({
          terminalId: id,
          command: existing.input?.command,
          output: trailer !== null ? text.slice(0, trailer.index) : text,
          ...(exitCode !== undefined ? { exitCode } : {}),
        }),
      ],
    });
    return;
  }
  let content: TimelineToolContent[];
  if (existing.toolKind === "edit" && !isError) {
    content = existing.content;
    const diff = str(details?.diff);
    const path = existing.locations[0]?.path;
    if (content.length === 0 && diff !== undefined && path !== undefined) {
      const sides = piDiffSides(diff);
      const built = diffContent(
        path,
        sides.oldText,
        sides.newText,
        sink.blobContext(at),
      );
      content = built === null ? textContent(text) : [built];
    }
  } else {
    content = [...existing.content, ...textContent(text)];
  }
  sink.upsertTool(turn, id, at, {
    status: isError ? "failed" : "completed",
    content,
  });
}

/* --------------------------------- 消息 --------------------------------- */

function handleUser(
  message: Json,
  id: string,
  at: number,
  sink: TimelineSink,
): void {
  const content = message.content;
  const texts: string[] = [];
  const attachments: TimelineAttachment[] = [];
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content)) {
    for (const item of content) {
      const block = obj(item);
      if (block?.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block?.type === "image") {
        const data = str(block.data);
        const mimeType = str(block.mimeType) ?? "image/png";
        if (data === undefined) continue;
        const part = toolContentOf(
          { type: "content", content: { type: "image", data, mimeType } },
          sink.blobContext(at),
        );
        if (part?.type === "image" && part.blobId !== undefined) {
          attachments.push({
            kind: "image",
            mimeType,
            blobId: part.blobId,
            ...(part.bytes !== undefined ? { bytes: part.bytes } : {}),
          });
        }
      }
    }
  }
  const text = texts.join("\n").trim();
  if (text === "" && attachments.length === 0) return;
  sink.beginTurn(`pi:${id}`, at, {
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}

function stopOf(
  message: Json,
):
  | { stopReason?: string; error?: { code: string; message: string } }
  | undefined {
  switch (message.stopReason) {
    case "stop":
      return { stopReason: "end_turn" };
    case "length":
      return { stopReason: "max_tokens" };
    case "aborted":
      return { stopReason: "cancelled" };
    case "error":
      return {
        error: {
          code: "error",
          message: (str(message.errorMessage) ?? "error").slice(0, 4_000),
        },
      };
    default:
      return undefined;
  }
}

function handleAssistant(
  message: Json,
  id: string,
  at: number,
  sink: TimelineSink,
): void {
  const turn = sink.turnForContent(at, `pi:${id}`);
  const blocks = Array.isArray(message.content) ? message.content : [];
  blocks.forEach((item, index) => {
    const block = obj(item);
    if (block === undefined) return;
    switch (block.type) {
      case "text": {
        const text = str(block.text) ?? "";
        if (text.trim() === "") return;
        sink.assistant(turn, `a:${id}:${index}`, at, [{ type: "text", text }]);
        return;
      }
      case "thinking":
        sink.thought(turn, `th:${id}:${index}`, at, str(block.thinking) ?? "");
        return;
      case "toolCall":
        startTool(sink, turn, at, block);
        return;
      default:
    }
  });
  const usage = obj(message.usage);
  if (usage !== undefined) {
    const used =
      (num(usage.input) ?? 0) +
      (num(usage.cacheRead) ?? 0) +
      (num(usage.cacheWrite) ?? 0);
    if (used > 0) sink.usage({ used, size: windowOf(str(message.model)) });
  }
  const stop = stopOf(message);
  if (stop !== undefined) {
    const head = sink.usageNow();
    sink.endTurn(at, {
      ...stop,
      ...(head !== undefined ? { usage: head } : {}),
    });
  }
}

function convert(value: unknown, sink: TimelineSink): void {
  const record = obj(value);
  if (record === undefined) return;
  const id = str(record.id) ?? "";
  switch (record.type) {
    case "message": {
      const message = obj(record.message);
      if (message === undefined) return;
      const at = timeOf(
        record.timestamp,
        timeOf(message.timestamp, Date.now()),
      );
      switch (message.role) {
        case "user":
          handleUser(message, id, at, sink);
          return;
        case "assistant":
          handleAssistant(message, id, at, sink);
          return;
        case "toolResult":
          finishTool(sink, message, at);
          return;
        default:
      }
      return;
    }
    case "session_info": {
      const name = str(record.name);
      if (name !== undefined) sink.title(name);
      return;
    }
    case "title":
    case "title_change": {
      const title = str(record.title);
      if (title !== undefined) sink.title(title);
      return;
    }
    case "compaction": {
      const at = timeOf(record.timestamp, Date.now());
      sink.notice(
        sink.turnForContent(at, `pi:${id}`),
        `n:${id}`,
        at,
        "compacted",
      );
      return;
    }
    default:
  }
}

/* --------------------------------- 适配器 --------------------------------- */

/** 两家的配置目录是不是同一个（`PI_CODING_AGENT_DIR` 对两家都生效）。 */
function sharedRoot(env: NodeJS.ProcessEnv = process.env): boolean {
  const pi = configRoot("pi", env);
  const omp = configRoot("omp", env);
  return pi !== undefined && omp !== undefined && resolve(pi) === resolve(omp);
}

/**
 * 这一家的转录文件。两家各用各的目录时交给历史适配器（报来的路径、会话 id、
 * cwd 加启动时间）；共用一个目录时历史适配器的兜底可能选到别家写的文件，所以
 * 改走它的 `list`（共用时已按写入方过滤）自己挑：会话 id 命中的，否则同 cwd、
 * 启动之后最近改过的。扩展自己报来的路径一定是它写的，直接信。
 */
function locateFor(
  agentId: "pi" | "omp",
  hint: SessionHint,
): string | undefined {
  const withAgent = { ...hint, agentId };
  if (!sharedRoot()) return locateHistory(withAgent)?.path;
  const reported = reportedFile(hint.transcriptPath)?.path;
  if (reported !== undefined) return reported;
  const adapter = historyAdapter(agentId);
  if (adapter === undefined) return undefined;
  const candidates = adapter.roots().flatMap((root) => adapter.list(root));
  const sessionId = hint.sessionId;
  if (sessionId !== undefined && sessionId !== "") {
    const hit = candidates.find((c) => c.path.endsWith(`_${sessionId}.jsonl`));
    if (hit !== undefined) return hit.path;
  }
  if (hint.cwd === undefined || hint.startedAtMs === undefined) {
    return undefined;
  }
  let best: { modified: number; path: string } | undefined;
  for (const candidate of candidates) {
    const modified = Date.parse(candidate.updatedAt);
    if (!(modified >= hint.startedAtMs)) continue;
    if (best !== undefined && modified <= best.modified) continue;
    if (adapter.parse(candidate)?.cwd !== hint.cwd) continue;
    best = { modified, path: candidate.path };
  }
  return best?.path;
}

function adapterOf(agentId: "pi" | "omp"): TranscriptAdapter {
  return {
    agentId,
    locate: (hint: SessionHint) => locateFor(agentId, hint),
    convert,
    toolKind: piToolKind,
  };
}

export const piTranscript: TranscriptAdapter = adapterOf("pi");
export const ompTranscript: TranscriptAdapter = adapterOf("omp");
