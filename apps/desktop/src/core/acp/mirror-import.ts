import type { MirrorBlock, MirrorEntry } from "../history/acp-mirror";

/**
 * 旧镜像 → `session/update` 帧（B10，设计 §2.6）。
 *
 * 没有 `session/load` 的适配器（只能 resume）接回升级前的旧会话时，时间线是空的、
 * 历史只在旧镜像里。这里把镜像记录翻回 ACP 帧，交给 `AcpFeed` 按回放的路径写成
 * `source = replay` 的回合：条目与回合 id 由写入顺序决定，所以同一份镜像总是得到同
 * 一批条目；调用方只在时间线为空时导入，重复接回不会重复写。
 */

export interface MirrorFrame {
  readonly update: Record<string, unknown>;
  /** 记录时间（毫秒）；镜像行没有时间戳时缺席。 */
  readonly at?: number;
}

function contentOf(block: MirrorBlock): Record<string, unknown> | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return block.data === undefined
        ? undefined
        : { type: "image", mimeType: block.mimeType, data: block.data };
    case "resource_link":
      return {
        type: "resource_link",
        uri: block.uri,
        name: block.name,
        ...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
        ...(block.title === undefined ? {} : { title: block.title }),
      };
    default:
      return undefined;
  }
}

function resultContent(content: unknown): Record<string, unknown>[] {
  const text =
    typeof content === "string"
      ? content
      : content === undefined
        ? ""
        : (JSON.stringify(content) ?? "");
  return text === ""
    ? []
    : [{ type: "content", content: { type: "text", text } }];
}

export function mirrorFrames(entries: readonly MirrorEntry[]): MirrorFrame[] {
  const frames: MirrorFrame[] = [];
  let anonymous = 0;
  const parsed = (entry: MirrorEntry): number | undefined => {
    const at = entry.at === undefined ? Number.NaN : Date.parse(entry.at);
    return Number.isFinite(at) ? at : undefined;
  };
  for (const entry of entries) {
    const at = parsed(entry);
    const push = (update: Record<string, unknown>) =>
      frames.push({ update, ...(at === undefined ? {} : { at }) });
    for (const block of entry.blocks) {
      if (block.type === "tool_use") {
        anonymous += 1;
        const extra = block as {
          kind?: string;
          locations?: readonly { path: string; line?: number }[];
        };
        push({
          sessionUpdate: "tool_call",
          toolCallId: block.id ?? `mirror-${anonymous}`,
          title: block.name,
          kind: extra.kind ?? "other",
          status: "in_progress",
          ...(block.input === undefined ? {} : { rawInput: block.input }),
          ...(extra.locations === undefined
            ? {}
            : { locations: extra.locations }),
        });
        continue;
      }
      if (block.type === "tool_result") {
        if (block.id === undefined) continue;
        const extra = block as {
          status?: "failed";
          diffs?: readonly {
            path: string;
            oldText?: string | null;
            newText: string;
          }[];
        };
        push({
          sessionUpdate: "tool_call_update",
          toolCallId: block.id,
          status: extra.status === "failed" ? "failed" : "completed",
          content: [
            ...(extra.diffs ?? []).map((diff) => ({ type: "diff", ...diff })),
            ...resultContent(block.content),
          ],
        });
        continue;
      }
      const content = contentOf(block);
      if (content === undefined) continue;
      push({
        sessionUpdate:
          entry.role === "user" ? "user_message_chunk" : "agent_message_chunk",
        content,
      });
    }
  }
  return frames;
}
