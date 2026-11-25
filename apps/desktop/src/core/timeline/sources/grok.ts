/**
 * Grok Build 转录 → 时间线（契约 §124）。
 *
 * 文件：`$GROK_HOME/sessions/<编码后的 cwd>/<会话 id>/updates.jsonl`，路径由 core 自己
 * 读状态时报来（`transcriptPath`，见 `hook/sources/grok-events.ts`），`/new`、`/resume`
 * 换会话时报新的，管理器据此重新定位；没报时按会话 id 在会话目录下找。每行一个 ACP
 * 形状的更新：
 *
 *   * `{ method: "session/update", params: { sessionId, update } }`，`update` 是
 *     `user_message_chunk`（带 `_meta.promptIndex`）、`agent_message_chunk`、
 *     `agent_thought_chunk`、`tool_call`、`tool_call_update`；
 *   * `{ method: "_x.ai/session/update", … }` 里 `turn_completed`（带 `stop_reason` 与
 *     本回合用量）合上回合；`hook_execution` 等是 grok 自己的机器活，不进时间线。
 *
 * 格式没有公开，所以一律「认得的转，认不得的略过」：缺字段的行跳过、未知的更新类型
 * 忽略、未知的工具按名字归类，永不抛错。条目 id：`_meta.eventId` 优先，没有退到
 * `timestamp_us`，再没有取整行内容的摘要（`a:` / `th:`），工具用 `toolCallId`；整行逐字重读（`/resume` 把旧会话文件接着写）
 * 得到同样的 id，写入是幂等的。
 *
 * 能拿到：用户文本、助手文本、思考、工具及其结果（命令的输出与退出码、编辑的 diff、
 * 其余工具的文本）、回合的结束与停止原因。拿不到：上下文占用（窗口大小不在文件里，
 * 回合用量是各次请求之和，不是窗口占用，所以不报 `usage`）；逐 token 的流；标题
 * （在 `summary.json`，经会话索引取）。
 */

import { basename } from "node:path";

import {
  type TimelineToolContent,
  type TimelineToolKind,
  type ToolPatch,
  toolInputSummary,
} from "@armadra/shared";

import { UPDATES_FILE, recordId, recordMs } from "../../history/grok";
import { locateHistory } from "../../history/registry";
import type { SessionHint } from "../../history/types";
import {
  type Json,
  diffContent,
  firstLine,
  kindByName,
  obj,
  str,
  terminalContent,
  textContent,
} from "./convert-util";
import type { TimelineSink } from "./sink";
import type { TranscriptAdapter } from "./types";

/** grok 自己给工具的分类（`_meta["x.ai/tool"].kind`）。 */
const META_KINDS: Readonly<Record<string, TimelineToolKind>> = {
  execute: "execute",
  edit: "edit",
  read: "read",
  list: "read",
  search: "search",
  fetch: "fetch",
};

const KIND_TABLE: ReadonlyArray<readonly [RegExp, TimelineToolKind]> = [
  [/^(run_terminal_command|bash|shell)$/i, "execute"],
  [/^(read_file|view|list_dir)$/i, "read"],
  [/^(search_replace|write_file|edit|create_file|apply_patch)$/i, "edit"],
  [/^(grep|glob|search|web_search)$/i, "search"],
  [/^(web_fetch|fetch)$/i, "fetch"],
  [/^(task|spawn_subagent)$/i, "subagent"],
];

export function grokToolKind(name: string): TimelineToolKind {
  return kindByName(name, KIND_TABLE);
}

function toolMeta(update: Json): Json | undefined {
  return obj(obj(update._meta)?.["x.ai/tool"]);
}

function kindOf(update: Json): TimelineToolKind {
  const meta = toolMeta(update);
  const byMeta = META_KINDS[str(meta?.kind) ?? ""];
  if (byMeta !== undefined) return byMeta;
  const name = str(meta?.name) ?? str(update.title) ?? "";
  return grokToolKind(name);
}

function textOf(content: unknown): string | undefined {
  const block = obj(content);
  return block?.type === "text" ? str(block.text) : undefined;
}

function titleOf(update: Json, fallback: string): string {
  const title = str(update.title);
  return title === undefined || title === "" ? fallback : firstLine(title, 160);
}

function startTool(
  sink: TimelineSink,
  update: Json,
  at: number,
  turn: ReturnType<TimelineSink["turnForContent"]>,
): void {
  const id = str(update.toolCallId);
  if (id === undefined) return;
  const name = str(toolMeta(update)?.name) ?? str(update.title) ?? "tool";
  const input = obj(update.rawInput);
  const patch: ToolPatch = {
    toolKind: kindOf(update),
    title: titleOf(update, name),
    status: "in_progress",
    locations: [],
  };
  const summary = input === undefined ? undefined : toolInputSummary(input);
  if (summary !== undefined) patch.input = summary;
  sink.upsertTool(turn, id, at, patch, { create: true });
}

function contentOf(
  update: Json,
  sink: TimelineSink,
  at: number,
): TimelineToolContent[] {
  const out: TimelineToolContent[] = [];
  if (!Array.isArray(update.content)) return out;
  for (const raw of update.content) {
    const block = obj(raw);
    if (block === undefined) continue;
    if (block.type === "diff") {
      const path = str(block.path);
      const next = str(block.newText);
      if (path === undefined || next === undefined) continue;
      const old = str(block.oldText);
      const diff = diffContent(
        path,
        old === undefined || old === "" ? null : old,
        next,
        sink.blobContext(at),
      );
      if (diff !== null) out.push(diff);
    } else if (block.type === "content") {
      const text = textOf(block.content);
      if (text !== undefined) out.push(...textContent(text));
    }
  }
  return out;
}

function updateTool(sink: TimelineSink, update: Json, at: number): void {
  const id = str(update.toolCallId);
  if (id === undefined) return;
  const turn = sink.latestTurn();
  const existing = sink.tool(id);
  if (turn === undefined) return;
  const status = str(update.status);
  const patch: ToolPatch = {};
  const title = str(update.title);
  if (title !== undefined && title !== "") patch.title = firstLine(title, 160);
  if (update.kind !== undefined || toolMeta(update) !== undefined) {
    patch.toolKind = kindOf(update);
  }
  if (Array.isArray(update.locations)) {
    patch.locations = update.locations.flatMap((entry) => {
      const path = str(obj(entry)?.path);
      return path === undefined ? [] : [{ path }];
    });
  }
  const raw = obj(update.rawOutput);
  const kind = patch.toolKind ?? existing?.toolKind;
  if (status === "completed" || status === "failed") {
    const exitCode =
      typeof raw?.exit_code === "number" ? raw.exit_code : undefined;
    patch.status =
      status === "failed" || (exitCode !== undefined && exitCode !== 0)
        ? "failed"
        : "completed";
    if (kind === "execute" && raw !== undefined) {
      const output =
        str(raw.output_for_prompt)?.replace(/^exit: -?\d+\n?/, "") ??
        contentText(update) ??
        "";
      patch.content = [
        terminalContent({
          terminalId: id,
          command: str(raw.command) ?? existing?.input?.command,
          output,
          ...(exitCode !== undefined ? { exitCode } : {}),
        }),
      ];
    } else {
      const content = contentOf(update, sink, at);
      if (content.length > 0) patch.content = content;
    }
  } else if (status === undefined || status === "in_progress") {
    // 开始后补全标题 / 编辑的 diff（还没有结果）。
    const content = contentOf(update, sink, at);
    if (content.length > 0 && kind === "edit") patch.content = content;
  }
  sink.upsertTool(turn, id, at, patch);
}

function contentText(update: Json): string | undefined {
  if (!Array.isArray(update.content)) return undefined;
  for (const raw of update.content) {
    const block = obj(raw);
    if (block?.type === "content") {
      const text = textOf(block.content);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

function stopReasonOf(reason: unknown): string | undefined {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "cancelled":
      return "cancelled";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return undefined;
  }
}

function convert(value: unknown, sink: TimelineSink): void {
  const record = obj(value);
  const params = obj(record?.params);
  const update = obj(params?.update);
  if (record === undefined || params === undefined || update === undefined) {
    return;
  }
  // 时间与 id 优先用行里 `_meta` 自带的（老版本的会话没有 `timestamp_us`）。
  const at = recordMs(record) ?? Date.now();
  const stamp = recordId(record);
  const session = str(params.sessionId) ?? "";
  const prefix = `gk:${session}:`;
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const text = (textOf(update.content) ?? "").trim();
      if (text === "") return;
      const index = obj(update._meta)?.promptIndex;
      const turnId = `${prefix}${typeof index === "number" ? index : stamp}`;
      const previous = sink.latestTurn();
      const isNew = sink.item(`turn:${turnId}`) === undefined;
      const created = sink.beginTurn(turnId, at, { text });
      // 换了会话（`/new`、`/resume`）：在新会话的第一个回合里插一条分隔。
      if (
        isNew &&
        previous !== undefined &&
        previous.turnId !== turnId &&
        !previous.turnId.startsWith(prefix)
      ) {
        sink.notice(created, `n:switch:${turnId}`, at, "info", {
          name: session.slice(0, 8),
        });
      }
      return;
    }
    case "agent_message_chunk": {
      const text = textOf(update.content) ?? "";
      if (text.trim() === "") return;
      sink.assistant(
        sink.turnForContent(at, `${prefix}${stamp}`),
        `a:${stamp}`,
        at,
        [{ type: "text", text }],
      );
      return;
    }
    case "agent_thought_chunk": {
      const text = textOf(update.content) ?? "";
      if (text.trim() === "") return;
      sink.thought(
        sink.turnForContent(at, `${prefix}${stamp}`),
        `th:${stamp}`,
        at,
        text,
      );
      return;
    }
    case "tool_call":
      startTool(sink, update, at, sink.turnForContent(at, `${prefix}${stamp}`));
      return;
    case "tool_call_update":
      updateTool(sink, update, at);
      return;
    case "turn_completed": {
      // 只合自己这个会话的回合：另一个会话的行不能把这边打开的回合收掉。
      const open = sink.openTurn();
      if (open !== undefined && !open.turnId.startsWith(prefix)) return;
      const stop = stopReasonOf(update.stop_reason);
      sink.endTurn(at, stop === undefined ? {} : { stopReason: stop });
      return;
    }
    default:
    // hook_execution、current_mode_update……不是对话内容。
  }
}

export const grokTranscript: TranscriptAdapter = {
  agentId: "grok",
  // 只认 `updates.jsonl`：别的文件名（hook 报来的任何路径）不是这家的对话记录。
  locate: (hint: SessionHint) => {
    const path = locateHistory(hint)?.path;
    return path !== undefined && basename(path) === UPDATES_FILE
      ? path
      : undefined;
  },
  convert,
  toolKind: grokToolKind,
};
