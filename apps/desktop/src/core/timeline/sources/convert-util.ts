/**
 * 两家转换器共用的小件：宽松取字段、时间戳、工具内容与 diff 的构造。
 */

import {
  type TimelineToolContent,
  type TimelineToolKind,
  type AcpOpsContext,
  clipTail,
  toolContentOf,
} from "@armadra/shared";

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** RFC 3339 或毫秒 → 毫秒；读不出来答 `fallback`。 */
export function timeOf(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    // 秒级时间戳（< 1e11）按秒算。
    return Math.trunc(value < 1e11 ? value * 1000 : value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function firstLine(text: string, limit = 200): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** 文本内容 → 工具内容（只留尾部 64 KiB）。 */
export function textContent(text: string): TimelineToolContent[] {
  return text === "" ? [] : [{ type: "text", ...clipTail(text) }];
}

/**
 * 终端输出。`exitCode` 未知（CLI 没记）就不带。
 */
export function terminalContent(input: {
  readonly terminalId: string;
  readonly command?: string | undefined;
  readonly output: string;
  readonly exitCode?: number | null | undefined;
}): TimelineToolContent {
  const clipped = clipTail(input.output);
  return {
    type: "terminal",
    terminalId: input.terminalId.slice(0, 200),
    ...(input.command !== undefined && input.command !== ""
      ? { command: input.command.slice(0, 10_000) }
      : {}),
    output: clipped.text,
    ...(clipped.truncated !== undefined
      ? { truncated: true as const, originalBytes: clipped.originalBytes }
      : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
  };
}

/** diff 内容；过大的由共享层的上限收成只记行数。 */
export function diffContent(
  path: string,
  oldText: string | null,
  newText: string,
  ctx: AcpOpsContext,
): TimelineToolContent | null {
  return toolContentOf({ type: "diff", path, oldText, newText }, ctx);
}

/** 统一 diff 的行（` ` / `-` / `+` 打头）→ 旧文本与新文本。 */
export function sidesOfLines(lines: readonly string[]): {
  oldText: string;
  newText: string;
} {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of lines) {
    const mark = line[0];
    const body = line.slice(1);
    if (mark === "+") newLines.push(body);
    else if (mark === "-") oldLines.push(body);
    else {
      oldLines.push(body);
      newLines.push(body);
    }
  }
  return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

/** 一个 CLI 侧的工具名 → kind，按子串命中（小写比较）。 */
export function kindByName(
  name: string,
  table: ReadonlyArray<readonly [RegExp, TimelineToolKind]>,
): TimelineToolKind {
  for (const [pattern, kind] of table) if (pattern.test(name)) return kind;
  return "other";
}

/** 上下文占用的窗口大小（模型名里没写就按 200k）。 */
export function windowOf(model: string | undefined): number {
  if (model === undefined) return 200_000;
  return /\[1m\]|-1m\b/i.test(model) ? 1_000_000 : 200_000;
}
