import { afterEach, describe, expect, it } from "vitest";

import type { TimelineItem } from "@armadra/shared";

import { setAcpTimelineSource } from "./registry";
import { entriesFromTimeline, sliceTimelineEntries } from "./acp-mirror";
import {
  describeHistoryCursor,
  locateHistory,
  readHistoryEntries,
} from "./registry";

/**
 * B10：上下文读取、摘要、交接吃的 `TranscriptEntry` 从会话时间线派生；时间线为空才读
 * 旧镜像文件。
 */

const base = { rev: 1, source: "acp", gen: 1, ord: 0 } as const;
const items: TimelineItem[] = [
  { ...base, id: "t1", turn: 1, kind: "user", at: 1000, text: "读一下 a.ts" },
  {
    ...base,
    id: "a1",
    turn: 1,
    kind: "assistant",
    at: 2000,
    streaming: false,
    parts: [
      { type: "text", text: "好的，" },
      { type: "text", text: "我来读。" },
    ],
  },
  {
    ...base,
    id: "th",
    turn: 1,
    kind: "thought",
    at: 2100,
    text: "x",
    streaming: false,
  },
  {
    ...base,
    id: "tool",
    turn: 1,
    kind: "tool",
    at: 3000,
    toolCallId: "c1",
    toolKind: "read",
    title: "Read a.ts",
    status: "completed",
    locations: [],
    content: [{ type: "text", text: "内容" }],
    startedAt: 3000,
    endedAt: 3500,
  },
  {
    ...base,
    id: "a2",
    turn: 1,
    kind: "assistant",
    at: 4000,
    streaming: false,
    parts: [{ type: "text", text: "读完了。" }],
  },
] as TimelineItem[];

afterEach(() => setAcpTimelineSource(undefined));

describe("entriesFromTimeline", () => {
  it("keeps user and assistant text, tool calls and their results; skips thoughts", () => {
    const entries = entriesFromTimeline(items);
    expect(entries.map((entry) => [entry.role, entry.blocks[0]?.type])).toEqual(
      [
        ["user", "text"],
        ["assistant", "text"],
        ["assistant", "tool_use"],
        ["user", "tool_result"],
        ["assistant", "text"],
      ],
    );
    expect(entries[1]?.blocks[0]).toEqual({
      type: "text",
      text: "好的，我来读。",
    });
    expect(entries[3]?.blocks[0]).toMatchObject({ id: "c1", content: "内容" });
  });

  it("slices by record index and byte budget", () => {
    const all = entriesFromTimeline(items);
    const first = sliceTimelineEntries(all, 0, 1 << 20);
    expect(first.endOffset).toBe(all.length);
    expect(first.entries.at(-1)?.endOffset).toBe(all.length);
    const rest = sliceTimelineEntries(all, 2, 1 << 20);
    expect(rest.startOffset).toBe(2);
    expect(rest.entries).toHaveLength(all.length - 2);
    // 预算再小也至少给一条，游标才会前进。
    expect(sliceTimelineEntries(all, 0, 1).entries).toHaveLength(1);
    expect(sliceTimelineEntries(all, 99, 1 << 20).entries).toEqual([]);
  });
});

describe("the registry with a timeline source", () => {
  const path = "/data/acp/node/s-1.acp.jsonl";

  it("locates and reads an ACP transcript path whose mirror file is gone", () => {
    setAcpTimelineSource((requested) =>
      requested === path ? items : undefined,
    );
    const located = locateHistory({ agentId: "claude", transcriptPath: path });
    expect(located?.path).toBe(path);
    const range = readHistoryEntries("claude", located!, 0, 1 << 20);
    expect(range.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(describeHistoryCursor("claude", located!, 3)).toBe("3 条");
  });

  it("finds nothing when the timeline is empty and the file is absent", () => {
    setAcpTimelineSource(() => []);
    expect(
      locateHistory({ agentId: "copilot", transcriptPath: path }),
    ).toBeUndefined();
  });
});
