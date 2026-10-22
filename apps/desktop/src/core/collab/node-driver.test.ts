import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { loadBoard } from "../canvas/documents";
import { layoutRun } from "../workflow/dispatch";
import { newNodeDriver, setAdapterProbeForTest } from "./control/agent-driver";
import { controlDispatcher, type ControlOutcome } from "./control";
import { resetSendLimits } from "./send-limits";
import { resetInboxWake } from "./wake";

/**
 * 每个建 Agent 节点的入口默认驱动一致。
 *
 * 页面新建菜单用 `preferredDriver`、core 的入口用 `newNodeDriver`，两边都落在
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
  fixture.close();
  resetSendLimits();
  resetInboxWake();
});

describe("the default driver of a new agent node", () => {
  it("is acp when the adapter is installed, terminal when it is not", () => {
    expect(newNodeDriver(fixture.collab.settings, "claude")).toBe("terminal");
    installAdapter("claude-agent-acp");
    expect(newNodeDriver(fixture.collab.settings, "claude")).toBe("acp");
    expect(newNodeDriver(fixture.collab.settings, "codex")).toBe("terminal");
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
