import { describe, expect, it } from "vitest";
import type { SessionRow } from "../agent/sessions";

import {
  AGENT_BUCKET_ORDER,
  agentSections,
  bucketTone,
  isListedAgent,
} from "./agent-panel";

function row(patch: Partial<SessionRow> & { nodeId: string }): SessionRow {
  return {
    boardId: "b1",
    sessionId: `s-${patch.nodeId}`,
    title: patch.nodeId,
    cwd: "/repo",
    agentId: "claude",
    unread: false,
    updatedAt: "2026-09-05T10:00:00.000Z",
    alive: true,
    sinceMs: 0,
    ...patch,
  };
}

const ids = (sections: ReturnType<typeof agentSections>) =>
  sections.map((section) => ({
    boardId: section.boardId,
    nodes: section.entries.map((entry) => entry.row.nodeId),
  }));

describe("isListedAgent", () => {
  it("普通终端（没有 agentId）不算 Agent", () => {
    expect(isListedAgent(row({ nodeId: "shell", agentId: undefined }))).toBe(
      false,
    );
  });

  it("进程已经结束的不列", () => {
    expect(isListedAgent(row({ nodeId: "dead", alive: false }))).toBe(false);
  });

  it("Agent 已经 SessionEnd、退回 shell 的终端不列", () => {
    expect(isListedAgent(row({ nodeId: "gone", sessionPhase: "end" }))).toBe(
      false,
    );
    // 阶段落后于正在跑的回合时，以回合为准。
    expect(
      isListedAgent(
        row({ nodeId: "busy", sessionPhase: "end", state: "working" }),
      ),
    ).toBe(true);
  });

  it("刚启动、还没报告过状态的 Agent 照列", () => {
    expect(isListedAgent(row({ nodeId: "fresh", sessionPhase: "start" }))).toBe(
      true,
    );
    expect(isListedAgent(row({ nodeId: "silent" }))).toBe(true);
  });
});

describe("agentSections", () => {
  it("按画布分区：当前画布在前，其余按侧栏顺序，不认识的画布最后", () => {
    const sections = agentSections(
      [
        row({ nodeId: "x", boardId: "stray" }),
        row({ nodeId: "a", boardId: "b1" }),
        row({ nodeId: "c", boardId: "b3" }),
        row({ nodeId: "b", boardId: "b2" }),
      ],
      { currentBoardId: "b3", boardOrder: ["b1", "b2", "b3"] },
    );
    expect(sections.map((section) => section.boardId)).toEqual([
      "b3",
      "b1",
      "b2",
      "stray",
    ]);
  });

  it("区内按「需要你 → 运行中 → 未读 → 空闲 → 未知」，同状态最近的在前", () => {
    const sections = agentSections([
      row({ nodeId: "unknown" }),
      row({ nodeId: "idle", state: "done" }),
      row({ nodeId: "fresh", sessionPhase: "start" }),
      row({ nodeId: "unread", state: "done", unread: true }),
      row({ nodeId: "working-old", state: "working" }),
      row({
        nodeId: "working-new",
        state: "working",
        updatedAt: "2026-09-05T11:00:00.000Z",
      }),
      row({ nodeId: "attention", state: "waiting" }),
    ]);
    expect(ids(sections)).toEqual([
      {
        boardId: "b1",
        nodes: [
          "attention",
          "working-new",
          "working-old",
          "unread",
          "fresh",
          "idle",
          "unknown",
        ],
      },
    ]);
    expect(sections[0]!.entries.map((entry) => entry.bucket)).toEqual([
      "attention",
      "working",
      "working",
      "unread",
      "idle",
      "idle",
      "unknown",
    ]);
  });

  it("普通终端、已结束与已退出的 Agent 都不进面板", () => {
    const sections = agentSections([
      row({ nodeId: "shell", agentId: undefined, title: "MacBookPro.local" }),
      row({ nodeId: "dead", state: "working", alive: false }),
      row({ nodeId: "gone", sessionPhase: "end" }),
      row({ nodeId: "live", state: "working" }),
    ]);
    expect(ids(sections)).toEqual([{ boardId: "b1", nodes: ["live"] }]);
  });

  it("同一个节点只留一行，取更新的那行", () => {
    const sections = agentSections([
      row({ nodeId: "a", sessionId: "s-old", state: "done" }),
      row({
        nodeId: "a",
        sessionId: "s-new",
        state: "working",
        updatedAt: "2026-09-05T12:00:00.000Z",
      }),
    ]);
    expect(sections[0]!.entries.map((entry) => entry.row.sessionId)).toEqual([
      "s-new",
    ]);
  });

  it("同名的不同节点各占一行，分在各自的画布里", () => {
    const sections = agentSections(
      [
        row({ nodeId: "n1", title: "Agent 1", boardId: "b1" }),
        row({ nodeId: "n2", title: "Agent 1", boardId: "b2" }),
      ],
      { boardOrder: ["b1", "b2"] },
    );
    expect(ids(sections)).toEqual([
      { boardId: "b1", nodes: ["n1"] },
      { boardId: "b2", nodes: ["n2"] },
    ]);
  });

  it("空列表就没有分区", () => {
    expect(agentSections([])).toEqual([]);
  });
});

describe("bucketTone", () => {
  it("每个状态都有胶囊色，未知与空闲同色", () => {
    expect(AGENT_BUCKET_ORDER.map(bucketTone)).toEqual([
      "attention",
      "working",
      "unread",
      "idle",
      "idle",
    ]);
  });
});
