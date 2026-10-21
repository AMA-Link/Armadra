/**
 * OpenCode → 时间线（设计 §5.2）。
 *
 * 数据在一个 SQLite 库里（`${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`），
 * 没有 JSONL 文件，所以适配器走 {@link TranscriptAdapter.source}：`opencode-db.ts`
 * 只读打开、按 `time_updated` 续读，把 `session`（标题）、`message`、`part` 各变成
 * 一行 JSON（`{k:"s"|"m"|"p", …}`），这里把它们转成条目。条目 id 用分块自己的 id
 * （`a:<part id>`、`th:<part id>`、`tool:<callID>`），同一行重复读到只是 upsert。
 *
 * 能拿到：用户文本（`synthetic` / `ignored` 的是 OpenCode 自己塞的，跳过）；助手
 * 文本和思考（分块写完才有，所以按整段出现）；工具的全过程（pending → running →
 * completed / error，中间状态也看得见）：`bash` 的输出与退出码、`edit` / `write` /
 * `apply_patch` 的 diff（`edit` 用入参的 `oldString` / `newString`，没有就解析
 * `metadata.filediff.patch`）、其余工具的文本输出；`todowrite` → 计划；`step-finish`
 * 的 `tokens` → 用量；`session.title` → 标题；助手消息的 `finish` / `error` → 回合收尾
 * （被打断 → 已取消）。
 *
 * 拿不到：逐 token 的流；加密的推理正文（`reasoning` 只剩 `encrypted` 元数据时是空
 * 思考，页面显示「已隐藏」）；用户消息里的附件（`file` 分块不转）；子会话
 * （`task` 开的会话）内部的调用，主时间线上只有一个 `subagent` 工具；上下文窗口大小
 * （库里没有，按 200k）。
 */

import {
  type TimelineToolContent,
  type TimelineToolKind,
  type TimelineToolLocation,
  type ToolPatch,
  toolInputSummary,
} from "@armadra/shared";

import type { SessionHint } from "../../history/types";
import { roots } from "../../history/opencode";
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
  windowOf,
} from "./convert-util";
import { opencodeSource } from "./opencode-db";
import { parseApplyPatch } from "./patch";
import type { TimelineSink } from "./sink";
import type { TranscriptAdapter } from "./types";

const KIND_TABLE: ReadonlyArray<readonly [RegExp, TimelineToolKind]> = [
  [/^bash$/i, "execute"],
  [/^(read|view)$/i, "read"],
  [/^(edit|write|multiedit|patch|apply_patch)$/i, "edit"],
  [/^(grep|glob|list|ls|codesearch|websearch|ast_grep_search|lsp)/i, "search"],
  [/^webfetch$/i, "fetch"],
  [/^task$/i, "subagent"],
];

export function opencodeToolKind(name: string): TimelineToolKind {
  return kindByName(name, KIND_TABLE);
}

/** OpenCode 还没起标题时写的占位，不当标题。 */
const PLACEHOLDER_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/;

/* --------------------------------- 工具 --------------------------------- */

function titleOf(name: string, input: Json | undefined, state: Json): string {
  const description = str(input?.description);
  const command = str(input?.command);
  if (/^bash$/i.test(name))
    return firstLine(description ?? command ?? name, 160);
  if (/^task$/i.test(name)) {
    return firstLine(description ?? str(input?.prompt) ?? name, 160);
  }
  const questions = input?.questions;
  if (/^question$/i.test(name) && Array.isArray(questions)) {
    const question = str(obj(questions[0])?.question);
    if (question !== undefined) return firstLine(question, 160);
  }
  const given = str(state.title);
  const target =
    str(input?.filePath) ??
    str(input?.path) ??
    str(input?.pattern) ??
    str(input?.query) ??
    str(input?.url);
  const label = given !== undefined && given !== "" ? given : target;
  return label === undefined ? name : `${name} ${firstLine(label, 160)}`;
}

/** 统一 diff → 旧文本、新文本（只认 hunk 里的行）。 */
function unifiedSides(patch: string) {
  const lines: string[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line === "") continue;
    lines.push(line);
  }
  return sidesOfLines(lines);
}

function editContent(
  name: string,
  input: Json | undefined,
  state: Json,
  sink: TimelineSink,
  at: number,
): { content: TimelineToolContent[]; locations: TimelineToolLocation[] } {
  const ctx = sink.blobContext(at);
  const path = str(input?.filePath) ?? str(input?.path);
  const content: TimelineToolContent[] = [];
  const locations: TimelineToolLocation[] =
    path !== undefined ? [{ path }] : [];
  const add = (item: TimelineToolContent | null) => {
    if (item !== null) content.push(item);
  };
  if (/^apply_patch$|^patch$/i.test(name)) {
    const files = parseApplyPatch(
      str(input?.patchText) ?? str(input?.patch) ?? "",
    );
    for (const file of files.slice(0, 8)) {
      locations.push({ path: file.movedTo ?? file.path });
      if (file.op !== "delete") {
        add(
          diffContent(
            file.movedTo ?? file.path,
            file.oldText,
            file.newText,
            ctx,
          ),
        );
      }
    }
    return { content, locations };
  }
  if (path === undefined) return { content, locations };
  if (/^write$/i.test(name)) {
    const body = str(input?.content);
    if (body !== undefined) add(diffContent(path, null, body, ctx));
    return { content, locations };
  }
  const before = str(input?.oldString);
  const after = str(input?.newString);
  if (before !== undefined && after !== undefined) {
    add(diffContent(path, before === "" ? null : before, after, ctx));
    return { content, locations };
  }
  const filediff = obj(obj(state.metadata)?.filediff);
  const patch = str(filediff?.patch) ?? str(obj(state.metadata)?.diff);
  if (patch !== undefined) {
    const sides = unifiedSides(patch);
    add(diffContent(path, sides.oldText, sides.newText, ctx));
  }
  return { content, locations };
}

function handleTool(
  sink: TimelineSink,
  turn: ReturnType<TimelineSink["turnForContent"]>,
  part: Json,
  at: number,
): void {
  const callId = str(part.callID) ?? str(part.id);
  const name = str(part.tool);
  if (callId === undefined || name === undefined) return;
  const state = obj(part.state) ?? {};
  const input = obj(state.input);
  const status = str(state.status);
  const metadata = obj(state.metadata);

  if (/^todowrite$/i.test(name)) {
    const todos = input?.todos;
    if (Array.isArray(todos)) {
      const entries = todos.flatMap((todo) => {
        const o = obj(todo);
        const content = str(o?.content);
        if (o === undefined || content === undefined) return [];
        const entryStatus = str(o.status);
        return [
          {
            content,
            ...(entryStatus !== undefined ? { status: entryStatus } : {}),
          },
        ];
      });
      if (entries.length > 0) sink.plan(turn, at, entries);
    }
    return;
  }

  const kind = opencodeToolKind(name);
  const patch: ToolPatch = {
    toolKind: kind,
    title: titleOf(name, input, state),
    status: "in_progress",
    locations: [],
  };
  const summary = input === undefined ? undefined : toolInputSummary(input);
  if (summary !== undefined) patch.input = summary;
  const path = str(input?.filePath) ?? str(input?.path);
  if (path !== undefined) patch.locations = [{ path }];

  const done = status === "completed";
  const failed = status === "error";
  const output = str(state.output) ?? "";
  const errorText = str(state.error) ?? "";

  if (kind === "edit") {
    const edit = editContent(name, input, state, sink, at);
    patch.content = edit.content;
    if (edit.locations.length > 0) patch.locations = edit.locations;
    if (failed) patch.content = [...edit.content, ...textContent(errorText)];
  } else if (kind === "execute") {
    const command = str(input?.command);
    if (done || failed) {
      const exit = num(metadata?.exit);
      patch.content = [
        terminalContent({
          terminalId: callId,
          ...(command !== undefined ? { command } : {}),
          output: failed ? errorText : output,
          ...(exit !== undefined ? { exitCode: exit } : {}),
        }),
      ];
      if (exit !== undefined && exit !== 0) patch.status = "failed";
    } else if (command !== undefined) {
      patch.input = { command: command.slice(0, 10_000) };
    }
  } else if (done) {
    patch.content = textContent(output);
  } else if (failed) {
    patch.content = textContent(errorText);
  }
  if (done && patch.status !== "failed") patch.status = "completed";
  if (failed) patch.status = "failed";
  sink.upsertTool(turn, callId, at, patch, { create: true });
}

/* --------------------------------- 记录 --------------------------------- */

function created(message: Json, fallback: number): number {
  return num(obj(message.time)?.created) ?? fallback;
}

/** 助手消息所属的回合：`parentID` 指向的用户消息，没有就挂最新的。 */
function turnOf(sink: TimelineSink, message: Json, at: number) {
  const parent = str(message.parentID);
  if (parent !== undefined) {
    const found = sink.item(`turn:oc:${parent}`);
    if (found?.kind === "turn") return found;
  }
  return sink.turnForContent(at, `oc:${str(message.id) ?? at}`);
}

function handleUserPart(
  sink: TimelineSink,
  message: Json,
  part: Json,
  at: number,
): void {
  if (
    part.type !== "text" ||
    part.synthetic === true ||
    part.ignored === true
  ) {
    return;
  }
  const text = (str(part.text) ?? "").trim();
  const messageId = str(message.id);
  if (text === "" || messageId === undefined) return;
  const turnId = `oc:${messageId}`;
  const existing = sink.item(`turn:${turnId}`);
  if (existing?.kind === "turn") {
    sink.addUserToTurn(existing, at, text, str(part.id) ?? text.slice(0, 20));
    return;
  }
  sink.beginTurn(turnId, created(message, at), { text });
}

function handleAssistantPart(
  sink: TimelineSink,
  message: Json,
  part: Json,
): void {
  const at = created(message, Date.now());
  const time = obj(part.time);
  const id = str(part.id);
  if (id === undefined) return;
  switch (part.type) {
    case "text": {
      // 写完才有（流式中的分块不落，免得半截文字被固定下来）。
      if (time?.end === undefined || part.synthetic === true) return;
      const text = str(part.text) ?? "";
      if (text.trim() === "") return;
      sink.assistant(
        turnOf(sink, message, at),
        `a:${id}`,
        num(time.start) ?? at,
        [{ type: "text", text }],
      );
      return;
    }
    case "reasoning": {
      if (time?.end === undefined) return;
      sink.thought(
        turnOf(sink, message, at),
        `th:${id}`,
        num(time.start) ?? at,
        str(part.text) ?? "",
      );
      return;
    }
    case "tool": {
      const state = obj(part.state);
      const stamp = num(obj(state?.time)?.start) ?? at;
      handleTool(sink, turnOf(sink, message, at), part, stamp);
      return;
    }
    case "step-finish": {
      const tokens = obj(part.tokens);
      if (tokens === undefined) return;
      const cache = obj(tokens.cache);
      const used =
        (num(tokens.input) ?? 0) +
        (num(cache?.read) ?? 0) +
        (num(cache?.write) ?? 0);
      if (used > 0) sink.usage({ used, size: windowOf(str(message.modelID)) });
      return;
    }
    default:
  }
}

/** 助手消息写完：按 `finish` / `error` 收尾回合（`tool-calls` 只是中间一步）。 */
function handleAssistantMessage(sink: TimelineSink, message: Json): void {
  const time = obj(message.time);
  const completed = num(time?.completed);
  if (completed === undefined) return;
  const open = sink.openTurn();
  const parent = str(message.parentID);
  if (open === undefined) return;
  if (parent !== undefined && open.turnId !== `oc:${parent}`) return;
  const error = obj(message.error);
  const usage = sink.usageNow();
  const usageField = usage !== undefined ? { usage } : {};
  if (error !== undefined) {
    const name = str(error.name) ?? "error";
    if (/abort/i.test(name)) {
      sink.endTurn(completed, { stopReason: "cancelled", ...usageField });
      return;
    }
    const text = str(obj(error.data)?.message) ?? name;
    sink.endTurn(completed, {
      error: { code: name, message: text.slice(0, 4_000) },
      ...usageField,
    });
    return;
  }
  const finish = str(message.finish);
  if (finish === undefined || finish === "tool-calls" || finish === "unknown") {
    return;
  }
  sink.endTurn(completed, {
    stopReason: finish === "length" ? "max_tokens" : "end_turn",
    ...usageField,
  });
}

function convert(value: unknown, sink: TimelineSink): void {
  const record = obj(value);
  if (record === undefined) return;
  if (record.k === "s") {
    const title = str(record.title);
    if (title !== undefined && !PLACEHOLDER_TITLE.test(title))
      sink.title(title);
    return;
  }
  const message = obj(record.m);
  if (message === undefined) return;
  if (record.k === "m") {
    if (message.role === "assistant") handleAssistantMessage(sink, message);
    return;
  }
  const part = obj(record.p);
  if (record.k !== "p" || part === undefined) return;
  if (message.role === "user") {
    handleUserPart(sink, message, part, created(message, Date.now()));
  } else if (message.role === "assistant") {
    handleAssistantPart(sink, message, part);
  }
}

export const opencodeTranscript: TranscriptAdapter = {
  agentId: "opencode",
  // 没有转录文件：答库文件，表示这台机器上有 OpenCode 的记录可读。
  locate: (_hint: SessionHint) => roots()[0],
  convert,
  toolKind: opencodeToolKind,
  source: opencodeSource,
};
