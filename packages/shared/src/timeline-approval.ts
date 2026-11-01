import type { TimelineApprovalCall, TimelineToolKind } from "./domain/index.js";
import { TIMELINE_TOOL_KINDS } from "./domain/index.js";
import { toolInputSummary } from "./timeline-acp.js";

/**
 * 审批请求的 `toolCall` → 时间线审批条目上的摘要（见 `timelineApprovalCallSchema`）。
 * 帧里的 JSON 来自适配器，形状不可信：缺字段的跳过，不抛错。只留标题、种类、
 * 路径、`+N −M` 与命令类入参，永远不带差异正文、输出或其余入参。
 */

const MAX_LOCATIONS = 20;
const MAX_CHANGES = 20;
/** 超过这个行数的文本不再逐行比对，按行数记。 */
const MAX_COMPARED_LINES = 20_000;

interface ToolCallLike {
  readonly title?: unknown;
  readonly kind?: unknown;
  readonly locations?: unknown;
  readonly content?: unknown;
  readonly rawInput?: unknown;
  readonly [key: string]: unknown;
}

function lines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return text === "" ? [] : parts;
}

/**
 * 两段文本的 `+N −M`：按行做多重集合比对（不看顺序）。便宜、不会卡住，只用于
 * 没有工具条目时的兜底；有工具条目时卡片自己按差异正文算。
 */
export function approximateLineChanges(
  oldText: string | null | undefined,
  newText: string,
): { addedLines: number; removedLines: number } {
  const before = lines(oldText ?? "");
  const after = lines(newText);
  if (before.length + after.length > MAX_COMPARED_LINES) {
    return { addedLines: after.length, removedLines: before.length };
  }
  const left = new Map<string, number>();
  for (const line of before) left.set(line, (left.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after) {
    const count = left.get(line) ?? 0;
    if (count > 0) left.set(line, count - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of left.values()) removed += count;
  return { addedLines: added, removedLines: removed };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function approvalCallSummary(
  toolCall: ToolCallLike,
): TimelineApprovalCall | undefined {
  const title =
    typeof toolCall.title === "string" && toolCall.title !== ""
      ? toolCall.title.slice(0, 2_000)
      : undefined;
  const toolKind =
    typeof toolCall.kind === "string" &&
    (TIMELINE_TOOL_KINDS as readonly string[]).includes(toolCall.kind)
      ? (toolCall.kind as TimelineToolKind)
      : undefined;

  const locations: { path: string; line?: number }[] = [];
  if (Array.isArray(toolCall.locations)) {
    for (const entry of toolCall.locations) {
      const location = record(entry);
      if (location === null || typeof location.path !== "string") continue;
      if (locations.length >= MAX_LOCATIONS) break;
      locations.push({
        path: location.path.slice(0, 4_000),
        ...(typeof location.line === "number" && Number.isInteger(location.line)
          ? { line: location.line }
          : {}),
      });
    }
  }

  const changes: { path: string; addedLines: number; removedLines: number }[] =
    [];
  if (Array.isArray(toolCall.content)) {
    for (const entry of toolCall.content) {
      const item = record(entry);
      if (
        item === null ||
        item.type !== "diff" ||
        typeof item.path !== "string" ||
        typeof item.newText !== "string"
      ) {
        continue;
      }
      const path = item.path.slice(0, 4_000);
      if (changes.length >= MAX_CHANGES) break;
      if (changes.some((change) => change.path === path)) continue;
      changes.push({
        path,
        ...approximateLineChanges(
          typeof item.oldText === "string" ? item.oldText : null,
          item.newText,
        ),
      });
    }
  }

  const raw = toolInputSummary(toolCall.rawInput);
  const input =
    raw === undefined
      ? undefined
      : {
          ...(raw.command !== undefined
            ? { command: raw.command.slice(0, 2_000) }
            : {}),
          ...(raw.path !== undefined ? { path: raw.path } : {}),
          ...(raw.line !== undefined ? { line: raw.line } : {}),
          ...(raw.query !== undefined
            ? { query: raw.query.slice(0, 500) }
            : {}),
          ...(raw.url !== undefined ? { url: raw.url.slice(0, 1_000) } : {}),
        };

  const summary: TimelineApprovalCall = {
    ...(title !== undefined ? { title } : {}),
    ...(toolKind !== undefined ? { toolKind } : {}),
    ...(locations.length > 0 ? { locations } : {}),
    ...(changes.length > 0 ? { changes } : {}),
    ...(input !== undefined && Object.keys(input).length > 0 ? { input } : {}),
  };
  return Object.keys(summary).length === 0 ? undefined : summary;
}
