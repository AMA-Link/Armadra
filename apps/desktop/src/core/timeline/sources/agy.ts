/**
 * Antigravity CLI 转录 → 时间线（#1036，观察级：不写 `agent_status`、不进任何门）。
 *
 * 文件：`~/.gemini/antigravity-cli/brain/<会话 id>/.system_generated/logs/
 * transcript.jsonl`。终端里的 agy 没有 hook，会话 id 由 {@link discover} 经进程日志
 * （`history/agy-session.ts`）找到；ACP 驱动的 agy 走 `acp-mirror`，不经这里。
 *
 * 每行一个步骤（实测 1.5.16 的字段）：
 *
 *   * `USER_INPUT`：`content` 是 `<USER_REQUEST>…</USER_REQUEST>` 加一段元数据，取请求；
 *   * `PLANNER_RESPONSE`：模型一次响应，`thinking`、`content`（文本）、`tool_calls`
 *     （`[{ name, args }]`，`args` 的值是 JSON 字符串）、`input_tokens` 等。**没有
 *     `tool_calls` 的那条是这一回合的最终回答**，回合到这里结束；
 *   * `GENERIC`：上一批工具调用的结果，`content` 前几行是 `Created At:` / `Completed At:`
 *     时间戳，后面是结果正文；
 *   * `SYSTEM_MESSAGE`：系统提醒，不进时间线。
 *
 * 格式没有公开，所以一律「认得的转，认不得的略过」，永不抛错。条目 id 用
 * `created_at` 加步骤号：记录里没有会话 id，而 `/new` 之后步骤号会从 0 重来，所以
 * 只用步骤号会撞。工具调用没有 id，用 `<created_at>:<步骤号>:<第几个>`；结果按顺序
 * 配给同一回合里最早一个还没有结果的调用。
 *
 * 拿不到：逐 token 的流、上下文占用（窗口大小不在文件里）、标题。
 */

import {
  type TimelineToolKind,
  type ToolPatch,
  toolInputSummary,
} from "@armadra/shared";

import {
  type AgySessionDeps,
  AgySessionResolver,
  realAgySessionDeps,
  transcriptOf,
} from "../../history/agy-session";
import type { SessionHint } from "../../history/types";
import {
  type Json,
  firstLine,
  kindByName,
  obj,
  str,
  terminalContent,
  textContent,
  timeOf,
} from "./convert-util";
import type { TimelineSink } from "./sink";
import type { TranscriptAdapter } from "./types";

const KIND_TABLE: ReadonlyArray<readonly [RegExp, TimelineToolKind]> = [
  [/^(run_command|send_command_input|command_status)$/i, "execute"],
  [
    /^(read_file|view_file|view_file_outline|list_dir|read_url_content)$/i,
    "read",
  ],
  [
    /^(write_file|replace_file_content|multi_replace_file_content|edit|create_file)$/i,
    "edit",
  ],
  [/^(grep_search|find_by_name|codebase_search|search_web)$/i, "search"],
  [/^(read_browser_page|browser_.*|fetch.*)$/i, "fetch"],
  [/^(invoke_subagent|spawn_.*)$/i, "subagent"],
];

export function agyToolKind(name: string): TimelineToolKind {
  return kindByName(name, KIND_TABLE);
}

/** `USER_INPUT` 的 `content`：取 `<USER_REQUEST>` 里的请求，没有就整段。 */
export function userRequestOf(content: string): string {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  return (match?.[1] ?? content).trim();
}

/** `args` 的值是 JSON 字符串（`"\"pwd\""`）：能解就解，解不了留原样。 */
function unquote(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function argsOf(raw: unknown): Json {
  const source = obj(raw);
  const out: Json = {};
  if (source === undefined) return out;
  for (const [key, value] of Object.entries(source)) out[key] = unquote(value);
  return out;
}

/** `GENERIC` 的 `content`：去掉开头的 `Created At:` / `Completed At:` 行。 */
export function resultTextOf(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^(Created|Completed) At: /.test(line))
    .join("\n")
    .trim();
}

function toolTitle(name: string, args: Json): string {
  const summary = str(args.toolSummary);
  return firstLine(
    summary !== undefined && summary !== "" ? summary : name,
    160,
  );
}

function convert(value: unknown, sink: TimelineSink): void {
  const record = obj(value);
  if (record === undefined) return;
  const type = str(record.type);
  const step = record.step_index;
  if (
    type === undefined ||
    (typeof step !== "number" && typeof step !== "string")
  ) {
    return;
  }
  const at = timeOf(record.created_at, Date.now());
  const stamp = `${str(record.created_at) ?? "-"}:${step}`;
  switch (type) {
    case "USER_INPUT": {
      const text = userRequestOf(str(record.content) ?? "");
      if (text === "") return;
      sink.beginTurn(`ag:${stamp}`, at, { text });
      return;
    }
    case "PLANNER_RESPONSE": {
      const turn = sink.turnForContent(at, `ag:${stamp}`);
      const thinking = (str(record.thinking) ?? "").trim();
      if (thinking !== "") sink.thought(turn, `th:${stamp}`, at, thinking);
      const text = (str(record.content) ?? "").trim();
      if (text !== "") {
        sink.assistant(turn, `a:${stamp}`, at, [{ type: "text", text }]);
      }
      const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      calls.forEach((raw, index) => {
        const call = obj(raw);
        const name = str(call?.name);
        if (call === undefined || name === undefined) return;
        const args = argsOf(call.args);
        const patch: ToolPatch = {
          toolKind: agyToolKind(name),
          title: toolTitle(name, args),
          status: "in_progress",
          locations: [],
        };
        const input = toolInputSummary(args);
        if (input !== undefined) patch.input = input;
        sink.upsertTool(turn, `${stamp}:${index}`, at, patch, { create: true });
      });
      // 没有工具调用的响应是这一回合的最终回答。
      if (calls.length === 0 && (text !== "" || thinking !== "")) {
        sink.endTurn(at, { stopReason: "end_turn" });
      }
      return;
    }
    case "GENERIC": {
      const turn = sink.latestTurn();
      if (turn === undefined) return;
      const open = pendingTool(sink, turn.turn);
      if (open === undefined) return;
      const text = resultTextOf(str(record.content) ?? "");
      const exit = /Command exited with code (-?\d+)/.exec(text);
      const exitCode = exit === null ? undefined : Number(exit[1]);
      const output =
        text.split(/Command output:\n?/)[1]?.trim() ??
        (exit === null ? text : "");
      const patch: ToolPatch = {
        status:
          exitCode !== undefined && exitCode !== 0 ? "failed" : "completed",
        content:
          open.toolKind === "execute" && exit !== null
            ? [
                terminalContent({
                  terminalId: open.toolCallId,
                  command: open.input?.command,
                  output,
                  ...(exitCode !== undefined ? { exitCode } : {}),
                }),
              ]
            : textContent(text),
      };
      sink.upsertTool(turn, open.toolCallId, at, patch);
      return;
    }
    default:
    // SYSTEM_MESSAGE 与不认得的类型：不是对话内容。
  }
}

/** 这个回合里最早一个还没有结果的工具调用（`in_progress`）。 */
function pendingTool(sink: TimelineSink, turn: number) {
  const items = sink.itemsOfTurn(turn);
  let best: ReturnType<TimelineSink["tool"]>;
  for (const item of items) {
    if (item.kind !== "tool" || item.status !== "in_progress") continue;
    if (best === undefined || item.ord < best.ord) best = item;
  }
  return best;
}

/** 测试与装配：换掉进程与文件的读法。 */
export function agyTranscriptWith(
  deps: AgySessionDeps = realAgySessionDeps,
): TranscriptAdapter {
  const resolver = new AgySessionResolver(deps);
  return {
    agentId: "agy",
    locate: (hint: SessionHint) => {
      if (hint.transcriptPath !== undefined) return hint.transcriptPath;
      const dir = deps.stateDir();
      return hint.sessionId === undefined || dir === undefined
        ? undefined
        : transcriptOf(dir, hint.sessionId, deps.exists);
    },
    convert,
    toolKind: agyToolKind,
    discover: async (context) => {
      if (context.remote) return undefined;
      const found = await resolver.resolve(context.pid);
      return found === undefined
        ? undefined
        : { sessionId: found.sessionId, transcriptPath: found.transcriptPath };
    },
  };
}

export const agyTranscript: TranscriptAdapter = agyTranscriptWith();
