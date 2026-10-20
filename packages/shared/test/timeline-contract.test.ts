import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  TIMELINE_CONTRACT_SECTION,
  TIMELINE_CONTRACT_SINCE,
  contractEntries,
} from "../src/index.js";

const entries = contractEntries().filter((e) => e.path[0] === "timeline");
type Def = { inputSchema?: z.ZodType; outputSchema?: z.ZodType };
const def = (e: (typeof entries)[number]): Def =>
  (e.procedure as unknown as { "~orpc": Def })["~orpc"];

describe("timeline.* 契约", () => {
  it("四条 procedure，都是 terminal:read，同一个节与 since", () => {
    expect(entries.map((e) => e.name)).toEqual([
      "timeline.open",
      "timeline.sync",
      "timeline.page",
      "timeline.blob",
    ]);
    for (const e of entries) {
      expect(e.meta.scope, e.name).toBe("terminal:read");
      expect(e.meta.contract, e.name).toBe(TIMELINE_CONTRACT_SECTION);
      expect(e.meta.since, e.name).toBe(TIMELINE_CONTRACT_SINCE);
      expect(e.meta.workspaceKey, e.name).toBeUndefined();
    }
  });

  it("入参：timelineId 必填；tailTurns / turns 有界；after 非负", () => {
    const input = (name: string) =>
      def(entries.find((e) => e.name === name) as (typeof entries)[number])
        .inputSchema as z.ZodType;
    expect(input("timeline.open").safeParse({ timelineId: "s" }).success).toBe(
      true,
    );
    expect(
      input("timeline.open").safeParse({ timelineId: "s", tailTurns: 3 })
        .success,
    ).toBe(true);
    expect(
      input("timeline.open").safeParse({ timelineId: "s", tailTurns: 0 })
        .success,
    ).toBe(false);
    expect(input("timeline.open").safeParse({}).success).toBe(false);
    expect(
      input("timeline.sync").safeParse({ timelineId: "s", after: 0 }).success,
    ).toBe(true);
    expect(
      input("timeline.sync").safeParse({ timelineId: "s", after: -1 }).success,
    ).toBe(false);
    expect(
      input("timeline.page").safeParse({
        timelineId: "s",
        beforeTurn: 4,
        turns: 5,
      }).success,
    ).toBe(true);
    expect(
      input("timeline.page").safeParse({
        timelineId: "s",
        beforeTurn: 4,
        turns: 99,
      }).success,
    ).toBe(false);
    expect(
      input("timeline.blob").safeParse({ timelineId: "s", blobId: "b" })
        .success,
    ).toBe(true);
    expect(input("timeline.blob").safeParse({ timelineId: "s" }).success).toBe(
      false,
    );
  });

  it("出参：快照、同步、翻页、blob 的示例都能解析", () => {
    const output = (name: string) =>
      def(entries.find((e) => e.name === name) as (typeof entries)[number])
        .outputSchema as z.ZodType;
    const user = {
      id: "u:t1",
      kind: "user",
      turn: 1,
      ord: 1,
      rev: 2,
      source: "acp",
      at: 1,
      gen: 0,
      text: "hi",
    };
    expect(
      output("timeline.open").safeParse({
        headSeq: 2,
        head: { title: "t" },
        headRev: 1,
        turns: [
          {
            turnId: "t1",
            turn: 1,
            startedAt: 1,
            headText: "hi",
            counts: { items: 1, tools: 0, thoughts: 0, messages: 0 },
          },
        ],
        items: [user],
        activity: { phase: "idle", since: 1, rev: "b:1" },
      }).success,
    ).toBe(true);
    expect(
      output("timeline.sync").safeParse({
        headSeq: 3,
        items: [user, { id: "x", rev: 3, deleted: true }],
      }).success,
    ).toBe(true);
    expect(output("timeline.page").safeParse({ items: [user] }).success).toBe(
      true,
    );
    expect(
      output("timeline.blob").safeParse({
        mimeType: "image/png",
        bytes: 3,
        data: "AAAA",
      }).success,
    ).toBe(true);
    expect(
      output("timeline.blob").safeParse({ mimeType: "image/png" }).success,
    ).toBe(false);
  });
});
