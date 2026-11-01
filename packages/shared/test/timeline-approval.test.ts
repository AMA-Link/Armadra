import { describe, expect, it } from "vitest";
import {
  approvalCallSummary,
  approximateLineChanges,
  timelineItemSchema,
} from "../src/index.js";

describe("approximateLineChanges", () => {
  it("counts lines that are only on one side", () => {
    expect(approximateLineChanges("a\nb\n", "a\nc\nd\n")).toEqual({
      addedLines: 2,
      removedLines: 1,
    });
    expect(approximateLineChanges(null, "x\ny")).toEqual({
      addedLines: 2,
      removedLines: 0,
    });
    expect(approximateLineChanges("x", "x")).toEqual({
      addedLines: 0,
      removedLines: 0,
    });
  });
});

describe("approvalCallSummary", () => {
  it("keeps title, kind, paths, counts and the command, nothing else", () => {
    const summary = approvalCallSummary({
      title: "Edit a.ts",
      kind: "edit",
      locations: [{ path: "/a.ts", line: 4 }, { nope: 1 }],
      content: [
        { type: "diff", path: "/a.ts", oldText: "o", newText: "n\nm" },
        { type: "content", content: { type: "text", text: "body" } },
      ],
      rawInput: { command: "ls", env: "SECRET", note: "x" },
      rawOutput: "never stored",
    });
    expect(summary).toEqual({
      title: "Edit a.ts",
      toolKind: "edit",
      locations: [{ path: "/a.ts", line: 4 }],
      changes: [{ path: "/a.ts", addedLines: 2, removedLines: 1 }],
      input: { command: "ls" },
    });
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });

  it("caps sizes so the item always fits the schema", () => {
    const summary = approvalCallSummary({
      title: "t".repeat(5_000),
      kind: "execute",
      locations: Array.from({ length: 50 }, (_, i) => ({ path: `/f${i}` })),
      content: Array.from({ length: 50 }, (_, i) => ({
        type: "diff",
        path: `/f${i}`,
        newText: "x",
      })),
      rawInput: { command: "c".repeat(20_000) },
    })!;
    expect(summary.title).toHaveLength(2_000);
    expect(summary.locations).toHaveLength(20);
    expect(summary.changes).toHaveLength(20);
    expect(summary.input?.command).toHaveLength(2_000);
    expect(
      timelineItemSchema.safeParse({
        id: "ap:p",
        turn: 1,
        ord: 1,
        rev: 1,
        source: "acp",
        at: 1,
        gen: 0,
        kind: "approval",
        pendingId: "p",
        protocol: "acp",
        options: [],
        state: "pending",
        toolCall: summary,
      }).success,
    ).toBe(true);
  });

  it("answers undefined when there is nothing to say, and ignores unknown kinds", () => {
    expect(approvalCallSummary({})).toBeUndefined();
    expect(approvalCallSummary({ kind: "teleport" })).toBeUndefined();
  });
});
