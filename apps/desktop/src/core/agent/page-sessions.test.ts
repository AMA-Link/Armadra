import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBoard,
  deleteBoard,
  ensureSessionBoard,
  isSessionBoard,
  listBoards,
  sessionBoardOf,
  updateBoard,
} from "../canvas/boards";
import { loadBoard } from "../canvas/documents";
import {
  setAdapterProbeForTest,
  setViewPreferenceForTest,
} from "../collab/control/agent-driver";
import { setDependencyService } from "../dependencies/registry";
import type { DependencyService } from "../dependencies/service";
import { launchFor } from "../dependencies/store";
import { nodeCreator } from "../identity/creators";
import { listWorkspaces } from "../workspaces/table";
import { type AgentFixture, agentFixture } from "./fixture";
import { startPageSession } from "./page-sessions";

let fixture: AgentFixture;
let created: string[];

beforeEach(() => {
  fixture = agentFixture();
  created = [];
  setDependencyService({
    created: async (nodeId: string) => {
      created.push(nodeId);
      return undefined;
    },
  } as unknown as DependencyService);
  // 适配器都当装好了；默认视图偏好按 ACP。
  setAdapterProbeForTest(() => "/usr/local/bin/adapter");
  setViewPreferenceForTest("acp");
});

afterEach(() => {
  setDependencyService(undefined);
  setAdapterProbeForTest();
  setViewPreferenceForTest();
  fixture.close();
});

describe("会话板", () => {
  it("懒建、每个工作空间只有一块，不出现在画板列表与工作空间摘要里", () => {
    expect(
      sessionBoardOf(fixture.database, fixture.workspaceId),
    ).toBeUndefined();
    const first = ensureSessionBoard(fixture.database, fixture.workspaceId);
    const again = ensureSessionBoard(fixture.database, fixture.workspaceId);
    expect(again.id).toBe(first.id);
    expect(isSessionBoard(fixture.database, first.id)).toBe(true);
    expect(isSessionBoard(fixture.database, fixture.boardId)).toBe(false);
    const listed = listBoards(fixture.database, fixture.workspaceId).map(
      (board) => board.id,
    );
    expect(listed).toContain(fixture.boardId);
    expect(listed).not.toContain(first.id);
    const summary = listWorkspaces(fixture.database).find(
      (workspace) => workspace.id === fixture.workspaceId,
    );
    expect(summary?.boards.map((board) => board.id)).not.toContain(first.id);
  });

  it("画板接口改不了也删不掉它（答 404）；新画板的排序不算它", () => {
    const sessions = ensureSessionBoard(fixture.database, fixture.workspaceId);
    expect(() =>
      updateBoard(fixture.database, fixture.workspaceId, sessions.id, {
        name: "x",
      }),
    ).toThrow(/not found/u);
    expect(() =>
      deleteBoard(fixture.database, fixture.workspaceId, sessions.id),
    ).toThrow(/not found/u);
    expect(isSessionBoard(fixture.database, sessions.id)).toBe(true);
    const canvases = listBoards(fixture.database, fixture.workspaceId);
    const next = createBoard(fixture.database, fixture.workspaceId, "Next");
    expect(next.sortOrder).toBe(
      Math.max(...canvases.map((board) => board.sortOrder)) + 1,
    );
  });

  it("仍是一块普通的板：载入得到", () => {
    const sessions = ensureSessionBoard(fixture.database, fixture.workspaceId);
    expect(
      loadBoard(fixture.database, fixture.workspaceId, sessions.id).nodes,
    ).toEqual([]);
  });
});

describe("startPageSession", () => {
  it("在会话板上建 Agent 节点，记触发者，交给依赖编排去起", () => {
    const started = startPageSession(
      fixture.collab,
      { workspaceId: fixture.workspaceId, agentId: "claude", model: "opus" },
      1_000,
    );
    expect(isSessionBoard(fixture.database, started.boardId)).toBe(true);
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      started.boardId,
    );
    const node = document.nodes.find((entry) => entry.id === started.nodeId);
    expect(node?.type).toBe("terminal");
    expect(node?.title).toBe(started.title);
    expect(node?.data).toMatchObject({
      kind: "terminal",
      agent: { id: "claude", model: "opus", driver: "acp" },
    });
    expect(nodeCreator(fixture.database, started.nodeId)).toBe("");
    expect(launchFor(fixture.database, started.nodeId)).toMatchObject({
      nodeId: started.nodeId,
      boardId: started.boardId,
    });
    expect(created).toEqual([started.nodeId]);
    expect(fixture.events.at(-1)?.event).toMatchObject({
      type: "board.changed",
      boardId: started.boardId,
    });
  });

  it("显式 driver 优先于偏好；标题可给；第二个会话不叠在第一个上", () => {
    const one = startPageSession(
      fixture.collab,
      {
        workspaceId: fixture.workspaceId,
        agentId: "codex",
        driver: "terminal",
        title: "审查",
      },
      1_000,
    );
    const two = startPageSession(
      fixture.collab,
      { workspaceId: fixture.workspaceId, agentId: "claude" },
      1_000,
    );
    expect(two.boardId).toBe(one.boardId);
    const nodes = loadBoard(
      fixture.database,
      fixture.workspaceId,
      one.boardId,
    ).nodes;
    const first = nodes.find((node) => node.id === one.nodeId);
    const second = nodes.find((node) => node.id === two.nodeId);
    expect(first?.title).toBe("审查");
    expect((first?.data as { agent: { driver?: string } }).agent.driver).toBe(
      "terminal",
    );
    expect(second?.position).not.toEqual(first?.position);
    // 会话不出现在画布上。
    expect(
      loadBoard(fixture.database, fixture.workspaceId, fixture.boardId).nodes,
    ).toEqual([]);
  });

  it("不认识的 Agent 400，被设置关掉的 403，工作空间不在 404；都不留下节点", () => {
    expect(() =>
      startPageSession(
        fixture.collab,
        { workspaceId: fixture.workspaceId, agentId: "nope" },
        1_000,
      ),
    ).toThrow(expect.objectContaining({ status: 400 }));
    fixture.disabledAgents.push("codex");
    expect(() =>
      startPageSession(
        fixture.collab,
        { workspaceId: fixture.workspaceId, agentId: "codex" },
        1_000,
      ),
    ).toThrow(expect.objectContaining({ status: 403, code: "agent_disabled" }));
    expect(() =>
      startPageSession(
        fixture.collab,
        {
          workspaceId: "019ff7d1-0d12-7421-833d-2c5e8d64edff",
          agentId: "claude",
        },
        1_000,
      ),
    ).toThrow(expect.objectContaining({ status: 404 }));
    expect(
      sessionBoardOf(fixture.database, fixture.workspaceId),
    ).toBeUndefined();
    expect(created).toEqual([]);
  });
});
