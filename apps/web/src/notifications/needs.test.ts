import { describe, expect, it } from "vitest";
import type { HandoffView } from "@armadra/shared";

import type { SessionRow } from "../agent/sessions";
import { collectNeeds, groupNeeds, type NeedItem } from "./needs";

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 9, 17, 10, 0, seconds)).toISOString();

function row(partial: Partial<SessionRow> & { nodeId: string }): SessionRow {
  return {
    boardId: "b1",
    sessionId: `s-${partial.nodeId}`,
    title: partial.nodeId,
    cwd: "/repo",
    agentId: "claude",
    unread: false,
    updatedAt: at(0),
    alive: true,
    sinceMs: 0,
    ...partial,
  };
}

function handoff(state: string, nodeId = "n1"): HandoffView {
  return {
    bundle: {
      handoffId: `h-${nodeId}-${state}`,
      source: { nodeId, nodeTitle: "来源" },
    },
    state,
    updatedAt: at(5),
  } as unknown as HandoffView;
}

describe("collectNeeds", () => {
  it("只收审批、等待回答、出错，空闲/未知/运行中/完成都不收", () => {
    const items = collectNeeds([
      {
        workspaceId: "w1",
        rows: [
          row({ nodeId: "approval", state: "blocked" }),
          row({ nodeId: "pending", state: "working", pendingId: "p" }),
          row({ nodeId: "input", state: "waiting" }),
          row({ nodeId: "error", state: "done", errored: true, unread: true }),
          row({ nodeId: "seen", state: "done", errored: true }),
          row({ nodeId: "started", sessionPhase: "start" }),
          row({ nodeId: "unknown" }),
          row({ nodeId: "working", state: "working" }),
          row({ nodeId: "done", state: "done", unread: true }),
          row({ nodeId: "dead", state: "blocked", alive: false }),
        ],
        handoffs: [],
      },
    ]);
    expect(items.map((item) => [item.nodeId, item.need])).toEqual([
      ["approval", "approval"],
      ["pending", "approval"],
      ["input", "input"],
      ["error", "error"],
    ]);
  });

  it("交接只有冻结未批准的算，挂在来源节点所在的画布", () => {
    const items = collectNeeds([
      {
        workspaceId: "w1",
        rows: [row({ nodeId: "n1", boardId: "b2", state: "working" })],
        handoffs: [
          handoff("prepared"),
          handoff("queued"),
          handoff("acknowledged"),
          handoff("cancelled"),
          handoff("prepared", "gone"),
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      workspaceId: "w1",
      boardId: "b2",
      nodeId: "n1",
      need: "handoff",
      title: "来源",
    });
  });

  it("答复之后（状态回到运行中）清单里就没有了", () => {
    const before = collectNeeds([
      {
        workspaceId: "w1",
        rows: [row({ nodeId: "a", state: "blocked", pendingId: "p" })],
        handoffs: [],
      },
    ]);
    const after = collectNeeds([
      {
        workspaceId: "w1",
        rows: [row({ nodeId: "a", state: "working" })],
        handoffs: [],
      },
    ]);
    expect(before).toHaveLength(1);
    expect(after).toEqual([]);
  });
});

describe("groupNeeds", () => {
  const item = (partial: Partial<NeedItem> & { nodeId: string }): NeedItem => ({
    key: `${partial.workspaceId ?? "w1"}:${partial.nodeId}`,
    workspaceId: "w1",
    boardId: "b1",
    title: partial.nodeId,
    need: "input",
    updatedAt: at(0),
    ...partial,
  });
  const layout = {
    workspaces: [
      {
        id: "w1",
        name: "前端",
        boards: [
          { id: "b1", name: "画布 1" },
          { id: "b2", name: "画布 2" },
        ],
      },
      { id: "w2", name: "后端", boards: [{ id: "b3", name: "画布 3" }] },
    ],
  };

  it("按 工作空间 → 画布 → 节点 分层，每层带计数", () => {
    const groups = groupNeeds(
      [
        item({ nodeId: "a" }),
        item({ nodeId: "b", boardId: "b2" }),
        item({ nodeId: "c", boardId: "b2" }),
        item({ nodeId: "d", workspaceId: "w2", boardId: "b3" }),
      ],
      layout,
    );
    expect(
      groups.map((workspace) => [
        workspace.name,
        workspace.count,
        workspace.boards.map((board) => [
          board.name,
          board.count,
          board.items.map((entry) => entry.nodeId),
        ]),
      ]),
    ).toEqual([
      [
        "前端",
        3,
        [
          ["画布 1", 1, ["a"]],
          ["画布 2", 2, ["b", "c"]],
        ],
      ],
      ["后端", 1, [["画布 3", 1, ["d"]]]],
    ]);
  });

  it("当前工作空间与当前画布在前，没有事的层不出现", () => {
    const groups = groupNeeds(
      [
        item({ nodeId: "a" }),
        item({ nodeId: "b", boardId: "b2" }),
        item({ nodeId: "d", workspaceId: "w2", boardId: "b3" }),
      ],
      { ...layout, currentWorkspaceId: "w2", currentBoardId: "b2" },
    );
    expect(groups.map((workspace) => workspace.workspaceId)).toEqual([
      "w2",
      "w1",
    ]);
    expect(groups[1]!.boards.map((board) => board.boardId)).toEqual([
      "b2",
      "b1",
    ]);
    expect(groupNeeds([], { ...layout, currentWorkspaceId: "w1" })).toEqual([]);
  });

  it("节点先排审批，再等待回答、出错、交接，同类里新的在前", () => {
    const [group] = groupNeeds(
      [
        item({ nodeId: "handoff", need: "handoff", updatedAt: at(9) }),
        item({ nodeId: "error", need: "error", updatedAt: at(9) }),
        item({ nodeId: "old-input", need: "input", updatedAt: at(1) }),
        item({ nodeId: "new-input", need: "input", updatedAt: at(8) }),
        item({ nodeId: "approval", need: "approval", updatedAt: at(0) }),
      ],
      layout,
    );
    expect(group!.boards[0]!.items.map((entry) => entry.nodeId)).toEqual([
      "approval",
      "new-input",
      "old-input",
      "error",
      "handoff",
    ]);
  });
});
