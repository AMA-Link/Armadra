/**
 * GitHub Copilot CLI 转录 → 时间线（设计 §5.2）。
 *
 * 文件：`${COPILOT_HOME:-~/.copilot}/session-state/<会话 id>/events.jsonl`，会话 id
 * 由 hook 报来（目录名就是它）。每行一个事件 `{type, data, id, timestamp, parentId}`，
 * 用到的几种：
 *
 *   * `user.message`：`data.content` 是用户键入的原文（`transformedContent` 是塞过
 *     上下文的版本，不用）→ 开回合；
 *   * `assistant.message`：`content` 文本、`reasoningText` 思考、`toolRequests` 工具请求；
 *     `parentToolCallId` 有值的是子代理内部的消息，跳过；
 *   * `tool.execution_start` / `tool.execution_complete`：工具的开始（带参数）和结果
 *     （`success`、`result.content`、`error.message`）；
 *   * `session.usage_record`：逐请求的 token → 用量（`maxPromptTokens` 是窗口）；
 *   * `abort` → 回合已取消；`session.compaction_complete` → 压缩边界提示。
 *
 * 条目 id 用 CLI 自己的：消息 `a:<messageId>` / `th:<messageId>`，工具 `toolCallId`。
 *
 * 能拿到：用户文本；助手文本；思考（`reasoningText`，只有加密块时没有）；工具及其
 * 结果：`bash` 的输出和退出码（结果末尾 `<exited with exit code N>`）、`edit` 的
 * `old_str / new_str` 与 `create` 的 `file_text` 转 diff、其余工具的文本；窗口大小与
 * 用量。工具请求在 `assistant.message` 里就出现，所以开始时刻比 hook 早（hook 没有
 * PreToolUse）。
 *
 * 拿不到：逐 token 的流；标题（在 `workspace.yaml`，不在事件里）；子代理内部的调用；
 * 回合的正常结束（没有「回合完成」事件，靠 `agentStop` hook 合上，`abort` 例外）；
 * 用户消息的附件；`report_intent` 之类只给界面看的工具不显示。
 */

import {
  type TimelineToolContent,
  type TimelineToolKind,
  type ToolPatch,
  toolInputSummary,
} from "@armadra/shared";

import { locateHistory } from "../../history/registry";
import type { SessionHint } from "../../history/types";
import {
  type Json,
  diffContent,
  firstLine,
  kindByName,
  num,
  obj,
  str,
  terminalContent,
  textContent,
  timeOf,
} from "./convert-util";
import type { TimelineSink } from "./sink";
import type { TranscriptAdapter } from "./types";

const KIND_TABLE: ReadonlyArray<readonly [RegExp, TimelineToolKind]> = [
  [/^(bash|read_bash|write_bash|stop_bash|powershell)$/i, "execute"],
  [/^(view|read)$/i, "read"],
  [/^(edit|create|str_replace|write)$/i, "edit"],
  [/^(grep|glob|search|web_search|rg)$/i, "search"],
  [/^(web_fetch|fetch)$/i, "fetch"],
  [/^(task|agent)$/i, "subagent"],
];

export function copilotToolKind(name: string): TimelineToolKind {
  return kindByName(name, KIND_TABLE);
}

/** 只给界面看的工具，不进时间线。 */
const HIDDEN_TOOL = /^report_intent$/i;

function titleOf(name: string, args: Json | undefined): string {
  const description = str(args?.description);
  const command = str(args?.command);
  if (/^bash$/i.test(name))
    return firstLine(description ?? command ?? name, 160);
  if (/^task$/i.test(name)) {
    return firstLine(description ?? str(args?.name) ?? name, 160);
  }
  const target =
    str(args?.path) ?? str(args?.pattern) ?? str(args?.query) ?? str(args?.url);
  return target === undefined ? name : `${name} ${firstLine(target, 160)}`;
}

function startTool(
  sink: TimelineSink,
  turn: ReturnType<TimelineSink["turnForContent"]>,
  at: number,
  toolCallId: string,
  name: string,
  args: Json | undefined,
): void {
  if (HIDDEN_TOOL.test(name)) return;
  const kind = copilotToolKind(name);
  const patch: ToolPatch = {
    toolKind: kind,
    title: titleOf(name, args),
    status: "in_progress",
    locations: [],
  };
  const summary = args === undefined ? undefined : toolInputSummary(args);
  if (summary !== undefined) patch.input = summary;
  const path = str(args?.path);
  if (path !== undefined) patch.locations = [{ path }];
  if (kind === "edit" && path !== undefined) {
    const ctx = sink.blobContext(at);
    const created = str(args?.file_text);
    const before = str(args?.old_str);
    const after = str(args?.new_str);
    const diff =
      created !== undefined
        ? diffContent(path, null, created, ctx)
        : before !== undefined && after !== undefined
          ? diffContent(path, before === "" ? null : before, after, ctx)
          : null;
    if (diff !== null) patch.content = [diff];
  }
  sink.upsertTool(turn, toolCallId, at, patch, { create: true });
}

function finishTool(sink: TimelineSink, data: Json, at: number): void {
  const id = str(data.toolCallId);
  if (id === undefined) return;
  const existing = sink.tool(id);
  const turn = sink.latestTurn();
  if (existing === undefined || turn === undefined) return;
  const success = data.success !== false;
  const result = obj(data.result);
  const text = str(result?.content) ?? "";
  const errorText = str(obj(data.error)?.message) ?? "";

  if (existing.toolKind === "execute") {
    const trailer = /\n*<exited with exit code (-?\d+)>\s*$/.exec(text);
    const exitCode = trailer !== null ? Number(trailer[1]) : undefined;
    sink.upsertTool(turn, id, at, {
      status:
        !success || (exitCode !== undefined && exitCode !== 0)
          ? "failed"
          : "completed",
      content: [
        terminalContent({
          terminalId: id,
          command: existing.input?.command,
          output: success
            ? trailer !== null
              ? text.slice(0, trailer.index)
              : text
            : errorText,
          ...(exitCode !== undefined ? { exitCode } : {}),
        }),
      ],
    });
    return;
  }
  let content: TimelineToolContent[];
  if (!success) content = [...existing.content, ...textContent(errorText)];
  else if (existing.toolKind === "edit" && existing.content.length > 0) {
    content = existing.content;
  } else content = textContent(text);
  sink.upsertTool(turn, id, at, {
    status: success ? "completed" : "failed",
    content,
  });
}

function handleAssistant(
  record: Json,
  data: Json,
  at: number,
  sink: TimelineSink,
): void {
  if (typeof data.parentToolCallId === "string") return;
  const id = str(data.messageId) ?? str(record.id) ?? `${at}`;
  const turn = sink.turnForContent(at, `cp:${id}`);
  const reasoning = str(data.reasoningText);
  if (reasoning !== undefined && reasoning.trim() !== "") {
    sink.thought(turn, `th:${id}`, at, reasoning);
  }
  const text = str(data.content) ?? "";
  if (text.trim() !== "") {
    sink.assistant(turn, `a:${id}`, at, [{ type: "text", text }]);
  }
  const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
  for (const item of requests) {
    const request = obj(item);
    const toolCallId = str(request?.toolCallId);
    const name = str(request?.name);
    if (
      request === undefined ||
      toolCallId === undefined ||
      name === undefined
    ) {
      continue;
    }
    startTool(sink, turn, at, toolCallId, name, obj(request.arguments));
  }
}

function convert(value: unknown, sink: TimelineSink): void {
  const record = obj(value);
  const data = obj(record?.data);
  if (record === undefined || data === undefined) return;
  const at = timeOf(record.timestamp, Date.now());
  switch (record.type) {
    case "user.message": {
      const text = (str(data.content) ?? "").trim();
      if (text === "") return;
      sink.beginTurn(`cp:${str(record.id) ?? at}`, at, { text });
      return;
    }
    case "assistant.message":
      handleAssistant(record, data, at, sink);
      return;
    case "tool.execution_start": {
      if (typeof data.parentToolCallId === "string") return;
      const toolCallId = str(data.toolCallId);
      const name = str(data.toolName);
      if (toolCallId === undefined || name === undefined) return;
      startTool(
        sink,
        sink.turnForContent(at, `cp:${toolCallId}`),
        at,
        toolCallId,
        name,
        obj(data.arguments),
      );
      return;
    }
    case "tool.execution_complete":
      if (typeof data.parentToolCallId === "string") return;
      finishTool(sink, data, at);
      return;
    case "session.usage_record": {
      const usage = obj(data.usage);
      const used = num(usage?.inputTokens) ?? 0;
      if (used > 0) {
        sink.usage({ used, size: num(usage?.maxPromptTokens) ?? 128_000 });
      }
      return;
    }
    case "abort":
      sink.endTurn(at, { stopReason: "cancelled" });
      return;
    case "session.compaction_complete":
      if (data.success === false) return;
      sink.notice(
        sink.turnForContent(at, `cp:${str(record.id) ?? at}`),
        `n:${str(record.id) ?? at}`,
        at,
        "compacted",
      );
      return;
    default:
  }
}

export const copilotTranscript: TranscriptAdapter = {
  agentId: "copilot",
  locate: (hint: SessionHint) => locateHistory(hint)?.path,
  convert,
  toolKind: copilotToolKind,
};
