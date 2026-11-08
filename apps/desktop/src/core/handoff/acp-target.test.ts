import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { setAdapterProbeForTest } from "../collab/control/agent-driver";
import { runMailbox } from "../collab/mailbox";
import { Args } from "../collab/refusals";
import { EMPTY_SECTIONS } from "./bundle";
import { acceptHandoff, prepare, readForCaller } from "./store";

/**
 * ACP 节点作为交接目标（契约 §39.8，#872）。ACP 会话与终端会话同在
 * `terminal_sessions`（`backend_kind = 'acp'`），会话绑定经开会话时带上的 MCP
 * 服务器环境（`ARMADRA_SESSION_ID` / `_GENERATION`）交给 `canvas_handoff_read`
 * 与 `canvas_ack`；读取的授权判定与终端目标是同一条。
 */

let fixture: AgentFixture;
let source: string;
let sourceSession: string;

beforeEach(() => {
  setAdapterProbeForTest((program) => `/usr/bin/${program}`);
  fixture = agentFixture();
  source = fixture.agentNode("Source");
  sourceSession = fixture.session(source, "claude");
});

afterEach(() => {
  setAdapterProbeForTest();
  fixture.close();
});

/** 一个已连线、驱动为 ACP、会话行是 ACP 后端的目标节点。 */
function acpNode(agentId = "claude"): { node: string; session: string } {
  const node = fixture.agentNode("Acp target", agentId);
  fixture.database
    .prepare(
      "UPDATE nodes SET data_json = json_set(data_json, '$.agent.driver', 'acp') WHERE id = ?",
    )
    .run(node);
  fixture.link(source, node);
  const session = fixture.session(node, agentId);
  fixture.database
    .prepare("UPDATE terminal_sessions SET backend_kind = 'acp' WHERE id = ?")
    .run(session);
  return { node, session };
}

function request(target: Record<string, unknown>) {
  return {
    sourceNodeId: source,
    sourceSessionId: sourceSession,
    sourceGeneration: 1,
    target,
    sections: { ...EMPTY_SECTIONS, goal: "port it" },
    filePaths: [],
    byteBudget: 8192,
    includeTranscript: false,
  } as never;
}

describe("an existing ACP node as the target", () => {
  it("is prepared, accepted, read and acknowledged through the MCP tool names", async () => {
    const { node, session } = acpNode();
    const view = await prepare(
      fixture.collab,
      fixture.workspaceId,
      request({
        kind: "node",
        nodeId: node,
        sessionId: session,
        generation: 1,
      }),
    );
    const accepted = await acceptHandoff(
      fixture.collab,
      fixture.workspaceId,
      view.bundle.handoffId,
      { expectedDigest: view.digest },
    );
    expect(accepted.state).toBe("queued");
    const notice = fixture.database
      .prepare("SELECT body FROM agent_mailbox")
      .get() as { body: string };
    expect(notice.body).toContain("canvas_handoff_read(");
    expect(notice.body).toContain("canvas_ack(");
    expect(notice.body).not.toContain("armadra-hook");

    const read = await readForCaller(
      fixture.collab,
      callerFor(fixture, node),
      view.bundle.handoffId,
      session,
      1,
    );
    const message = String(read.message);
    expect(message).toContain("# 交接：port it");
    expect(message).toContain("canvas_post(");
    expect(message).not.toContain("armadra-hook");
    // 会话绑定不对就读不到：别的会话、别的代次。
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, node),
        view.bundle.handoffId,
        sourceSession,
        1,
      ),
    ).rejects.toThrow();
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, node),
        view.bundle.handoffId,
        session,
        2,
      ),
    ).rejects.toThrow();

    await runMailbox(
      fixture.collab,
      callerFor(fixture, node),
      "ack",
      new Args({ id: accepted.mailboxId, sessionId: session, generation: 1 }),
    );
    expect(
      fixture.database.prepare("SELECT state FROM agent_handoffs").get(),
    ).toEqual({ state: "acknowledged" });
  });

  it("is refused when its ACP session has no canvas tools", async () => {
    const { node, session } = acpNode("ama");
    await expect(
      prepare(
        fixture.collab,
        fixture.workspaceId,
        request({
          kind: "node",
          nodeId: node,
          sessionId: session,
          generation: 1,
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "handoff_target_acp_unreachable",
    });
  });
});

describe("a new Agent opened as ACP", () => {
  it("is created with the ACP driver and told the MCP tool names", async () => {
    const view = await prepare(
      fixture.collab,
      fixture.workspaceId,
      request({ kind: "new", spec: { agentId: "claude", surface: "acp" } }),
    );
    const accepted = await acceptHandoff(
      fixture.collab,
      fixture.workspaceId,
      view.bundle.handoffId,
      { expectedDigest: view.digest },
    );
    const created = accepted.createdTargetNodeId as string;
    const data = JSON.parse(
      (
        fixture.database
          .prepare("SELECT data_json FROM nodes WHERE id = ?")
          .get(created) as { data_json: string }
      ).data_json,
    ) as { agent: { driver: string } };
    expect(data.agent.driver).toBe("acp");
    const task = fixture.database
      .prepare("SELECT body FROM agent_send_queue")
      .get() as { body: string };
    expect(task.body).toContain("canvas_handoff_read(");
    // 会话起来之后，用 ACP 会话自己的绑定读。
    const session = fixture.session(created, "claude");
    fixture.database
      .prepare("UPDATE terminal_sessions SET backend_kind = 'acp' WHERE id = ?")
      .run(session);
    const read = await readForCaller(
      fixture.collab,
      callerFor(fixture, created),
      view.bundle.handoffId,
      session,
      1,
    );
    expect(String(read.message)).toContain("canvas_post(");
  });

  it("is refused for an agent whose ACP session has no canvas tools, and for one without an adapter", async () => {
    await expect(
      prepare(
        fixture.collab,
        fixture.workspaceId,
        request({ kind: "new", spec: { agentId: "ama", surface: "acp" } }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "target_surface_unsupported",
    });
    setAdapterProbeForTest(() => undefined);
    await expect(
      prepare(
        fixture.collab,
        fixture.workspaceId,
        request({ kind: "new", spec: { agentId: "claude", surface: "acp" } }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "target_surface_unsupported",
    });
  });
});
