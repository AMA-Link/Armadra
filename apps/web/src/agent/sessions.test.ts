import { scoped } from "../sources/scope";
import { describe, expect, it } from "vitest";
import type { AgentStatus, SessionSummary } from "@armadra/shared";

import {
  agentExited,
  basename,
  filterSessions,
  groupSessionsByStatus,
  mergeSessions,
  sessionBucket,
  type SessionRow,
} from "./sessions";

const BASE = Date.parse("2026-09-04T10:00:00.000Z");
const at = (offset: number) => new Date(BASE + offset).toISOString();

function summary(
  partial: Partial<SessionSummary> & { nodeId: string },
): SessionSummary {
  return {
    boardId: "board",
    sessionId: `s-${partial.nodeId}`,
    kind: "terminal",
    title: partial.nodeId,
    cwd: "/repo",
    unread: false,
    updatedAt: at(0),
    alive: true,
    ...partial,
  };
}

function row(partial: Partial<SessionRow> & { nodeId: string }): SessionRow {
  return {
    boardId: "board",
    sessionId: "s1",
    title: partial.nodeId,
    cwd: "/repo/api",
    unread: false,
    updatedAt: at(0),
    alive: true,
    sinceMs: 0,
    ...partial,
  };
}

describe("mergeSessions", () => {
  it("prefers the status mirror when it is fresher and sorts by recency", () => {
    const statuses: Record<string, AgentStatus> = {
      [scoped("a")]: {
        nodeId: "a",
        workspaceId: "w",
        agentId: "claude",
        state: "done",
        unread: true,
        verified: true,
        restored: false,
        updatedAt: at(5_000),
      },
    };
    const rows = mergeSessions(
      [
        summary({ nodeId: "a", state: "working", updatedAt: at(0) }),
        summary({ nodeId: "b", updatedAt: at(1_000) }),
      ],
      statuses,
      BASE + 9_000,
    );

    expect(rows.map((entry) => entry.nodeId)).toEqual(["a", "b"]);
    expect(rows[0]!.state).toBe("done");
    expect(rows[0]!.unread).toBe(true);
    expect(rows[0]!.agentId).toBe("claude");
    expect(rows[0]!.sinceMs).toBe(4_000);
    expect(rows[1]!.sinceMs).toBe(8_000);
  });

  it("keeps the summary when the mirror is older", () => {
    const rows = mergeSessions(
      [summary({ nodeId: "a", state: "working", updatedAt: at(5_000) })],
      {
        a: {
          nodeId: "a",
          workspaceId: "w",
          agentId: "claude",
          state: "done",
          unread: false,
          verified: false,
          restored: true,
          updatedAt: at(0),
        },
      },
      BASE + 5_000,
    );
    expect(rows[0]!.state).toBe("working");
  });

  it("carries the session phase from whichever side is fresher", () => {
    const rows = mergeSessions(
      [
        summary({ nodeId: "a", sessionPhase: "start", updatedAt: at(0) }),
        summary({ nodeId: "b", sessionPhase: "start", updatedAt: at(0) }),
      ],
      {
        [scoped("a")]: {
          nodeId: "a",
          workspaceId: "w",
          agentId: "claude",
          sessionPhase: "end",
          unread: false,
          verified: true,
          restored: false,
          updatedAt: at(1_000),
        },
      },
      BASE + 2_000,
    );
    const byNode = new Map(rows.map((entry) => [entry.nodeId, entry]));
    expect(byNode.get("a")!.sessionPhase).toBe("end");
    expect(byNode.get("b")!.sessionPhase).toBe("start");
  });
});

describe("sessionBucket", () => {
  it("ranks attention over unread over working", () => {
    expect(sessionBucket(row({ nodeId: "a", state: "blocked" }))).toBe(
      "attention",
    );
    expect(sessionBucket(row({ nodeId: "a", state: "waiting" }))).toBe(
      "attention",
    );
    expect(
      sessionBucket(row({ nodeId: "a", state: "done", pendingId: "p" })),
    ).toBe("attention");
    expect(
      sessionBucket(row({ nodeId: "a", state: "done", unread: true })),
    ).toBe("unread");
    expect(sessionBucket(row({ nodeId: "a", state: "working" }))).toBe(
      "working",
    );
    expect(sessionBucket(row({ nodeId: "a", state: "done" }))).toBe("idle");
    expect(sessionBucket(row({ nodeId: "a" }))).toBe("unknown");
  });

  it("新开的 CLI（SessionStart 清掉了 state）是空闲，不是未知", () => {
    expect(sessionBucket(row({ nodeId: "a", sessionPhase: "start" }))).toBe(
      "idle",
    );
  });
});

describe("agentExited", () => {
  it("SessionEnd 之后 Agent 已退出，除非还有正在跑或在等人的状态", () => {
    expect(agentExited(row({ nodeId: "a", sessionPhase: "end" }))).toBe(true);
    expect(
      agentExited(row({ nodeId: "a", sessionPhase: "end", state: "done" })),
    ).toBe(true);
    expect(
      agentExited(row({ nodeId: "a", sessionPhase: "end", state: "working" })),
    ).toBe(false);
    expect(
      agentExited(row({ nodeId: "a", sessionPhase: "end", pendingId: "p" })),
    ).toBe(false);
    expect(agentExited(row({ nodeId: "a", sessionPhase: "start" }))).toBe(
      false,
    );
    expect(agentExited(row({ nodeId: "a" }))).toBe(false);
  });
});

describe("groupSessionsByStatus", () => {
  it("keeps the section order and drops empty sections", () => {
    const sections = groupSessionsByStatus([
      row({ nodeId: "idle", state: "done" }),
      row({ nodeId: "work", state: "working", updatedAt: at(2_000) }),
      row({ nodeId: "need", state: "blocked" }),
      row({ nodeId: "work2", state: "working", updatedAt: at(4_000) }),
    ]);

    expect(sections.map((section) => section.bucket)).toEqual([
      "attention",
      "working",
      "idle",
    ]);
    expect(sections[1]!.rows.map((entry) => entry.nodeId)).toEqual([
      "work2",
      "work",
    ]);
  });
});

describe("filterSessions", () => {
  it("matches title and directory, case-insensitively", () => {
    const rows = [
      row({ nodeId: "a", title: "Claude · API" }),
      row({ nodeId: "b", title: "zsh", cwd: "/repo/web" }),
    ];
    expect(filterSessions(rows, "claude").map((entry) => entry.nodeId)).toEqual(
      ["a"],
    );
    expect(filterSessions(rows, "WEB").map((entry) => entry.nodeId)).toEqual([
      "b",
    ]);
    expect(filterSessions(rows, "  ")).toHaveLength(2);
  });
});

describe("basename", () => {
  it("takes the last segment and tolerates trailing separators", () => {
    expect(basename("/repo/apps/web")).toBe("web");
    expect(basename("/repo/apps/web/")).toBe("web");
    expect(basename("C:\\repo\\web")).toBe("web");
    expect(basename("repo")).toBe("repo");
  });
});
