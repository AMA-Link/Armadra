import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  TimelineApprovalItem,
  TimelineItem,
  TimelineToolItem,
} from "@armadra/shared";

vi.mock("./api", () => ({ acpApi: { answer: vi.fn() } }));

import { useAnsweredStore } from "./answered";
import {
  ApprovalCard,
  ToolLookupProvider,
  permissionViewOf,
} from "./TimelineCards";

const base = { turn: 1, ord: 1, rev: 1, source: "acp", at: 1, gen: 0 } as const;

const approval: TimelineApprovalItem = {
  ...base,
  id: "ap:p1",
  kind: "approval",
  pendingId: "p1",
  protocol: "acp",
  toolCallId: "t1",
  options: [{ optionId: "o", name: "Allow", kind: "allow_once" }],
  state: "pending",
  toolCall: {
    title: "Edit src/a.ts",
    toolKind: "edit",
    locations: [{ path: "/repo/src/a.ts", line: 3 }],
    changes: [{ path: "/repo/src/a.ts", addedLines: 4, removedLines: 2 }],
    input: { path: "/repo/src/a.ts" },
  },
};

const tool: TimelineToolItem = {
  ...base,
  id: "tool:t1",
  kind: "tool",
  toolCallId: "t1",
  toolKind: "execute",
  title: "live title",
  status: "in_progress",
  locations: [],
  content: [],
  startedAt: 1,
};

beforeEach(() => useAnsweredStore.getState().reset());
afterEach(cleanup);

describe("permissionViewOf", () => {
  it("falls back to the stored summary when the tool item is not there", () => {
    const view = permissionViewOf(approval, undefined);
    expect(view.toolCall).toMatchObject({
      toolCallId: "t1",
      title: "Edit src/a.ts",
      kind: "edit",
      locations: [{ path: "/repo/src/a.ts", line: 3 }],
      rawInput: { path: "/repo/src/a.ts" },
    });
    expect(view.changes).toEqual([
      { path: "/repo/src/a.ts", stat: { additions: 4, deletions: 2 } },
    ]);
  });

  it("prefers the live tool item over the summary", () => {
    const view = permissionViewOf(approval, tool);
    expect(view.toolCall).toMatchObject({
      title: "live title",
      kind: "execute",
    });
    expect(view.changes).toBeUndefined();
  });

  it("uses the summary title when the live item has none, and an empty title with neither", () => {
    expect(
      permissionViewOf(approval, { ...tool, title: "" }).toolCall.title,
    ).toBe("Edit src/a.ts");
    const { toolCall: _drop, ...bare } = approval;
    expect(permissionViewOf(bare, undefined).toolCall.title).toBe("");
  });
});

describe("ApprovalCard", () => {
  it("names the card and lists the files from the stored summary alone", () => {
    render(
      <ToolLookupProvider value={{} as Record<string, TimelineItem>}>
        <ApprovalCard approval={approval} canAnswer />
      </ToolLookupProvider>,
    );
    expect(screen.getByRole("group", { name: "Edit src/a.ts" })).toBeTruthy();
    const chip = document.querySelector(
      "[data-slot=approval-changes] [data-slot=badge]",
    );
    expect(chip?.textContent).toBe("a.ts+4−2");
  });

  it("shows the live tool title when the item is around", () => {
    render(
      <ToolLookupProvider value={{ "tool:t1": tool }}>
        <ApprovalCard approval={approval} canAnswer />
      </ToolLookupProvider>,
    );
    expect(screen.getByRole("group", { name: "live title" })).toBeTruthy();
  });
});
