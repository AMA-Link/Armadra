import { beforeEach, describe, expect, it } from "vitest";
import type {
  AcpLogResponse,
  TimelineAssistantItem,
  TimelineItem,
  TimelineToolItem,
} from "@armadra/shared";

import { createBlobLoader, resetBlobs } from "./blobs";
import {
  activityOf,
  addApproval,
  addElicitation,
  applyUpdate,
  beginTurn,
  confirmLocal,
  emptyLegacyState,
  endTurn,
  fromLog,
  itemsOf,
  resolvePending,
  type LegacyState,
} from "./legacy-acp";

const NOW = 1_760_000_000_000;

beforeEach(resetBlobs);

const kinds = (state: LegacyState) => itemsOf(state).map((item) => item.kind);
const find = <K extends TimelineItem["kind"]>(
  state: LegacyState,
  kind: K,
): Extract<TimelineItem, { kind: K }>[] =>
  itemsOf(state).filter(
    (item): item is Extract<TimelineItem, { kind: K }> => item.kind === kind,
  );
const textOf = (item: TimelineAssistantItem) =>
  item.parts.map((part) => (part.type === "text" ? part.text : "")).join("");

const chunk = (text: string, kind = "agent_message_chunk") => ({
  sessionUpdate: kind,
  content: { type: "text", text },
});

function log(partial: Partial<AcpLogResponse> = {}): AcpLogResponse {
  return { entries: [], endOffset: 0, ...partial };
}

describe("fromLog", () => {
  it("rebuilds turns from the mirror and closes the finished ones", () => {
    const state = fromLog(
      log({
        entries: [
          {
            role: "user",
            blocks: [{ type: "text", text: "q1" }],
            endOffset: 1,
          },
          {
            role: "assistant",
            blocks: [{ type: "text", text: "a1" }],
            endOffset: 2,
          },
          {
            role: "user",
            blocks: [{ type: "text", text: "q2" }],
            endOffset: 3,
          },
          {
            role: "assistant",
            blocks: [{ type: "text", text: "a2" }],
            endOffset: 4,
          },
        ],
        endOffset: 4,
      }),
      emptyLegacyState(),
      NOW,
    );
    const items = itemsOf(state);
    expect(items.map((item) => [item.turn, item.kind])).toEqual([
      [1, "turn"],
      [1, "user"],
      [1, "assistant"],
      [2, "turn"],
      [2, "user"],
      [2, "assistant"],
    ]);
    expect(
      find(state, "turn").every((turn) => turn.endedAt !== undefined),
    ).toBe(true);
    expect(find(state, "assistant").map((item) => item.streaming)).toEqual([
      false,
      false,
    ]);
    expect(state.open).toBe(false);
    expect(activityOf(state)?.phase).toBe("idle");
  });

  it("pairs a tool result with its call, keeps the whole diff and marks failure", () => {
    const state = fromLog(
      log({
        entries: [
          {
            role: "user",
            blocks: [{ type: "text", text: "go" }],
            endOffset: 1,
          },
          {
            role: "assistant",
            blocks: [
              { type: "tool_use", id: "t1", name: "Edit a.ts", kind: "edit" },
              {
                type: "tool_use",
                id: "t2",
                name: "pnpm test",
                kind: "execute",
              },
            ],
            endOffset: 2,
          },
          {
            // 只有工具结果的 user 记录不开新回合。
            role: "user",
            blocks: [
              {
                type: "tool_result",
                id: "t1",
                diffs: [{ path: "a.ts", oldText: "x", newText: "y" }],
              },
              {
                type: "tool_result",
                id: "t2",
                status: "failed",
                content: "1 failed",
              },
            ],
            endOffset: 3,
          },
        ],
        endOffset: 3,
      }),
      emptyLegacyState(),
      NOW,
    );
    expect(find(state, "turn")).toHaveLength(1);
    const [edit, test] = find(state, "tool") as TimelineToolItem[];
    expect(edit?.status).toBe("completed");
    expect(edit?.content[0]).toMatchObject({
      type: "diff",
      path: "a.ts",
      oldText: "x",
      newText: "y",
    });
    expect(test?.status).toBe("failed");
    expect(test?.content[0]).toMatchObject({ type: "text", text: "1 failed" });
  });

  it("turns an inline image into a blob the page can load", async () => {
    const state = fromLog(
      log({
        entries: [
          {
            role: "user",
            blocks: [{ type: "text", text: "draw" }],
            endOffset: 1,
          },
          {
            role: "assistant",
            blocks: [
              { type: "image", mimeType: "image/png", data: btoa("png-bytes") },
              { type: "image", mimeType: "image/png", dropped: true },
            ],
            endOffset: 2,
          },
        ],
        endOffset: 2,
      }),
      emptyLegacyState(),
      NOW,
    );
    const [assistant] = find(state, "assistant");
    const [image, dropped] = assistant?.parts ?? [];
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(dropped).toMatchObject({ type: "image", dropped: true });
    const blobId = (image as { blobId: string }).blobId;
    const blob = await createBlobLoader("local", "s")(blobId);
    expect(blob.size).toBe("png-bytes".length);
    expect(JSON.stringify(assistant)).not.toContain(btoa("png-bytes"));
  });

  it("keeps the last turn open when the live process says it is running", () => {
    const state = fromLog(
      log({
        entries: [
          {
            role: "user",
            blocks: [{ type: "text", text: "go" }],
            endOffset: 1,
          },
          {
            role: "assistant",
            blocks: [{ type: "text", text: "half" }],
            endOffset: 2,
          },
        ],
        endOffset: 2,
        turns: [{ turnId: "1", state: "running" }],
      }),
      emptyLegacyState(),
      NOW,
    );
    expect(state.open).toBe(true);
    expect(activityOf(state)?.phase).toBe("responding");
    // 实时分块接着最后一条助手消息，不另起一条。
    const next = applyUpdate(state, chunk(" more"), NOW + 1);
    expect(find(next, "assistant")).toHaveLength(1);
  });

  it("closes the turn with the outcome the live record carries", () => {
    const state = fromLog(
      log({
        entries: [
          {
            role: "user",
            blocks: [{ type: "text", text: "go" }],
            endOffset: 1,
          },
        ],
        endOffset: 1,
        turns: [
          {
            turnId: "1",
            state: "ended",
            error: { code: "acp_protocol", message: "boom" },
          },
        ],
      }),
      emptyLegacyState(),
      NOW,
    );
    expect(find(state, "turn")[0]?.error?.message).toBe("boom");
    expect(activityOf(state)).toMatchObject({
      phase: "idle",
      lastOutcome: { kind: "failed", error: "boom" },
    });
  });

  it("restores the head values and the plan from the live snapshot", () => {
    const state = fromLog(
      log({
        entries: [
          {
            role: "user",
            blocks: [{ type: "text", text: "plan" }],
            endOffset: 1,
          },
        ],
        endOffset: 1,
        turns: [],
        modes: {
          currentModeId: "plan",
          availableModes: [{ id: "plan", name: "Plan" }],
        },
        snapshot: {
          plan: [{ content: "one", status: "completed" }],
          usage: { used: 1, size: 2 },
          availableCommands: [{ name: "review", description: "" }],
          title: "T",
        },
      }),
      emptyLegacyState(),
      NOW,
    );
    expect(state.timeline.head).toMatchObject({
      modes: { currentModeId: "plan" },
      usage: { used: 1, size: 2 },
      commands: [{ name: "review" }],
      title: "T",
    });
    expect(find(state, "plan")[0]?.entries).toHaveLength(1);
  });

  it("puts a pending permission back, with a tool row to hang it on", () => {
    const state = fromLog(
      log({
        pending: [
          {
            pendingId: "p1",
            protocol: "acp",
            toolCall: { toolCallId: "t9", title: "write a.ts" },
            options: [{ optionId: "y", name: "Allow", kind: "allow_once" }],
          },
        ],
      }),
      emptyLegacyState(),
      NOW,
    );
    expect(find(state, "tool")[0]).toMatchObject({
      toolCallId: "t9",
      title: "write a.ts",
    });
    expect(find(state, "approval")[0]).toMatchObject({
      pendingId: "p1",
      toolCallId: "t9",
      state: "pending",
    });
    expect(activityOf(state)?.phase).toBe("awaiting_approval");
  });

  it("cancels what the live process no longer lists", () => {
    const first = fromLog(
      log({
        elicitations: [
          {
            pendingId: "e1",
            protocol: "acp",
            elicitation: { message: "Which?", mode: "form" },
          },
        ],
      }),
      emptyLegacyState(),
      NOW,
    );
    expect(find(first, "elicitation")[0]?.state).toBe("pending");
    const second = fromLog(log({ elicitations: [] }), first, NOW + 1);
    // 重建是整份重来：没有在列的就不在了。
    expect(find(second, "elicitation")).toHaveLength(0);
  });
});

describe("live updates", () => {
  it("opens an implicit turn for output that arrives without a prompt", () => {
    const state = applyUpdate(emptyLegacyState(), chunk("hello"), NOW);
    expect(kinds(state)).toEqual(["turn", "assistant"]);
    expect(state.open).toBe(true);
  });

  it("does not open a turn for metadata updates", () => {
    const state = applyUpdate(
      emptyLegacyState(),
      {
        sessionUpdate: "usage_update",
        used: 3,
        size: 10,
      },
      NOW,
    );
    expect(state.turn).toBe(0);
    expect(state.timeline.head.usage).toMatchObject({ used: 3, size: 10 });
  });

  it("ignores the adapter's echo of the sentence the page already drew", () => {
    let state = beginTurn(emptyLegacyState(), NOW, {
      clientTurnId: "c1",
      text: "hi",
    });
    state = applyUpdate(state, chunk("hi", "user_message_chunk"), NOW + 1);
    expect(find(state, "user")).toHaveLength(1);
    expect(find(state, "user")[0]?.text).toBe("hi");
    expect(find(state, "user")[0]?.clientTurnId).toBe("c1");
  });

  it("starts a new turn for a user chunk when none is open (replay, another device)", () => {
    let state = beginTurn(emptyLegacyState(), NOW);
    state = endTurn(state, { stopReason: "end_turn" }, NOW + 1);
    state = applyUpdate(state, chunk("again", "user_message_chunk"), NOW + 2);
    expect(state.turn).toBe(2);
    expect(find(state, "user")[0]?.text).toBe("again");
  });

  it("merges chunks into one message and closes it with the turn", () => {
    let state = beginTurn(emptyLegacyState(), NOW, {
      clientTurnId: "c1",
      text: "q",
    });
    state = applyUpdate(state, chunk("Running "), NOW + 1);
    state = applyUpdate(state, chunk("tests"), NOW + 2);
    expect(textOf(find(state, "assistant")[0]!)).toBe("Running tests");
    expect(activityOf(state)?.phase).toBe("responding");
    state = endTurn(state, { stopReason: "end_turn" }, NOW + 3);
    expect(find(state, "assistant")[0]?.streaming).toBe(false);
    expect(find(state, "turn")[0]?.stopReason).toBe("end_turn");
  });

  it("settles running tools and cancels pending questions when the turn ends", () => {
    let state = beginTurn(emptyLegacyState(), NOW);
    state = applyUpdate(
      state,
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "pnpm test",
        kind: "execute",
        status: "in_progress",
      },
      NOW + 1,
    );
    expect(activityOf(state)).toMatchObject({
      phase: "tool",
      detail: { label: "pnpm test" },
    });
    state = addElicitation(
      state,
      { pendingId: "e1", elicitation: { message: "Which?", mode: "form" } },
      NOW + 2,
    );
    state = endTurn(state, { stopReason: "end_turn" }, NOW + 3);
    expect(find(state, "tool")[0]?.status).toBe("completed");
    expect(find(state, "elicitation")[0]?.state).toBe("cancelled");
  });

  it("answers an approval and cancels it when the turn ends first", () => {
    let state = beginTurn(emptyLegacyState(), NOW);
    const approval = {
      pendingId: "p1",
      toolCall: { toolCallId: "t1", title: "rm" },
      options: [{ optionId: "y", name: "Y", kind: "allow_once" as const }],
    };
    state = addApproval(state, approval, NOW + 1);
    state = addApproval(state, approval, NOW + 2);
    expect(find(state, "approval")).toHaveLength(1);
    const answered = resolvePending(state, "p1");
    expect(find(answered, "approval")[0]?.state).toBe("answered");
    const ended = endTurn(state, {}, NOW + 3);
    expect(find(ended, "approval")[0]?.state).toBe("cancelled");
  });
});

describe("unconfirmed prompts", () => {
  const local = { clientTurnId: "c1", text: "go" } as const;

  it("draws the prompt again when the mirror does not have it yet", () => {
    let state = beginTurn(emptyLegacyState(), NOW, local);
    state = fromLog(log({ turns: [] }), state, NOW + 1);
    expect(find(state, "user")[0]).toMatchObject({
      text: "go",
      clientTurnId: "c1",
    });
    expect(state.locals).toHaveLength(1);
  });

  it("drops it once the mirror and the turn record both carry it", () => {
    let state = beginTurn(emptyLegacyState(), NOW, local);
    state = fromLog(
      log({
        entries: [
          {
            role: "user",
            blocks: [{ type: "text", text: "go" }],
            endOffset: 1,
          },
          {
            role: "assistant",
            blocks: [{ type: "text", text: "done" }],
            endOffset: 2,
          },
        ],
        endOffset: 2,
        turns: [{ turnId: "1", clientTurnId: "c1", state: "ended" }],
      }),
      state,
      NOW + 1,
    );
    expect(state.locals).toHaveLength(0);
    expect(find(state, "user")).toHaveLength(1);
    expect(state.open).toBe(false);
  });

  it("keeps drawing it when core has the turn but the mirror is behind", () => {
    let state = beginTurn(emptyLegacyState(), NOW, local);
    state = fromLog(
      log({ turns: [{ turnId: "1", clientTurnId: "c1", state: "running" }] }),
      state,
      NOW + 1,
    );
    expect(find(state, "user")[0]?.text).toBe("go");
    expect(state.open).toBe(true);
    expect(confirmLocal(state, "c1").locals).toHaveLength(0);
  });
});
