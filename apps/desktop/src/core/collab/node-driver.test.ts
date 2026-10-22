import { TRANSCRIPT_AGENT_IDS } from "@armadra/shared";
import { ADAPTERS } from "../timeline/sources";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { loadBoard } from "../canvas/documents";
import { layoutRun } from "../workflow/dispatch";
import {
  newNodeView,
  setAdapterProbeForTest,
  setViewPreferenceForTest,
} from "./control/agent-driver";
import { controlDispatcher, type ControlOutcome } from "./control";
import { resetSendLimits } from "./send-limits";
import { resetInboxWake } from "./wake";

/**
 * 每个建 Agent 节点的入口默认驱动一致。
 *
 * 页面新建菜单用 `preferredDriver`、core 的入口用 `newNodeView`，两边都落在
 * 共享的 `defaultAgentDriver`：设置为 `acp` 且适配器装了才写 `acp`。以前 core
 * 的入口一个 `driver` 都不写，节点被页面与 `spawnForNode` 当终端驱动。
 */

let fixture: AgentFixture;
let me: string;
const installed = new Set<string>();

async function run(
  verb: string,
  args: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, me), args);
}

function ok(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`${outcome.code} ${outcome.message}`);
  return (outcome.body.result ?? outcome.body) as Record<string, unknown>;
}

function agentOf(nodeId: string): Record<string, unknown> {
  const board = loadBoard(
    fixture.database,
    fixture.workspaceId,
    fixture.boardId,
  );
  const node = board.nodes.find((item) => item.id === nodeId);
  return (node?.data as { agent: Record<string, unknown> }).agent;
}

function installAdapter(program: string): void {
  installed.add(program);
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  fixture = agentFixture();
  me = fixture.agentNode("Planner");
  installed.clear();
  setAdapterProbeForTest((program) =>
    installed.has(program) ? `/fake/${program}` : undefined,
  );
});

afterEach(() => {
  setAdapterProbeForTest();
  setViewPreferenceForTest();
  fixture.close();
  resetSendLimits();
  resetInboxWake();
});

describe("the default driver of a new agent node", () => {
  it("is acp when the adapter is installed, terminal when it is not", () => {
    expect(newNodeView(fixture.collab.settings, "claude").driver).toBe(
      "terminal",
    );
    installAdapter("claude-agent-acp");
    expect(newNodeView(fixture.collab.settings, "claude").driver).toBe("acp");
    expect(newNodeView(fixture.collab.settings, "codex").driver).toBe(
      "terminal",
    );
  });

  it("is the same for open-agent, team and workflow roles", async () => {
    installAdapter("claude-agent-acp");
    installAdapter("codex-acp");

    const single = ok(await run("open-agent", { agent: "claude" }));
    const team = ok(
      await run("team", { member: ["claude|甲|a", "codex|乙|b"] }),
    ) as { members: { id: string }[] };
    const layout = await layoutRun(fixture.collab, {
      workspaceId: fixture.workspaceId,
      boardId: fixture.boardId,
      title: "run",
      runId: "r1",
      roles: [
        { id: "a", agentId: "claude", title: "A" },
        { id: "b", agentId: "codex", title: "B" },
      ],
      links: [],
    });

    const drivers = [
      agentOf(single.id as string).driver,
      ...team.members.map((member) => agentOf(member.id).driver),
      ...Object.values(layout.roles).map((id) => agentOf(id).driver),
    ];
    expect(drivers).toEqual(Array(5).fill("acp"));
  });

  it("falls back to terminal in every entry when the adapter is missing", async () => {
    const single = ok(await run("open-agent", { agent: "claude" }));
    const team = ok(await run("team", { member: ["claude|甲|a"] })) as {
      members: { id: string }[];
    };
    const layout = await layoutRun(fixture.collab, {
      workspaceId: fixture.workspaceId,
      boardId: fixture.boardId,
      title: "run",
      runId: "r2",
      roles: [{ id: "a", agentId: "claude", title: "A" }],
      links: [],
    });
    const drivers = [
      agentOf(single.id as string).driver,
      agentOf(team.members[0]!.id).driver,
      agentOf(Object.values(layout.roles)[0]!).driver,
    ];
    // 偏好「会话」（缺省）：没有 ACP 适配器，但 claude 有转录适配器 → 会话体。
    expect(drivers).toEqual(["terminal", "terminal", "terminal"]);
  });

  it("keeps a custom agent with its own launch program on the terminal", async () => {
    installAdapter("claude-agent-acp");
    fixture.customAgents.push({
      id: "custom:echo",
      label: "echo",
      launchCmd: "/bin/echo",
      baseAgent: "claude",
    } as never);
    const made = ok(await run("open-agent", { agent: "custom:echo" }));
    expect(agentOf(made.id as string).driver).toBe("terminal");
  });

  it("keeps a resume request on the terminal driver", async () => {
    installAdapter("claude-agent-acp");
    const resumed = ok(
      await run("open-agent", { agent: "claude", resume: "abc-123" }),
    );
    expect(agentOf(resumed.id as string).driver).toBeUndefined();
  });
});

// #462：每个入口的节点体都跟随用户的默认视图偏好。
describe("the body of a new agent node follows the view preference", () => {
  async function everyEntry(): Promise<Record<string, unknown>[]> {
    const single = ok(await run("open-agent", { agent: "claude" }));
    const team = ok(await run("team", { member: ["claude|甲|a"] })) as {
      members: { id: string }[];
    };
    const resumed = ok(
      await run("open-agent", { agent: "claude", resume: "abc-123" }),
    );
    const layout = await layoutRun(fixture.collab, {
      workspaceId: fixture.workspaceId,
      boardId: fixture.boardId,
      title: "run",
      runId: `r-${Math.random()}`,
      roles: [{ id: "a", agentId: "claude", title: "A" }],
      links: [],
    });
    return [
      agentOf(single.id as string),
      agentOf(team.members[0]!.id),
      agentOf(resumed.id as string),
      agentOf(Object.values(layout.roles)[0]!),
    ];
  }

  it("session preference, acp installed: acp everywhere except resume, no terminal body", async () => {
    setViewPreferenceForTest("acp");
    installAdapter("claude-agent-acp");
    const [single, team, resumed, role] = await everyEntry();
    expect([single!.driver, team!.driver, role!.driver]).toEqual([
      "acp",
      "acp",
      "acp",
    ]);
    expect(single!.view).toBeUndefined();
    // resume 只能终端驱动，但节点体仍是会话。
    expect(resumed!.driver).toBeUndefined();
    expect(resumed!.view).toBe("session");
  });

  it("session preference, no acp adapter: terminal driver with the session body", async () => {
    setViewPreferenceForTest("acp");
    const entries = await everyEntry();
    for (const agent of entries) {
      expect(agent.driver === "acp").toBe(false);
      expect(agent.view).toBe("session");
    }
  });

  it("session preference, agent without a transcript adapter: terminal body", () => {
    setViewPreferenceForTest("acp");
    expect(newNodeView(fixture.collab.settings, "grok")).toEqual({
      driver: "terminal",
    });
  });

  it("terminal preference: terminal driver and terminal body in every entry", async () => {
    setViewPreferenceForTest("terminal");
    installAdapter("claude-agent-acp");
    const entries = await everyEntry();
    for (const agent of entries) {
      expect(agent.driver === undefined || agent.driver === "terminal").toBe(
        true,
      );
      expect(agent.view).toBeUndefined();
    }
  });
});

it("the shared transcript list matches the registered adapters", () => {
  expect([...TRANSCRIPT_AGENT_IDS].sort()).toEqual(
    Object.keys(ADAPTERS).sort(),
  );
});
