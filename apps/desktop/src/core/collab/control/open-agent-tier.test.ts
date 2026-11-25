import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentFixture,
  agentFixture,
  callerFor,
} from "../../agent/fixture";
import { forgetProbes, rememberProbe } from "../../agent/probe";
import { loadBoard } from "../../canvas/documents";
import { controlDispatcher, type ControlOutcome } from "../control";

/** `open-agent --tier`（设计 §2.5）：ama 版本门、claude 别名、`model` 优先、未知忽略。 */

let fixture: AgentFixture;
let me: string;

async function open(args: Record<string, unknown>): Promise<string> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  const outcome: ControlOutcome = await dispatcher.dispatch(
    "open-agent",
    callerFor(fixture, me),
    args,
  );
  if (!outcome.ok) throw new Error(`refused: ${outcome.message}`);
  return (outcome.body.result as { id: string }).id;
}

function agentOf(id: string): Record<string, unknown> {
  const document = loadBoard(
    fixture.database,
    fixture.workspaceId,
    fixture.boardId,
  );
  return (
    document.nodes.find((node) => node.id === id)?.data as {
      agent: Record<string, unknown>;
    }
  ).agent;
}

function probeAma(version: string): void {
  rememberProbe({
    agentId: "ama",
    launchCmd: "ama",
    version,
    status: "ok",
    probedAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  forgetProbes();
  fixture = agentFixture();
  me = fixture.agentNode("Caller");
});

afterEach(() => {
  fixture.close();
  forgetProbes();
});

describe("open-agent --tier", () => {
  it("writes agent.tier for ama only when the probed version supports it", async () => {
    probeAma("0.23.0");
    expect(agentOf(await open({ agent: "ama", tier: "strong" }))).toMatchObject(
      { id: "ama", tier: "strong" },
    );
    forgetProbes();
    probeAma("0.22.0");
    const old = agentOf(await open({ agent: "ama", tier: "strong" }));
    expect(old.tier).toBeUndefined();
    expect(old.model).toBeUndefined();
  });

  it("maps the tier to claude's model alias", async () => {
    const agent = agentOf(await open({ agent: "claude", tier: "light" }));
    expect(agent.model).toBe("haiku");
    expect(agent.tier).toBeUndefined();
  });

  it("lets --model win and ignores an unknown tier or an agent without a mapping", async () => {
    probeAma("0.23.0");
    const both = agentOf(
      await open({ agent: "claude", tier: "light", model: "opus" }),
    );
    expect(both.model).toBe("opus");
    expect(both.tier).toBeUndefined();
    const amaBoth = agentOf(
      await open({ agent: "ama", tier: "strong", model: "m1" }),
    );
    expect(amaBoth).toMatchObject({ model: "m1" });
    expect(amaBoth.tier).toBeUndefined();
    const unknown = agentOf(await open({ agent: "claude", tier: "huge" }));
    expect(unknown.model).toBeUndefined();
    expect(unknown.tier).toBeUndefined();
    const codex = agentOf(await open({ agent: "codex", tier: "max" }));
    expect(codex.model).toBeUndefined();
    expect(codex.tier).toBeUndefined();
  });
});
