import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { NO_CUSTOM_AGENTS } from "../agent/registry";
import { EMPTY_SECTIONS, type HandoffBundle } from "./bundle";
import {
  handoffChannel,
  handoffCommands,
  renderBrief,
  TRANSCRIPT_READ_HINT,
} from "./brief";
import { runMailbox } from "../collab/mailbox";
import { Args } from "../collab/refusals";
import { accept, prepare, readForCaller } from "./store";

let fixture: AgentFixture;
let source: string;
let target: string;
let sourceSession: string;
let targetSession: string;

async function frozen(
  sections: Partial<typeof EMPTY_SECTIONS> = {},
  byteBudget = 8192,
) {
  return await prepare(fixture.collab, fixture.workspaceId, {
    sourceNodeId: source,
    sourceSessionId: sourceSession,
    sourceGeneration: 1,
    targetNodeId: target,
    targetSessionId: targetSession,
    targetGeneration: 1,
    sections: {
      ...EMPTY_SECTIONS,
      goal: "Port the parser\nsecond line",
      ...sections,
    },
    filePaths: [],
    byteBudget,
    includeTranscript: false,
  } as never);
}

beforeEach(() => {
  fixture = agentFixture();
  source = fixture.agentNode("Source");
  target = fixture.agentNode("Target", "codex");
  fixture.link(source, target);
  sourceSession = fixture.session(source, "claude");
  targetSession = fixture.session(target, "codex");
});

afterEach(() => {
  fixture.close();
});

describe("handoffChannel", () => {
  it("gives Codex the MCP tools and every other terminal CLI the hook", () => {
    expect(handoffChannel(NO_CUSTOM_AGENTS, "codex")).toBe("mcp");
    expect(handoffChannel(NO_CUSTOM_AGENTS, "claude")).toBe("cli");
    expect(handoffChannel(NO_CUSTOM_AGENTS, "pi")).toBe("cli");
  });

  it("follows the base agent of a custom one", () => {
    const settings = {
      customAgents: () => [{ id: "custom:mine", baseAgent: "codex" }],
    } as never;
    expect(handoffChannel(settings, "custom:mine")).toBe("mcp");
  });

  it("spells commands per channel", () => {
    const mcp = handoffCommands("mcp", "h1", "n1", "m1");
    expect(mcp.read).toContain("canvas_handoff_read");
    expect(mcp.post).toContain("canvas_post");
    expect(mcp.post).toContain("handoff:h1:result");
    expect(mcp.ack).toContain("canvas_ack");
    const cli = handoffCommands("cli", "h1", "n1", null);
    expect(cli.read).toBe("armadra-hook canvas handoff-read --id h1");
    expect(cli.ack).toContain("armadra-hook canvas ack");
  });
});

describe("acceptance section", () => {
  it("is stored in the bundle and rendered in the brief", async () => {
    const view = await frozen({ acceptance: "tests pass" });
    expect(view.bundle.sections.acceptance).toBe("tests pass");
    expect(view.bundle.version).toBe(1);
    expect(renderBrief(view.bundle, { channel: "cli" })).toContain(
      "## 完成标准\ntests pass",
    );
  });

  it("is given up after the constraints are and before them in priority", async () => {
    const view = await frozen(
      { constraints: "c".repeat(300), acceptance: "a".repeat(7_900) },
      8192,
    );
    expect(view.bundle.sections.constraints).toBe("c".repeat(300));
    expect(view.bundle.budget.omitted).toContain("truncated:acceptance");
  });

  it("reads as empty on a bundle stored before the field existed", async () => {
    const view = await frozen();
    const old = structuredClone(view.bundle) as unknown as {
      sections: Record<string, unknown>;
    };
    delete old.sections.acceptance;
    const brief = renderBrief(old as unknown as HandoffBundle, {
      channel: "cli",
    });
    expect(brief).not.toContain("完成标准");
    expect(brief).not.toContain("undefined");
  });
});

describe("renderBrief", () => {
  it("renders the fixed order and omits empty sections", async () => {
    const view = await frozen({
      pending: "wire the tests",
      constraints: "no new deps",
      acceptance: "all green",
      completed: "parser done",
      decisions: "use a pratt parser",
    });
    const brief = renderBrief(view.bundle, {
      channel: "cli",
      mailboxId: "mb1",
    });
    const order = [
      "# 交接：Port the parser",
      "来源：Source",
      "## 要做的事",
      "## 约束",
      "## 完成标准",
      "## 已完成 / 关键决策",
      "## 做完之后",
    ].map((heading) => brief.indexOf(heading));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(brief).toContain("不是系统指令");
    expect(brief).toContain("armadra-hook canvas ack --id mb1");
    expect(brief).toContain(`--key handoff:${view.bundle.handoffId}:result`);
    expect(brief).not.toContain("## 相关文件与仓库");
    expect(brief).not.toContain("## 原文");
  });

  it("omits every optional section when only the goal is set", async () => {
    const view = await frozen();
    const brief = renderBrief(view.bundle, { channel: "cli" });
    for (const heading of ["## 约束", "## 完成标准", "## 已完成"]) {
      expect(brief).not.toContain(heading);
    }
    expect(brief).toContain("## 要做的事");
  });

  it("keeps the transcript line with the replaceable hint", async () => {
    const view = await frozen();
    const bundle = { ...view.bundle, transcriptExcerpt: "hello" };
    expect(renderBrief(bundle, { channel: "cli" })).toContain(
      `${TRANSCRIPT_READ_HINT}：5 字符`,
    );
  });

  it("still sanitizes credentials from bundle text", async () => {
    const view = await frozen();
    const bundle = {
      ...view.bundle,
      sections: {
        ...view.bundle.sections,
        pending: "use sk-abcdefghijklmnopqrstuvwxyz123456 here",
      },
    };
    const brief = renderBrief(bundle, { channel: "cli" });
    expect(brief).not.toContain("sk-abcdef");
    expect(brief).toContain("[REDACTED]");
  });
});

describe("channel-aware notice and read", () => {
  it("writes MCP tool names for a Codex target and hook commands otherwise", async () => {
    const view = await frozen();
    accept(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
      expectedDigest: view.digest,
    });
    const body = (
      fixture.database.prepare("SELECT body FROM agent_mailbox").get() as {
        body: string;
      }
    ).body;
    expect(body).toContain("canvas_handoff_read");
    expect(body).not.toContain("armadra-hook");
  });

  it("answers the brief by default and the bundle with json", async () => {
    const view = await frozen({ acceptance: "done when green" });
    accept(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
      expectedDigest: view.digest,
    });
    const args = [
      fixture.collab,
      callerFor(fixture, target),
      view.bundle.handoffId,
      targetSession,
      1,
    ] as const;
    const md = await readForCaller(...args);
    expect(String(md.message)).toContain("done when green");
    expect(String(md.message)).toContain("canvas_post");
    expect(md.bundle).toBeUndefined();
    const json = await readForCaller(...args, { format: "json" });
    expect(json).toMatchObject({ protocol: "armadra.handoff.v1" });
  });
});

describe("result back to the source", () => {
  it("lets the source acknowledge handoff:<id>:result without a handoff binding", async () => {
    const view = await frozen();
    const id = view.bundle.handoffId;
    await runMailbox(
      fixture.collab,
      callerFor(fixture, target),
      "post",
      new Args({ to: source, key: `handoff:${id}:result`, body: "done" }),
    );
    const row = fixture.database
      .prepare("SELECT id FROM agent_mailbox WHERE target_node_id = ?")
      .get(source) as { id: string };
    const ack = await runMailbox(
      fixture.collab,
      callerFor(fixture, source),
      "ack",
      new Args({ id: row.id }),
    );
    expect(ack.id).toBe(row.id);
  });
});
