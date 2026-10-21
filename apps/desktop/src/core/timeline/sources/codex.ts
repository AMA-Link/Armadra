/**
 * Codex 转录 → 时间线（设计 §5.2）。
 *
 * 文件：`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<时间>-<会话 id>.jsonl`。每行
 * `{ timestamp, type, payload }`，用到的几种：
 *
 *   * `event_msg:task_started / task_complete / turn_aborted`：回合边界（`turn_id`）；
 *   * `event_msg:user_message` 或 `item_completed(UserMessage)`：用户的话（两种版本
 *     各写一种，哪个先到用哪个，重复的忽略）；
 *   * `response_item:message`（assistant）→ 助手文本；`reasoning` 的摘要文本 → 思考；
 *   * `function_call` / `custom_tool_call` / `local_shell_call` 及 `*_output` → 工具，
 *     `apply_patch` 的补丁解析成 diff，`update_plan` → 计划；
 *   * `event_msg:token_count` → 用量。
 *
 * 拿不到：加密的推理正文（`reasoning` 只有 `encrypted_content` 的不建条目）；审批
 * （hook 没有审批请求事件，只能在终端里答）；逐 token 的流。
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
import { parseApplyPatch } from "./patch";
import type { TimelineSink } from "./sink";
import type { TranscriptAdapter } from "./types";

const KIND_TABLE: ReadonlyArray<readonly [RegExp, TimelineToolKind]> = [
  [
    /^(shell|shell_command|exec_command|container\.exec|local_shell|exec|bash)$/i,
    "execute",
  ],
  [/^apply_patch$/i, "edit"],
  [/^(view_image|read_file)$/i, "read"],
  [/^(web_search|grep|search)/i, "search"],
  [/^(web_fetch|fetch)/i, "fetch"],
];

export function codexToolKind(name: string): TimelineToolKind {
  return kindByName(name, KIND_TABLE);
}

/** 引用外部上下文、不是用户键入的消息前缀。 */
const INJECTED = /^\s*(<environment_context>|<user_instructions>|# AGENTS\.md)/;

function jsonOf(text: unknown): Json | undefined {
  if (typeof text !== "string") return obj(text);
  try {
    return obj(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/* ------------------------------ 命令与输出 ------------------------------ */

function commandOf(args: Json | undefined): string | undefined {
  if (args === undefined) return undefined;
  const raw = args.cmd ?? args.command ?? args.script;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts = raw.filter((p): p is string => typeof p === "string");
    if (parts.length >= 3 && /^-l?c$/.test(parts[1] ?? "")) {
      return parts[2];
    }
    return parts.join(" ");
  }
  return undefined;
}

/** 桌面端的 `exec` 自定义工具：入参是一段脚本，命令在 `cmd: "…"` 里。 */
function commandFromScript(input: string): string {
  const match = /cmd:\s*("(?:[^"\\]|\\.)*")/.exec(input);
  if (match !== null) {
    try {
      const value: unknown = JSON.parse(match[1] as string);
      if (typeof value === "string") return value;
    } catch {
      // 落到下面
    }
  }
  return input.trim();
}

interface ToolOutput {
  readonly text: string;
  readonly exitCode?: number;
}

/** 输出可能是字符串、`input_text` 块数组、或带 `output` / `exit_code` 的 JSON。 */
function outputOf(raw: unknown): ToolOutput {
  const pieces: string[] = [];
  if (typeof raw === "string") pieces.push(raw);
  else if (Array.isArray(raw)) {
    for (const part of raw) {
      const text = str(obj(part)?.text);
      if (text !== undefined) pieces.push(text);
    }
  } else {
    const o = obj(raw);
    if (o !== undefined) pieces.push(JSON.stringify(o));
  }
  let exitCode: number | undefined;
  const kept: string[] = [];
  for (const piece of pieces) {
    const parsed = jsonOf(piece);
    if (
      parsed !== undefined &&
      (parsed.output !== undefined || parsed.exit_code !== undefined)
    ) {
      const meta = obj(parsed.metadata);
      exitCode = num(parsed.exit_code) ?? num(meta?.exit_code) ?? exitCode;
      const out = parsed.output;
      kept.push(typeof out === "string" ? out : "");
      continue;
    }
    // 旧格式：`Exit code: 0\nWall time: 0.1 seconds\nOutput:\n…`
    const header = /^Exit code: (-?\d+)\nWall time: [^\n]*\nOutput:\n?/.exec(
      piece,
    );
    if (header !== null) {
      exitCode = Number(header[1]);
      kept.push(piece.slice(header[0].length));
      continue;
    }
    // 桌面端的外壳行：`Script completed\nWall time 0.1 seconds\nOutput:\n`
    if (
      /^Script (completed|failed)\nWall time [^\n]*\nOutput:\n?$/.test(piece)
    ) {
      continue;
    }
    kept.push(piece);
  }
  const text = kept.join("\n");
  return exitCode === undefined ? { text } : { text, exitCode };
}

/* ---------------------------------- 工具 ---------------------------------- */

function startTool(
  sink: TimelineSink,
  at: number,
  callId: string,
  name: string,
  argsText: unknown,
  kind: "function" | "custom" | "shell",
  shellCommand?: string,
): void {
  const turn = sink.turnForContent(at, `cx:${callId}`);
  const args = kind === "custom" ? undefined : jsonOf(argsText);
  const text = typeof argsText === "string" ? argsText : "";

  if (/^update_plan$/i.test(name)) {
    const plan = args?.plan;
    if (Array.isArray(plan)) {
      const entries = plan.flatMap((entry) => {
        const o = obj(entry);
        const content = str(o?.step);
        if (o === undefined || content === undefined) return [];
        const status = str(o.status);
        return [{ content, ...(status !== undefined ? { status } : {}) }];
      });
      if (entries.length > 0) sink.plan(turn, at, entries);
    }
    return;
  }

  if (/^apply_patch$/i.test(name)) {
    const patchText =
      kind === "custom" ? text : (str(args?.input) ?? str(args?.patch) ?? text);
    const files = parseApplyPatch(patchText);
    const ctx = sink.blobContext(at);
    const content: TimelineToolContent[] = [];
    for (const file of files.slice(0, 8)) {
      if (file.op === "delete") continue;
      const diff = diffContent(
        file.movedTo ?? file.path,
        file.oldText,
        file.newText,
        ctx,
      );
      if (diff !== null) content.push(diff);
    }
    const allDelete = files.length > 0 && files.every((f) => f.op === "delete");
    const moved = files.some((f) => f.movedTo !== undefined);
    const names = files.map((f) => f.path.split("/").pop() ?? f.path);
    const patch: ToolPatch = {
      toolKind: allDelete ? "delete" : moved ? "move" : "edit",
      title:
        names.length === 0
          ? "apply_patch"
          : `Edit ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`,
      status: "in_progress",
      locations: files.map((f) => ({ path: f.movedTo ?? f.path })),
      content,
    };
    sink.upsertTool(turn, callId, at, patch, { create: true });
    return;
  }

  let command: string | undefined = shellCommand;
  if (command === undefined && kind === "custom")
    command = commandFromScript(text);
  if (command === undefined) command = commandOf(args);
  const toolKind = codexToolKind(name);
  const patch: ToolPatch = {
    toolKind,
    title:
      toolKind === "execute" && command !== undefined
        ? firstLine(command, 160)
        : name,
    status: "in_progress",
    locations: [],
  };
  if (toolKind === "execute" && command !== undefined) {
    patch.input = { command: command.slice(0, 10_000) };
  } else if (args !== undefined) {
    const summary = toolInputSummary(args);
    if (summary !== undefined) patch.input = summary;
  }
  sink.upsertTool(turn, callId, at, patch, { create: true });
}

function finishTool(
  sink: TimelineSink,
  at: number,
  callId: string,
  raw: unknown,
): void {
  const existing = sink.tool(callId);
  const turn = sink.latestTurn();
  if (existing === undefined || turn === undefined) return;
  const out = outputOf(raw);
  const failedExit = out.exitCode !== undefined && out.exitCode !== 0;
  if (existing.toolKind === "execute") {
    sink.upsertTool(turn, callId, at, {
      status: failedExit ? "failed" : "completed",
      content: [
        terminalContent({
          terminalId: callId,
          command: existing.input?.command,
          output: out.text,
          ...(out.exitCode !== undefined ? { exitCode: out.exitCode } : {}),
        }),
      ],
    });
    return;
  }
  const failed =
    failedExit || /^apply_patch verification failed/i.test(out.text);
  const content: TimelineToolContent[] =
    existing.toolKind === "edit" && !failed
      ? existing.content
      : [...existing.content, ...textContent(out.text)];
  sink.upsertTool(turn, callId, at, {
    status: failed ? "failed" : "completed",
    content,
  });
}

/* ---------------------------------- 回合 ---------------------------------- */

function userText(
  sink: TimelineSink,
  at: number,
  text: string,
  key: string,
): void {
  const trimmed = text.trim();
  if (trimmed === "" || INJECTED.test(trimmed)) return;
  const latest = sink.latestTurn();
  if (latest === undefined || latest.endedAt !== undefined) {
    sink.beginTurn(`cx:u:${key}`, at, { text: trimmed });
    return;
  }
  sink.addUserToTurn(latest, at, trimmed, key);
}

function handleEvent(record: Json, payload: Json, sink: TimelineSink): void {
  const at = timeOf(record.timestamp, Date.now());
  switch (payload.type) {
    case "task_started": {
      const id = str(payload.turn_id);
      if (id !== undefined) sink.beginTurn(`cx:${id}`, at);
      return;
    }
    case "task_complete": {
      const usage = sink.usageNow();
      sink.endTurn(at, {
        stopReason: "end_turn",
        ...(usage !== undefined ? { usage } : {}),
      });
      return;
    }
    case "turn_aborted":
      sink.endTurn(at, { stopReason: "cancelled" });
      return;
    case "user_message": {
      const text = str(payload.message);
      if (text !== undefined)
        userText(sink, at, text, `${record.ordinal ?? at}`);
      return;
    }
    case "item_completed": {
      const item = obj(payload.item);
      if (item?.type !== "UserMessage") return;
      const parts = Array.isArray(item.content) ? item.content : [];
      const text = parts.map((part) => str(obj(part)?.text) ?? "").join("\n");
      userText(sink, at, text, str(item.id) ?? `${record.ordinal ?? at}`);
      return;
    }
    case "token_count": {
      const info = obj(payload.info);
      const last = obj(info?.last_token_usage);
      if (last === undefined) return;
      const used = num(last.input_tokens) ?? 0;
      if (used <= 0) return;
      sink.usage({ used, size: num(info?.model_context_window) ?? 258_400 });
      return;
    }
    case "thread_name_updated": {
      const name = str(payload.thread_name);
      if (name !== undefined) sink.title(name);
      return;
    }
    default:
  }
}

function handleResponse(record: Json, payload: Json, sink: TimelineSink): void {
  const at = timeOf(record.timestamp, Date.now());
  const key = str(payload.id) ?? `o${record.ordinal ?? at}`;
  switch (payload.type) {
    case "message": {
      if (payload.role !== "assistant") return;
      const parts = Array.isArray(payload.content) ? payload.content : [];
      const text = parts
        .map((part) => str(obj(part)?.text) ?? "")
        .join("")
        .trim();
      if (text === "") return;
      const turn = sink.turnForContent(at, `cx:${key}`);
      sink.assistant(turn, `a:${key}`, at, [{ type: "text", text }]);
      return;
    }
    case "reasoning": {
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      const text = summary
        .map((part) => str(obj(part)?.text) ?? "")
        .filter((t) => t !== "")
        .join("\n\n");
      if (text === "") return;
      const turn = sink.turnForContent(at, `cx:${key}`);
      sink.thought(turn, `th:${key}`, at, text);
      return;
    }
    case "function_call": {
      const callId = str(payload.call_id);
      const name = str(payload.name);
      if (callId === undefined || name === undefined) return;
      const namespace = str(payload.namespace);
      startTool(
        sink,
        at,
        callId,
        namespace !== undefined ? `${namespace}.${name}` : name,
        payload.arguments,
        "function",
      );
      return;
    }
    case "custom_tool_call": {
      const callId = str(payload.call_id);
      const name = str(payload.name);
      if (callId === undefined || name === undefined) return;
      startTool(sink, at, callId, name, payload.input, "custom");
      return;
    }
    case "local_shell_call": {
      const callId = str(payload.call_id) ?? str(payload.id);
      if (callId === undefined) return;
      const command = commandOf(obj(payload.action));
      startTool(sink, at, callId, "shell", "", "shell", command);
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const callId = str(payload.call_id);
      if (callId !== undefined) finishTool(sink, at, callId, payload.output);
      return;
    }
    case "web_search_call": {
      const action = obj(payload.action);
      const query = str(action?.query);
      const turn = sink.turnForContent(at, `cx:${key}`);
      sink.upsertTool(
        turn,
        `ws:${key}`,
        at,
        {
          toolKind: "search",
          title:
            query !== undefined
              ? `Search ${firstLine(query, 160)}`
              : "web_search",
          status: "completed",
          locations: [],
          ...(query !== undefined ? { input: { query } } : {}),
        },
        { create: true },
      );
      return;
    }
    default:
  }
}

function convert(value: unknown, sink: TimelineSink): void {
  const record = obj(value);
  const payload = obj(record?.payload);
  if (record === undefined || payload === undefined) return;
  if (record.type === "event_msg") handleEvent(record, payload, sink);
  else if (record.type === "response_item")
    handleResponse(record, payload, sink);
}

export const codexAdapter: TranscriptAdapter = {
  agentId: "codex",
  locate: (hint: SessionHint) => locateHistory(hint)?.path,
  convert,
  toolKind: codexToolKind,
};
