import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { renderEntries } from "../collab/transcript";
import {
  type MirrorBlock,
  type MirrorDiff,
  type MirrorEntry,
  type MirrorLocation,
  type MirrorRecord,
  mirrorSize,
  readMirrorEntries,
} from "../history/acp-mirror";
import type { AcpSessionUpdate } from "./types";

/**
 * 升级前的 core 写旧镜像（`.acp.jsonl`）的那份实现，只给测试造「旧会话」用：
 * B10 起 core 不再写镜像，但读旧文件（`mirror.ts`、`mirror-import.ts`、
 * `history/acp-mirror.ts`）的测试仍要一份旧格式的文件。生产代码不引用它。
 */

/** 一条工具结果在镜像里最多占这么多字符：整份文件的 diff 不该撑大转录。 */
const RESULT_LIMIT = 8_000;

/** 攒着的文本分块最多等多久、最多攒多大就写一行。 */
export const BATCH_MS = 300;
export const BATCH_BYTES = 32 * 1024;

/** 一张图片在镜像里最多占这么多 base64 字符；再大只记 `dropped`。 */
export const IMAGE_LIMIT = 512 * 1024;

function textOf(content: unknown): string {
  if (typeof content !== "object" || content === null) return "";
  const block = content as { type?: unknown; text?: unknown };
  return block.type === "text" && typeof block.text === "string"
    ? block.text
    : "";
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** URI 的最后一段，当资源没有名字时的名字。 */
function nameOf(uri: string): string {
  const tail = uri.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const name = tail.slice(tail.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name) || uri;
  } catch {
    return name || uri;
  }
}

/** 一个 ACP 内容块 → 镜像里的块；认不出或空的答 `undefined`。 */
export function mirrorBlockOf(content: unknown): MirrorBlock | undefined {
  if (typeof content !== "object" || content === null) return undefined;
  const block = content as Record<string, unknown>;
  switch (block.type) {
    case "text": {
      const text = textOf(block);
      return text === "" ? undefined : { type: "text", text };
    }
    case "image": {
      const mimeType = stringOf(block.mimeType) ?? "image/png";
      const data = typeof block.data === "string" ? block.data : "";
      if (data === "" || data.length > IMAGE_LIMIT) {
        return { type: "image", mimeType, dropped: true };
      }
      return { type: "image", mimeType, data };
    }
    case "resource_link": {
      const uri = stringOf(block.uri);
      if (uri === undefined) return undefined;
      const mimeType = stringOf(block.mimeType);
      const title = stringOf(block.title);
      return {
        type: "resource_link",
        uri,
        name: stringOf(block.name) ?? nameOf(uri),
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(title === undefined ? {} : { title }),
      };
    }
    case "resource": {
      const resource = block.resource as Record<string, unknown> | undefined;
      if (typeof resource !== "object" || resource === null) return undefined;
      const text = stringOf(resource.text);
      if (text !== undefined) return { type: "text", text };
      const uri = stringOf(resource.uri);
      if (uri === undefined) return undefined;
      const mimeType = stringOf(resource.mimeType);
      return {
        type: "resource_link",
        uri,
        name: nameOf(uri),
        ...(mimeType === undefined ? {} : { mimeType }),
      };
    }
    default:
      return undefined;
  }
}

/** `tool_call.locations[]`：路径与可选行号，最多记 20 个。 */
function locationsOf(value: unknown): MirrorLocation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations: MirrorLocation[] = [];
  for (const item of value.slice(0, 20)) {
    const entry = item as { path?: unknown; line?: unknown } | null;
    if (typeof entry?.path !== "string" || entry.path === "") continue;
    locations.push({
      path: entry.path,
      ...(typeof entry.line === "number" && Number.isInteger(entry.line)
        ? { line: entry.line }
        : {}),
    });
  }
  return locations.length > 0 ? locations : undefined;
}

/** `tool_call(_update).content[]` 里的文件差异。 */
function diffsOf(content: unknown): MirrorDiff[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const diffs: MirrorDiff[] = [];
  for (const item of content) {
    const entry = item as Record<string, unknown> | null;
    if (
      entry === null ||
      typeof entry !== "object" ||
      entry.type !== "diff" ||
      typeof entry.path !== "string" ||
      typeof entry.newText !== "string"
    ) {
      continue;
    }
    diffs.push({
      path: entry.path,
      ...(typeof entry.oldText === "string" ? { oldText: entry.oldText } : {}),
      newText: entry.newText,
    });
  }
  return diffs;
}

/** 工具结果的正文：内容块里的文字，没有就 `rawOutput`，再没有就状态。 */
function resultOf(update: Record<string, unknown>): unknown {
  const content = Array.isArray(update.content) ? update.content : [];
  const texts = content
    .map((item: unknown) => {
      const entry = item as { type?: unknown; content?: unknown };
      return entry?.type === "content" ? textOf(entry.content) : "";
    })
    .filter((text) => text !== "");
  let value: unknown =
    texts.length > 0
      ? texts.join("\n")
      : update.rawOutput !== undefined
        ? update.rawOutput
        : { status: update.status };
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized !== undefined && serialized.length > RESULT_LIMIT) {
    value = `${serialized.slice(0, RESULT_LIMIT)}…`;
  }
  return value;
}

export class LegacyMirrorWriter {
  /** 已经记过终态结果的工具调用。 */
  private readonly settled = new Set<string>();
  /** 还没落结果的工具调用最近一次给的差异（`content` 每次整份替换）。 */
  private readonly diffs = new Map<string, MirrorDiff[]>();

  /** 攒着还没写的助手文本块（相邻的文本合并成一块）。 */
  private pending: MirrorBlock[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 已经写了几次文件（测试与诊断用）。 */
  writes = 0;

  constructor(readonly path: string) {}

  /** 镜像还是空的（文件不在或零字节）。 */
  get empty(): boolean {
    this.flush();
    return mirrorSize(this.path) === 0;
  }

  get size(): number {
    this.flush();
    return mirrorSize(this.path);
  }

  /** 把攒着的文本写成一行；没有攒着的什么都不做。 */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const blocks = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.write({ role: "assistant", blocks });
  }

  /** 攒一个助手块：文本并进上一个文本块，到量或到点写出。 */
  private buffer(block: MirrorBlock): void {
    const last = this.pending.at(-1);
    if (block.type === "text" && last?.type === "text") {
      this.pending[this.pending.length - 1] = {
        type: "text",
        text: last.text + block.text,
      };
    } else {
      this.pending.push(block);
    }
    this.pendingBytes +=
      block.type === "text"
        ? block.text.length
        : block.type === "image" && block.data
          ? block.data.length
          : 64;
    if (this.pendingBytes >= BATCH_BYTES) {
      this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try {
          this.flush();
        } catch {
          // 落盘失败下一次写或 flush 再试；这里没有调用方可以接。
        }
      }, BATCH_MS);
      this.timer.unref?.();
    }
  }

  append(record: MirrorRecord): void {
    this.flush();
    this.write(record);
  }

  private write(record: MirrorRecord): void {
    const directory = dirname(this.path);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const fresh = !existsSync(this.path);
    this.writes += 1;
    appendFileSync(
      this.path,
      `${JSON.stringify({ ...record, at: record.at ?? new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    if (fresh) {
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // Windows 上没有 POSIX 权限；数据目录本身已经是用户私有的。
      }
    }
  }

  /** 我方发出的一条 prompt。 */
  prompt(text: string, links: readonly MirrorBlock[] = []): void {
    const blocks: MirrorBlock[] = [
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
      ...links,
    ];
    if (blocks.length === 0) return;
    this.append({ role: "user", blocks });
  }

  /**
   * 一条 `session/update`。`replay`：`session/load` 回放的历史——只有镜像
   * 还空着（例如从终端驱动切过来）时才记，否则镜像里已经有了。答这一条记没
   * 记。
   */
  update(update: AcpSessionUpdate, replay = false): boolean {
    const body = update as unknown as Record<string, unknown>;
    let blocks: MirrorBlock[] | undefined;
    let role: "user" | "assistant" = "assistant";
    if (
      (update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update") &&
      typeof body.toolCallId === "string" &&
      body.toolCallId !== "" &&
      !this.settled.has(body.toolCallId)
    ) {
      const diffs = diffsOf(body.content);
      if (diffs !== undefined) this.diffs.set(body.toolCallId, diffs);
    }
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        if (!replay) return false;
        const block = mirrorBlockOf(body.content);
        if (block === undefined) return false;
        role = "user";
        blocks = [block];
        break;
      }
      case "agent_message_chunk": {
        const block = mirrorBlockOf(body.content);
        if (block === undefined) return false;
        // 回放进空镜像时是历史，没有「马上要读」的页面：照样攒，到点写。
        this.buffer(block);
        return true;
      }
      case "tool_call": {
        const id = typeof body.toolCallId === "string" ? body.toolCallId : "";
        const name =
          (typeof body.title === "string" && body.title) ||
          (typeof body.kind === "string" && body.kind) ||
          "tool";
        const kind = typeof body.kind === "string" ? body.kind : undefined;
        const locations = locationsOf(body.locations);
        blocks = [
          {
            type: "tool_use",
            name,
            ...(id === "" ? {} : { id }),
            ...(body.rawInput === undefined ? {} : { input: body.rawInput }),
            ...(kind === undefined ? {} : { kind }),
            ...(locations === undefined ? {} : { locations }),
          },
        ];
        break;
      }
      case "tool_call_update": {
        const id = typeof body.toolCallId === "string" ? body.toolCallId : "";
        if (body.status !== "completed" && body.status !== "failed") {
          return false;
        }
        if (id !== "" && this.settled.has(id)) return false;
        const diffs = id === "" ? diffsOf(body.content) : this.diffs.get(id);
        if (id !== "") {
          this.settled.add(id);
          this.diffs.delete(id);
        }
        role = "user";
        blocks = [
          {
            type: "tool_result",
            ...(id === "" ? {} : { id }),
            content: resultOf(body),
            ...(body.status === "failed" ? { status: "failed" as const } : {}),
            ...(diffs === undefined || diffs.length === 0 ? {} : { diffs }),
          },
        ];
        break;
      }
      default:
        return false;
    }
    this.append({ role, blocks });
    return true;
  }

  /**
   * 从 `after` 起的记录（`GET /api/acp/sessions/{id}/log`）：连图片、资源链接
   * 与差异一起读（契约 §49）。
   */
  read(after = 0): { entries: MirrorEntry[]; endOffset: number } {
    this.flush();
    const range = readMirrorEntries(this.path, after, 32 * 1024 * 1024, {
      rich: true,
    });
    return { entries: [...range.entries], endOffset: range.endOffset };
  }

  /**
   * 「终端画面」的 ACP 版（`context terminal`、自动命名）：镜像尾部渲染成散文，
   * 取最后 `lines` 行。
   */
  capture(lines: number): string {
    this.flush();
    const size = this.size;
    const window = 256 * 1024;
    const range = readMirrorEntries(
      this.path,
      Math.max(0, size - window),
      window,
    );
    const rendered = renderEntries(range.entries)
      .map((record) => record.line)
      .join("\n")
      .split("\n");
    return lines <= 0
      ? rendered.join("\n")
      : rendered.slice(Math.max(0, rendered.length - lines)).join("\n");
  }
}
