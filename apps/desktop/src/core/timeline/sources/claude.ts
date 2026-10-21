/**
 * Claude Code 转录 → 时间线（设计 §5.2）。
 *
 * 文件：`<configHome>/projects/<cwd 编码>/<会话 id>.jsonl`，路径由 hook 的
 * `transcript_path` 报来。一行一条记录；助手消息的每个内容块（thinking / text /
 * tool_use）各占一行，共用 `message.id`，各有自己的 `uuid`——所以条目 id 用
 * `a:<uuid>:<块号>` / `th:<uuid>:<块号>`，工具用 `tool:<tool_use_id>`。
 *
 * 能拿到：用户文本与附图；助手文本；思考（服务端隐去时正文为空，只剩签名，条目
 * 留着、文本为空，页面显示「已隐藏」）；工具调用及其结果（Bash 的 stdout / stderr /
 * 被打断，Edit / Write 的 `structuredPatch` 转成 diff，提问与答案）；`TodoWrite` →
 * 计划；`usage`；`custom-title` / `agent-name` → 头部标题；压缩边界 → 提示。
 *
 * 拿不到：逐 token 的流（一行是一个完整的块）；子代理内部的调用（它们在
 * `isSidechain` 的记录里，这里跳过，子代理在时间线上只是一个 `subagent` 工具）。
 */

import {
  type TimelineAttachment,
  type TimelineToolContent,
  type TimelineToolKind,
  type TimelineToolLocation,
  type ToolPatch,
  toolContentOf,
  toolInputSummary,
} from "@armadra/shared";

import { usable } from "../../history/claude";
import { locateHistory } from "../../history/registry";
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
  [/^(bash|bashoutput|killshell|killbash)$/i, "execute"],
  [/^(read|notebookread)$/i, "read"],
  [/^(edit|multiedit|write|notebookedit)$/i, "edit"],
  [/^(grep|glob|ls|toolsearch|websearch)$/i, "search"],
  [/^webfetch$/i, "fetch"],
  [/^(task|agent)$/i, "subagent"],
  [/^exitplanmode$/i, "switch_mode"],
];

export function claudeToolKind(name: string): TimelineToolKind {
  return kindByName(name, KIND_TABLE);
}

/** 计划工具：转成 `plan` 条目，不留工具行。 */
const PLAN_TOOL = /^todowrite$/i;

const INTERRUPT = /^\[Request interrupted by user/;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function toolTitle(name: string, input: Json | undefined): string {
  const description = str(input?.description);
  const command = str(input?.command);
  const path = str(input?.file_path) ?? str(input?.notebook_path);
  const pattern = str(input?.pattern) ?? str(input?.query);
  const url = str(input?.url);
  if (/^bash$/i.test(name)) {
    return firstLine(description ?? command ?? name, 160);
  }
  if (/^(task|agent)$/i.test(name)) {
    return firstLine(description ?? str(input?.prompt) ?? name, 160);
  }
  const target = path ?? pattern ?? url;
  if (target !== undefined) return `${name} ${firstLine(target, 160)}`;
  if (description !== undefined) return firstLine(description, 160);
  return name;
}

function locationsOf(input: Json | undefined): TimelineToolLocation[] {
  const path = str(input?.file_path) ?? str(input?.notebook_path);
  if (path === undefined) return [];
  const line = num(input?.line) ?? num(input?.offset);
  return [{ path, ...(line !== undefined ? { line } : {}) }];
}

function blocksOf(content: unknown): Json[] {
  if (!Array.isArray(content)) return [];
  const out: Json[] = [];
  for (const block of content) {
    const o = obj(block);
    if (o !== undefined) out.push(o);
  }
  return out;
}

/** `tool_result.content`（字符串或块数组）里的纯文本。 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of blocksOf(content)) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function plansOf(input: Json | undefined) {
  const todos = input?.todos;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((entry) => {
    const o = obj(entry);
    const content = str(o?.content) ?? str(o?.activeForm);
    if (o === undefined || content === undefined) return [];
    const status = str(o.status);
    return [{ content, ...(status !== undefined ? { status } : {}) }];
  });
}

/* --------------------------------- 用户 --------------------------------- */

function handleUser(record: Json, sink: TimelineSink): void {
  if (record.isSidechain === true) return;
  const message = obj(record.message);
  const content = message?.content;
  const uuid = str(record.uuid) ?? "";
  const at = timeOf(record.timestamp, Date.now());
  const texts: string[] = [];
  const attachments: TimelineAttachment[] = [];

  if (typeof content === "string") {
    texts.push(content);
  } else {
    for (const block of blocksOf(content)) {
      if (block.type === "tool_result") {
        handleToolResult(block, record, sink, at);
      } else if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block.type === "image") {
        const source = obj(block.source);
        const data = str(source?.data);
        const mimeType = str(source?.media_type) ?? "image/png";
        if (data !== undefined) {
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
  }
  if (record.isMeta === true || record.isCompactSummary === true) return;
  const joined = texts.join("\n").replace(REMINDER, "").trim();
  if (joined === "" && attachments.length === 0) return;
  if (INTERRUPT.test(joined)) {
    sink.endTurn(at, { stopReason: "cancelled" });
    return;
  }
  const text = usable(joined);
  if (text === undefined && attachments.length === 0) return;
  sink.beginTurn(`cc:${uuid}`, at, {
    text: text ?? "",
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}

/* --------------------------------- 助手 --------------------------------- */

function stopReasonOf(reason: unknown): string | undefined {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return undefined;
  }
}

function handleAssistant(record: Json, sink: TimelineSink): void {
  if (record.isSidechain === true) return;
  const message = obj(record.message);
  if (message === undefined) return;
  const uuid = str(record.uuid) ?? str(message.id) ?? "";
  const at = timeOf(record.timestamp, Date.now());
  const turn = sink.turnForContent(at, `cc:${uuid}`);
  const blocks = blocksOf(message.content);

  if (record.isApiErrorMessage === true) {
    const text = blocks
      .map((block) => str(block.text) ?? "")
      .join(" ")
      .trim();
    sink.notice(turn, `n:${uuid}`, at, "error", {
      message: text.slice(0, 500),
    });
  } else {
    blocks.forEach((block, index) => {
      switch (block.type) {
        case "text": {
          const text = str(block.text) ?? "";
          if (text.trim() === "") return;
          sink.assistant(turn, `a:${uuid}:${index}`, at, [
            { type: "text", text },
          ]);
          return;
        }
        case "thinking":
          sink.thought(
            turn,
            `th:${uuid}:${index}`,
            at,
            str(block.thinking) ?? "",
          );
          return;
        case "tool_use":
          handleToolUse(block, sink, turn, at);
          return;
        default:
      }
    });
  }

  const usage = obj(message.usage);
  if (usage !== undefined && record.isApiErrorMessage !== true) {
    const used =
      (num(usage.input_tokens) ?? 0) +
      (num(usage.cache_read_input_tokens) ?? 0) +
      (num(usage.cache_creation_input_tokens) ?? 0);
    if (used > 0) {
      // 转录里不带窗口大小：模型名没写 [1m] 时按 200k，已经超过它就一定是 1M 窗口。
      const size = Math.max(
        windowOf(str(message.model)),
        used > 200_000 ? 1_000_000 : 0,
      );
      sink.usage({ used, size });
    }
  }

  const stop = stopReasonOf(message.stop_reason);
  if (stop !== undefined) {
    const head = sink.usageNow();
    sink.endTurn(at, {
      stopReason: stop,
      ...(head !== undefined ? { usage: head } : {}),
    });
  }
}

/* --------------------------------- 工具 --------------------------------- */

function handleToolUse(
  block: Json,
  sink: TimelineSink,
  turn: ReturnType<TimelineSink["turnForContent"]>,
  at: number,
): void {
  const id = str(block.id);
  const name = str(block.name) ?? "tool";
  if (id === undefined) return;
  const input = obj(block.input);
  if (PLAN_TOOL.test(name)) {
    const entries = plansOf(input);
    if (entries.length > 0) sink.plan(turn, at, entries);
    return;
  }
  const patch: ToolPatch = {
    toolKind: claudeToolKind(name),
    title: toolTitle(name, input),
    status: "in_progress",
    locations: locationsOf(input),
  };
  const summary = input === undefined ? undefined : toolInputSummary(input);
  if (summary !== undefined) patch.input = summary;
  sink.upsertTool(turn, id, at, patch, { create: true });
}

/** `Exit code 1\n…`：Claude 把失败的 Bash 的退出码写在结果文本开头。 */
function exitCodeOf(text: string): number | undefined {
  const match = /^Exit code (\d+)/.exec(text);
  return match === null ? undefined : Number(match[1]);
}

function patchDiff(
  result: Json,
  ctx: ReturnType<TimelineSink["blobContext"]>,
): TimelineToolContent | null {
  const path = str(result.filePath);
  if (path === undefined) return null;
  const hunks = Array.isArray(result.structuredPatch)
    ? result.structuredPatch
    : [];
  if (hunks.length === 0) {
    if (result.type === "create" && typeof result.content === "string") {
      return diffContent(path, null, result.content, ctx);
    }
    return null;
  }
  const olds: string[] = [];
  const news: string[] = [];
  for (const hunk of hunks) {
    const lines = obj(hunk)?.lines;
    if (!Array.isArray(lines)) continue;
    const sides = sidesOfLines(
      lines.filter((l): l is string => typeof l === "string"),
    );
    olds.push(sides.oldText);
    news.push(sides.newText);
  }
  return diffContent(
    path,
    result.type === "create" ? null : olds.join("\n"),
    news.join("\n"),
    ctx,
  );
}

function handleToolResult(
  block: Json,
  record: Json,
  sink: TimelineSink,
  at: number,
): void {
  const id = str(block.tool_use_id);
  if (id === undefined) return;
  const existing = sink.tool(id);
  if (existing === undefined) return;
  const turn = sink.latestTurn();
  if (turn === undefined) return;
  const ctx = sink.blobContext(at);
  const result = obj(record.toolUseResult);
  const isError = block.is_error === true;
  const text = resultText(block.content);
  let content: TimelineToolContent[] = [];
  let status: "completed" | "failed" | "cancelled" = isError
    ? "failed"
    : "completed";

  if (result !== undefined && Array.isArray(result.structuredPatch)) {
    const diff = patchDiff(result, ctx);
    content = diff === null ? textContent(text) : [diff];
  } else if (result !== undefined && typeof result.stdout === "string") {
    const stderr = str(result.stderr) ?? "";
    const output = [result.stdout, stderr].filter((s) => s !== "").join("\n");
    content = [
      terminalContent({
        terminalId: id,
        command: existing.input?.command,
        output: output === "" && isError ? text : output,
        ...(isError ? { exitCode: exitCodeOf(text) ?? 1 } : { exitCode: 0 }),
      }),
    ];
    if (result.interrupted === true) status = "cancelled";
  } else if (existing.toolKind === "execute") {
    // 失败的命令：结果只剩一段「Exit code N」文本。
    content = [
      terminalContent({
        terminalId: id,
        command: existing.input?.command,
        output: text.replace(/^Exit code \d+\n?/, ""),
        ...(isError ? { exitCode: exitCodeOf(text) ?? 1 } : {}),
      }),
    ];
  } else if (result !== undefined && result.type === "create") {
    const diff = patchDiff(result, ctx);
    content = diff === null ? textContent(text) : [diff];
  } else {
    for (const part of blocksOf(block.content)) {
      if (part.type === "image") {
        const source = obj(part.source);
        const converted = toolContentOf(
          {
            type: "content",
            content: {
              type: "image",
              data: str(source?.data) ?? "",
              mimeType: str(source?.media_type) ?? "image/png",
            },
          },
          ctx,
        );
        if (converted !== null) content.push(converted);
      }
    }
    content = [...textContent(text), ...content];
  }
  sink.upsertTool(turn, id, timeOf(record.timestamp, at), { status, content });
}

/* --------------------------------- 入口 --------------------------------- */

function convert(value: unknown, sink: TimelineSink): void {
  const record = obj(value);
  if (record === undefined) return;
  switch (record.type) {
    case "user":
      handleUser(record, sink);
      return;
    case "assistant":
      handleAssistant(record, sink);
      return;
    case "custom-title": {
      const title = str(record.customTitle);
      if (title !== undefined) sink.title(title);
      return;
    }
    case "agent-name": {
      const title = str(record.agentName);
      if (title !== undefined) sink.title(title);
      return;
    }
    case "system":
      if (record.subtype === "compact_boundary") {
        const at = timeOf(record.timestamp, Date.now());
        const uuid = str(record.uuid) ?? `${at}`;
        sink.notice(
          sink.turnForContent(at, `cc:${uuid}`),
          `n:${uuid}`,
          at,
          "compacted",
        );
      }
      return;
    default:
  }
}

export const claudeAdapter: TranscriptAdapter = {
  agentId: "claude",
  locate: (hint: SessionHint) => locateHistory(hint)?.path,
  convert,
  toolKind: claudeToolKind,
};
