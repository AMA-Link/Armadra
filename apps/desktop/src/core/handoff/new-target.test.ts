import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { getContextLinks } from "../canvas/context-links";
import { setAdapterProbeForTest } from "../collab/control/agent-driver";
import { runMailbox } from "../collab/mailbox";
import { Args } from "../collab/refusals";
import { EMPTY_SECTIONS } from "./bundle";
import {
  type HandoffView,
  accept,
  acceptHandoff,
  cancel,
  list,
  prepare,
  readForCaller,
} from "./store";

/**
 * 交接 v2 的「新开 Agent」目标（契约 §39.8，#872）：预览只校验不建节点，规格进
 * digest；accept 走 `open-agent` 的建节点路径，通知是首任务，读取与确认由新节点
 * 自己的令牌完成。
 */

let fixture: AgentFixture;
let source: string;
let sourceSession: string;

function spec(overrides: Record<string, unknown> = {}) {
  return {
    kind: "new",
    agentId: "codex",
    model: "gpt-5",
    surface: "terminal",
    ...overrides,
  };
}

function request(target: Record<string, unknown> = spec()) {
  return {
    sourceNodeId: source,
    sourceSessionId: sourceSession,
    sourceGeneration: 1,
    target: {
      kind: "new",
      spec: Object.fromEntries(
        Object.entries(target).filter(([key]) => key !== "kind"),
      ),
    },
    sections: { ...EMPTY_SECTIONS, goal: "finish the port" },
    filePaths: [],
    byteBudget: 8192,
    includeTranscript: false,
  };
}

async function prepared(
  target: Record<string, unknown> = spec(),
): Promise<HandoffView> {
  return await prepare(
    fixture.collab,
    fixture.workspaceId,
    request(target) as never,
  );
}

const nodeCount = (): number =>
  (
    fixture.database.prepare("SELECT COUNT(*) AS n FROM nodes").get() as {
      n: number;
    }
  ).n;

function confirm(view: HandoffView) {
  return acceptHandoff(
    fixture.collab,
    fixture.workspaceId,
    view.bundle.handoffId,
    { expectedDigest: view.digest },
  );
}

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

describe("prepare with a new Agent as the target", () => {
  it("validates and freezes the spec without creating a node", async () => {
    const before = nodeCount();
    const view = await prepared(
      spec({ permissionMode: "plan", title: "接手" }),
    );
    expect(nodeCount()).toBe(before);
    expect(view.state).toBe("prepared");
    expect(view.createdTargetNodeId).toBeNull();
    expect(view.bundle.targetSpec).toEqual({
      kind: "new",
      agentId: "codex",
      model: "gpt-5",
      permissionMode: "plan",
      surface: "terminal",
      title: "接手",
    });
    // 占位身份：节点与会话还不存在。
    expect(view.bundle.target).toMatchObject({
      nodeId: "",
      sessionId: "",
      generation: 0,
      agentId: "codex",
      modelId: "gpt-5",
      nodeTitle: "接手",
    });
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS n FROM agent_mailbox").get(),
    ).toEqual({ n: 0 });
  });

  it("puts the spec under the digest: another spec cannot be approved with this preview", async () => {
    const before = nodeCount();
    const first = await prepared(spec({ model: "gpt-5" }));
    const second = await prepared(spec({ model: "gpt-5-mini" }));
    expect(second.digest).not.toBe(first.digest);
    await expect(
      acceptHandoff(
        fixture.collab,
        fixture.workspaceId,
        second.bundle.handoffId,
        {
          expectedDigest: first.digest,
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(nodeCount()).toBe(before);
  });

  it("refuses what open-agent would refuse, before anything is frozen", async () => {
    await expect(prepared(spec({ agentId: "nope" }))).rejects.toMatchObject({
      status: 400,
    });
    await expect(prepared(spec({ model: "" }))).resolves.toBeDefined();
    await expect(
      prepared(spec({ model: "m".repeat(121) })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      prepared(spec({ permissionMode: "godmode" })),
    ).rejects.toMatchObject({
      status: 400,
      code: "permission_mode_unsupported",
    });
    await expect(prepared(spec({ surface: "gui" }))).rejects.toMatchObject({
      status: 400,
    });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS n FROM agent_handoffs")
        .get(),
    ).toEqual({ n: 1 });
  });

  it("refuses ACP when the agent has no usable ACP adapter", async () => {
    setAdapterProbeForTest(() => undefined);
    await expect(prepared(spec({ surface: "acp" }))).rejects.toMatchObject({
      status: 400,
      code: "target_surface_unsupported",
    });
    // 终端形态不要适配器。
    await expect(
      prepared(spec({ surface: "terminal" })),
    ).resolves.toBeDefined();
  });

  it("refuses a disabled agent", async () => {
    fixture.disabledAgents.push("codex");
    await expect(prepared()).rejects.toMatchObject({ status: 403 });
  });
});

describe("accept with a new Agent as the target", () => {
  it("creates the node linked under the source, queues the notice as its first task and the inbox entry", async () => {
    const view = await prepared(
      spec({ permissionMode: "plan", title: "接手" }),
    );
    const before = nodeCount();
    const accepted = await confirm(view);
    expect(accepted.state).toBe("queued");
    expect(nodeCount()).toBe(before + 1);
    const created = accepted.createdTargetNodeId;
    expect(created).not.toBeNull();
    const row = fixture.database
      .prepare("SELECT title, data_json FROM nodes WHERE id = ?")
      .get(created) as { title: string; data_json: string };
    expect(row.title).toBe("接手");
    const agent = (
      JSON.parse(row.data_json) as { agent: Record<string, unknown> }
    ).agent;
    expect(agent).toMatchObject({
      id: "codex",
      model: "gpt-5",
      permissionMode: "plan",
      driver: "terminal",
    });
    // 连线：来源是新节点的主。
    expect(
      getContextLinks(fixture.database, source).links.find(
        (link) => link.id === created,
      )?.role,
    ).toBe("sub");
    expect(
      getContextLinks(fixture.database, created as string).links.find(
        (link) => link.id === source,
      )?.role,
    ).toBe("main");
    // 首任务就是交接通知，收件箱那条给 ack 认。
    const task = fixture.database
      .prepare(
        "SELECT origin, body, target_node_id, source_node_id FROM agent_send_queue",
      )
      .get() as {
      origin: string;
      body: string;
      target_node_id: string;
      source_node_id: string;
    };
    expect(task).toMatchObject({
      origin: "first-task",
      target_node_id: created,
      source_node_id: source,
    });
    expect(task.body).toContain("canvas_handoff_read");
    expect(task.body).toContain(view.bundle.handoffId);
    const mail = fixture.database
      .prepare("SELECT message_key, target_node_id FROM agent_mailbox")
      .get() as { message_key: string; target_node_id: string };
    expect(mail).toEqual({
      message_key: `handoff:${view.bundle.handoffId}`,
      target_node_id: created,
    });
    expect(accepted.mailboxId).not.toBeNull();
    expect(
      fixture.events.some(
        (entry) =>
          entry.event.type === "agent.delivery" &&
          entry.event.targetNodeId === created,
      ),
    ).toBe(true);
    // 两边的历史里都看得到这份交接。
    expect(
      list(fixture.collab, fixture.workspaceId, created as string),
    ).toHaveLength(1);
  });

  it("is idempotent: a repeat or concurrent accept does not create a second node", async () => {
    const view = await prepared();
    const before = nodeCount();
    const [first, second] = await Promise.allSettled([
      confirm(view),
      confirm(view),
    ]);
    expect([first.status, second.status].sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const again = await confirm(view);
    expect(again.state).toBe("queued");
    expect(nodeCount()).toBe(before + 1);
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS n FROM agent_mailbox").get(),
    ).toEqual({ n: 1 });
  });

  it("keeps the handoff prepared when the node cannot be created, and can be retried", async () => {
    const view = await prepared();
    const before = nodeCount();
    fixture.disabledAgents.push("codex");
    await expect(confirm(view)).rejects.toMatchObject({ status: 403 });
    expect(nodeCount()).toBe(before);
    expect(
      fixture.database
        .prepare("SELECT state, created_target_node_id FROM agent_handoffs")
        .get(),
    ).toEqual({ state: "prepared", created_target_node_id: null });
    // 来源没有被动过，也没有排任何东西。
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS n FROM agent_send_queue")
        .get(),
    ).toEqual({ n: 0 });
    fixture.disabledAgents.length = 0;
    expect((await confirm(view)).state).toBe("queued");
    expect(nodeCount()).toBe(before + 1);
  });

  it("is not available through the synchronous accept for a node target only", async () => {
    const view = await prepared();
    expect(() =>
      accept(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
        expectedDigest: view.digest,
      }),
    ).toThrow(/acceptHandoff/);
  });

  it("can still be withdrawn: the inbox entry goes, the record says cancelled", async () => {
    const view = await prepared();
    const queued = await confirm(view);
    const cancelled = cancel(
      fixture.collab,
      fixture.workspaceId,
      view.bundle.handoffId,
      { expectedDigest: view.digest },
    );
    expect(cancelled.state).toBe("cancelled");
    expect(queued.mailboxId).not.toBeNull();
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS n FROM agent_mailbox").get(),
    ).toEqual({ n: 0 });
  });
});

describe("the new node reads and acknowledges with its own token", () => {
  it("reads the brief and acks; the source and strangers cannot read it", async () => {
    const view = await prepared();
    const accepted = await confirm(view);
    const created = accepted.createdTargetNodeId as string;
    const session = fixture.session(created, "codex");
    const id = view.bundle.handoffId;

    // 来源不是被寻址的那个节点。
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, source),
        id,
        sourceSession,
        1,
      ),
    ).rejects.toThrow(/not addressed/);
    // 别的节点也不行。
    const stranger = fixture.agentNode("Stranger");
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, stranger),
        id,
        fixture.session(stranger, "claude"),
        1,
      ),
    ).rejects.toThrow(/not addressed/);

    // 新节点：会话在读取时按它当前的会话判定。
    const brief = await readForCaller(
      fixture.collab,
      callerFor(fixture, created),
      id,
      session,
      1,
    );
    expect(String(brief.message)).toContain("# 交接：finish the port");
    // 会话不是它的：拒绝。
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, created),
        id,
        fixture.session(stranger, "claude"),
        1,
      ),
    ).rejects.toThrow();
    // 代次不对：拒绝。
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, created),
        id,
        session,
        2,
      ),
    ).rejects.toThrow();

    await runMailbox(
      fixture.collab,
      callerFor(fixture, created),
      "ack",
      new Args({ id: accepted.mailboxId, sessionId: session, generation: 1 }),
    );
    expect(
      fixture.database.prepare("SELECT state FROM agent_handoffs").get(),
    ).toEqual({ state: "acknowledged" });
  });

  it("refuses the ack from a session that is not the node's", async () => {
    const view = await prepared();
    const accepted = await confirm(view);
    const created = accepted.createdTargetNodeId as string;
    fixture.session(created, "codex");
    await expect(
      runMailbox(
        fixture.collab,
        callerFor(fixture, created),
        "ack",
        new Args({
          id: accepted.mailboxId,
          sessionId: sourceSession,
          generation: 1,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("a target in an SSH terminal", () => {
  it("is refused by prepare, for a node target", async () => {
    const remote = fixture.agentNode("Remote", "codex");
    fixture.database
      .prepare(
        "UPDATE nodes SET data_json = json_set(data_json, '$.ssh', json('{\"hostId\":\"h\"}')) WHERE id = ?",
      )
      .run(remote);
    fixture.link(source, remote);
    await expect(
      prepare(fixture.collab, fixture.workspaceId, {
        ...request(),
        target: {
          kind: "node",
          nodeId: remote,
          sessionId: fixture.session(remote, "codex"),
          generation: 1,
        },
      } as never),
    ).rejects.toMatchObject({ status: 400, code: "handoff_target_ssh" });
  });
});
