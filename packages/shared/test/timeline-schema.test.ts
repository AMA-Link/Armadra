import { describe, expect, it } from "vitest";
import {
  ACTIVITY_PHASES,
  TIMELINE_ITEM_KINDS,
  compareActivityRev,
  sessionActivitySchema,
  timelineDeltaSchema,
  timelineItemRecordSchema,
  timelineItemSchema,
  timelineOpSchema,
  timelineSyncResultSchema,
  turnIndexSchema,
} from "../src/index.js";

const base = { turn: 1, ord: 1, rev: 3, source: "acp", at: 1_000, gen: 0 };

const samples = [
  { ...base, id: "u:t1", kind: "user", text: "hi" },
  {
    ...base,
    id: "a:1:1",
    kind: "assistant",
    streaming: false,
    parts: [
      { type: "text", text: "x" },
      { type: "image", mimeType: "image/png", blobId: "b1", bytes: 10 },
      { type: "resource_link", uri: "file:///a", name: "a" },
      { type: "resource", uri: "file:///a", text: "t" },
      { type: "audio", mimeType: "audio/wav", dropped: true },
    ],
  },
  { ...base, id: "th:1:1", kind: "thought", text: "hm", streaming: true },
  {
    ...base,
    id: "tool:c1",
    kind: "tool",
    toolCallId: "c1",
    toolKind: "subagent",
    title: "t",
    status: "cancelled",
    locations: [{ path: "/a", line: 3 }],
    content: [
      { type: "text", text: "o", truncated: true, originalBytes: 99 },
      { type: "diff", path: "/a", oldText: null, newText: "n" },
      { type: "terminal", terminalId: "x", exitCode: 0 },
      { type: "image", mimeType: "image/png" },
      { type: "resource", uri: "u" },
    ],
    startedAt: 5,
  },
  { ...base, id: "plan:1", kind: "plan", entries: [{ content: "a" }] },
  {
    ...base,
    id: "ap:p",
    kind: "approval",
    pendingId: "p",
    protocol: "acp",
    options: [{ optionId: "o", name: "n", kind: "allow_once" }],
    state: "pending",
  },
  {
    ...base,
    id: "el:p",
    kind: "elicitation",
    pendingId: "p",
    message: "m",
    mode: "form",
    state: "answered",
    answer: { action: "accept" },
  },
  {
    ...base,
    id: "n:1:error:4",
    kind: "notice",
    code: "error",
    params: { message: "x", n: 1, flag: true, none: null },
  },
  {
    ...base,
    id: "turn:t1",
    kind: "turn",
    turnId: "t1",
    startedAt: 1,
    permissionWaitMs: 0,
  },
];

describe("timeline schema", () => {
  it("九种条目都能通过校验，且覆盖全部 kind", () => {
    for (const sample of samples) {
      expect(timelineItemSchema.safeParse(sample).success, sample.id).toBe(
        true,
      );
    }
    expect(new Set(samples.map((s) => s.kind))).toEqual(
      new Set(TIMELINE_ITEM_KINDS),
    );
  });

  it("未知的 kind、缺公共字段、负数序号都被拒绝", () => {
    expect(
      timelineItemSchema.safeParse({ ...samples[0], kind: "x" }).success,
    ).toBe(false);
    const { rev: _rev, ...noRev } = samples[0] as Record<string, unknown>;
    expect(timelineItemSchema.safeParse(noRev).success).toBe(false);
    expect(
      timelineItemSchema.safeParse({ ...samples[0], rev: -1 }).success,
    ).toBe(false);
  });

  it("操作四种形状，seq 必须为正整数", () => {
    const ops = [
      { seq: 1, op: "put", item: samples[0] },
      { seq: 2, op: "append", itemId: "a:1:1", delta: { text: "x" } },
      { seq: 3, op: "remove", itemId: "a:1:1" },
      {
        seq: 4,
        op: "head",
        head: { title: null, usage: { used: 1, size: 2 } },
      },
    ];
    for (const op of ops)
      expect(timelineOpSchema.safeParse(op).success).toBe(true);
    expect(
      timelineOpSchema.safeParse({ seq: 0, op: "remove", itemId: "a" }).success,
    ).toBe(false);
    expect(timelineOpSchema.safeParse({ seq: 1, op: "nope" }).success).toBe(
      false,
    );
  });

  it("帧与同步结果：墓碑和完整值都收", () => {
    expect(
      timelineDeltaSchema.safeParse({
        timelineId: "s",
        nodeId: "n",
        from: 0,
        to: 1,
        ops: [{ seq: 1, op: "remove", itemId: "x" }],
      }).success,
    ).toBe(true);
    expect(
      timelineSyncResultSchema.safeParse({
        headSeq: 5,
        items: [{ id: "x", rev: 5, deleted: true }, samples[0]],
      }).success,
    ).toBe(true);
    expect(
      timelineItemRecordSchema.safeParse({ id: "x", rev: 5 }).success,
    ).toBe(false);
  });

  it("活动：十二个阶段、结局和版本", () => {
    expect(ACTIVITY_PHASES).toHaveLength(12);
    for (const phase of ACTIVITY_PHASES) {
      expect(
        sessionActivitySchema.safeParse({ phase, since: 1, rev: "b:1" })
          .success,
        phase,
      ).toBe(true);
    }
    expect(
      sessionActivitySchema.safeParse({
        phase: "tool",
        since: 1,
        rev: "b:2",
        detail: { label: "Read", toolKind: "read", count: 2 },
        lastOutcome: { kind: "failed", at: 1, error: "x" },
      }).success,
    ).toBe(true);
    expect(
      sessionActivitySchema.safeParse({ phase: "zzz", since: 1, rev: "b:1" })
        .success,
    ).toBe(false);
  });

  it("活动版本：同一 bootId 比序号，不同 bootId 不可比", () => {
    expect(compareActivityRev("b:2", "b:10")).toBeLessThan(0);
    expect(compareActivityRev("b:10", "b:2")).toBeGreaterThan(0);
    expect(compareActivityRev("b:3", "b:3")).toBe(0);
    expect(compareActivityRev("a:3", "b:3")).toBeNull();
    expect(compareActivityRev("x:y:2", "x:y:1")).toBeGreaterThan(0);
  });

  it("回合索引", () => {
    expect(
      turnIndexSchema.safeParse({
        turnId: "t",
        turn: 1,
        startedAt: 1,
        headText: "hi",
        counts: { items: 3, tools: 1, thoughts: 0, messages: 2 },
      }).success,
    ).toBe(true);
    expect(
      turnIndexSchema.safeParse({
        turnId: "t",
        turn: 1,
        startedAt: 1,
        headText: "x".repeat(81),
        counts: { items: 0, tools: 0, thoughts: 0, messages: 0 },
      }).success,
    ).toBe(false);
  });
});
