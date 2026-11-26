import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { startPageSession } from "../agent/page-sessions";
import { isSessionBoard } from "../canvas/boards";
import { loadBoard } from "../canvas/documents";
import { setDependencyService } from "../dependencies/registry";
import type { DependencyService } from "../dependencies/service";
import { launchFor } from "../dependencies/store";
import { agentEnvironment } from "../terminal/environment";
import { type ControlOutcome, controlDispatcher } from "./control";
import { SESSION_BOARD_HIDDEN_VERBS } from "./control/session-board-verbs";

/**
 * 会话板上的动词（Armadra#1062 S4）：只对画布有意义的当场拒绝、`help` 不列，
 * `open-agent` / `team` 建的成员落在会话板并由 core 起。
 */

let fixture: AgentFixture;
let created: string[];

async function run(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, nodeId), args);
}

function sessionNode(): string {
  return startPageSession(
    fixture.collab,
    {
      workspaceId: fixture.workspaceId,
      agentId: "claude",
      driver: "terminal",
    },
    1_000,
  ).nodeId;
}

beforeEach(() => {
  fixture = agentFixture();
  created = [];
  setDependencyService({
    created: async (nodeId: string) => {
      created.push(nodeId);
      return undefined;
    },
  } as unknown as DependencyService);
});

afterEach(() => {
  setDependencyService(undefined);
  fixture.close();
});

describe("会话板上的画布动词", () => {
  it.each(SESSION_BOARD_HIDDEN_VERBS)(
    "`%s` 答 VERB_NOT_ON_SESSION_BOARD",
    async (verb) => {
      const me = sessionNode();
      const outcome = await run(me, verb, { title: "x", text: "x" });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.status).toBe(400);
      expect(outcome.code).toBe("VERB_NOT_ON_SESSION_BOARD");
    },
  );

  it("画布上的节点照常可用", async () => {
    const me = fixture.agentNode("Caller");
    const outcome = await run(me, "sticky", { text: "note" });
    expect(outcome.ok).toBe(true);
  });

  it("`help` 在会话板上不列它们，画布上全列", async () => {
    const onBoard = await run(fixture.agentNode("Caller"), "help");
    const onSessions = await run(sessionNode(), "help");
    if (!onBoard.ok || !onSessions.ok) throw new Error("help refused");
    const all = (onBoard.body.result as { verbs: string[] }).verbs;
    const usable = (onSessions.body.result as { verbs: string[] }).verbs;
    for (const verb of SESSION_BOARD_HIDDEN_VERBS) {
      expect(all).toContain(verb);
      expect(usable).not.toContain(verb);
    }
    expect(usable).toContain("open-agent");
    expect(usable).toContain("send");
    expect(usable).toContain("link");
  });
});

describe("会话板上的 open-agent / team", () => {
  it("成员落在会话板，连主从线，并由 core 起", async () => {
    const me = sessionNode();
    created = [];
    const outcome = await run(me, "open-agent", { agent: "claude" });
    if (!outcome.ok) throw new Error(outcome.message);
    const childId = (outcome.body.result as { id: string }).id;
    const caller = callerFor(fixture, me);
    expect(isSessionBoard(fixture.database, caller.node.boardId)).toBe(true);
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      caller.node.boardId,
    );
    expect(document.nodes.some((node) => node.id === childId)).toBe(true);
    expect(
      document.edges.find(
        (edge) => edge.source === me && edge.target === childId,
      )?.role,
    ).toBe("supervises");
    expect(launchFor(fixture.database, childId)).toBeDefined();
    expect(created).toContain(childId);
  });

  it("画布上不带依赖的 open-agent 仍交给页面起", async () => {
    const me = fixture.agentNode("Caller");
    const outcome = await run(me, "open-agent", { agent: "claude" });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(
      launchFor(fixture.database, (outcome.body.result as { id: string }).id),
    ).toBe(undefined);
  });

  it("team 的成员同样由 core 起", async () => {
    const me = sessionNode();
    created = [];
    const outcome = await run(me, "team", {
      member: ["claude|一|a", "codex|二|b"],
    });
    if (!outcome.ok) throw new Error(outcome.message);
    const members = (outcome.body.result as { members: { id: string }[] })
      .members;
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(launchFor(fixture.database, member.id)).toBeDefined();
      expect(created).toContain(member.id);
    }
  });
});

describe("ARMADRA_BOARD_KIND", () => {
  it("只在会话板上注入", () => {
    const names = (kind?: string) =>
      agentEnvironment("n", "claude", "/tmp/d", undefined, undefined, kind).map(
        ([name]) => name,
      );
    expect(names("sessions")).toContain("ARMADRA_BOARD_KIND");
    expect(names("canvas")).not.toContain("ARMADRA_BOARD_KIND");
    expect(names()).not.toContain("ARMADRA_BOARD_KIND");
  });
});
