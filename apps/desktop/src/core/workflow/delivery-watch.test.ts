import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { EventBus } from "../bus";
import { DeliveryWatch } from "./delivery-watch";
import { saveSnapshot } from "./pull-snapshots";

const NOW = 1_800_000_000_000;
const REPO = "h/o/r";

let fixture: AgentFixture;
let bus: EventBus;
let watch: DeliveryWatch;
let frames: Record<string, unknown>[];
let node: string;

beforeEach(() => {
  fixture = agentFixture();
  bus = new EventBus();
  frames = [];
  bus.on("workspace.event", ({ event }) => {
    if (event.type === "delivery.changed") frames.push({ ...event });
  });
  watch = new DeliveryWatch({
    database: fixture.database,
    bus,
    clock: () => NOW,
  });
  watch.start();
  node = fixture.agentNode("n", "claude");
});

afterEach(() => {
  watch.stop();
  fixture.close();
});

function setState(state: string, extra = ""): void {
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at) " +
        "VALUES (?, ?, 'claude', ?, 0, 1, 0, 't') ON CONFLICT(node_id) DO UPDATE SET state = excluded.state",
    )
    .run(node, fixture.workspaceId, state);
  void extra;
  bus.emit("workspace.event", {
    workspaceId: fixture.workspaceId,
    event: { type: "agent.status", status: { nodeId: node, state } },
  });
}

function bindPull(): void {
  fixture.database
    .prepare(
      "INSERT INTO workflow_task_runs (task_id, coordinator_node_id, runner_id, node_id, status, started_at, threads) " +
        "VALUES ('t1', ?, 'r', ?, 'running', 1, ?)",
    )
    .run(
      node,
      node,
      JSON.stringify([
        {
          kind: "pull",
          repo: REPO,
          number: 7,
          own: true,
          url: "u",
          boundAt: 1,
        },
      ]),
    );
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    url: "u",
    title: "t",
    state: "open" as const,
    draft: false,
    baseRef: "main",
    headRef: "x",
    headSha: "s",
    fromFork: false,
    review: "reviewRequired" as const,
    checks: {
      read: true as const,
      headSha: "s",
      rollup: "success" as const,
      failing: [],
    },
    mergeable: "mergeable" as const,
    parent: { kind: "none" as const },
    ...over,
  };
}

describe("DeliveryWatch", () => {
  it("emits when lane or phrase changes, and only then", () => {
    setState("working");
    expect(frames).toEqual([
      expect.objectContaining({
        nodeId: node,
        lane: "working",
        phrase: "working",
      }),
    ]);
    setState("working");
    expect(frames).toHaveLength(1);
    setState("waiting");
    expect(frames.at(-1)).toMatchObject({
      lane: "needsYou",
      phrase: "needsAnswer",
    });
    expect(frames).toHaveLength(2);
    expect(frames[1]).not.toHaveProperty("pullsChanged");
  });

  it("carries the board id of the node", () => {
    setState("working");
    expect(frames[0]).toMatchObject({ boardId: fixture.boardId });
  });

  it("emits pullsChanged when only the pull details moved", () => {
    bindPull();
    setState("done");
    saveSnapshot(fixture.database, REPO, snapshot(), NOW);
    watch.onSnapshot(REPO, 7);
    expect(frames.at(-1)).toMatchObject({
      lane: "inReview",
      phrase: "awaitingReview",
      pullsChanged: true,
    });
    const before = frames.length;
    // 评审没变、检查细节变了，栏与短语都不动。
    saveSnapshot(fixture.database, REPO, snapshot({ title: "renamed" }), NOW);
    watch.onSnapshot(REPO, 7);
    expect(frames).toHaveLength(before + 1);
    expect(frames.at(-1)).toMatchObject({
      lane: "inReview",
      phrase: "awaitingReview",
      pullsChanged: true,
    });
  });

  it("ignores a snapshot of a pull no node is bound to", () => {
    bindPull();
    setState("done");
    const before = frames.length;
    watch.onSnapshot(REPO, 99);
    expect(frames).toHaveLength(before);
  });

  it("does not react to its own frames", () => {
    setState("working");
    bus.emit("workspace.event", {
      workspaceId: fixture.workspaceId,
      event: {
        type: "delivery.changed",
        boardId: fixture.boardId,
        nodeId: node,
        lane: "working",
        phrase: "working",
      },
    });
    expect(frames).toHaveLength(2); // 我们自己的探针只记下了这一次手发的帧
  });

  it("follows a work item change", () => {
    bindPull();
    saveSnapshot(fixture.database, REPO, snapshot({ state: "merged" }), NOW);
    bus.emit("workspace.event", {
      workspaceId: fixture.workspaceId,
      event: {
        type: "workflow.task",
        taskId: "t1",
        boardId: fixture.boardId,
        coordinatorNodeId: node,
        nodeId: node,
        status: "running",
      },
    });
    expect(frames.at(-1)).toMatchObject({ lane: "offBoard", phrase: "merged" });
  });

  it("does not emit for a node without an agent", () => {
    const plain = fixture.agentNode("plain", null);
    bus.emit("workspace.event", {
      workspaceId: fixture.workspaceId,
      event: {
        type: "agent.status",
        status: { nodeId: plain, state: "working" },
      },
    });
    expect(frames).toEqual([]);
  });

  it("follows a snapshot of a branch-linked pull to its node", () => {
    setState("done");
    fixture.database
      .prepare(
        "INSERT INTO node_pull_links (node_id, workspace_id, repo, number, head_ref, url, linked_at) VALUES (?, ?, ?, 7, 'x', 'u', 1)",
      )
      .run(node, fixture.workspaceId, REPO);
    saveSnapshot(fixture.database, REPO, snapshot(), NOW);
    watch.onSnapshot(REPO, 7);
    expect(frames.at(-1)).toMatchObject({
      nodeId: node,
      lane: "inReview",
      phrase: "awaitingReview",
      pullsChanged: true,
    });
  });

  it("onLinkChanged refreshes the node with pullsChanged", () => {
    setState("working");
    watch.onLinkChanged(node);
    expect(frames.at(-1)).toMatchObject({ nodeId: node, pullsChanged: true });
  });
});

describe("DeliveryWatch with children", () => {
  function supervise(child: string): void {
    fixture.database
      .prepare(
        "INSERT INTO edges (id, board_id, source_node_id, target_node_id, kind, role, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, 'link', 'supervises', 't', 't')",
      )
      .run(`e-${child}`, fixture.boardId, node, child);
  }

  function childState(child: string, state: string): void {
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at, last_event_at) " +
          "VALUES (?, ?, 'codex', ?, 0, 1, 0, 't', ?) ON CONFLICT(node_id) DO UPDATE SET state = excluded.state",
      )
      .run(child, fixture.workspaceId, state, new Date(NOW).toISOString());
    bus.emit("workspace.event", {
      workspaceId: fixture.workspaceId,
      event: { type: "agent.status", status: { nodeId: child, state } },
    });
  }

  it("a child's status makes the parent emit, with the counts", () => {
    setState("done");
    const child = fixture.agentNode("kid", "codex");
    supervise(child);
    childState(child, "working");
    expect(
      frames.filter((frame) => frame.nodeId === node).at(-1),
    ).toMatchObject({
      lane: "working",
      phrase: "waitingOnChildren",
      children: { total: 1, finished: 0, needsYou: 0 },
    });
  });

  it("emits when only the counts change", () => {
    setState("done");
    const a = fixture.agentNode("a", "codex");
    const b = fixture.agentNode("b", "codex");
    supervise(a);
    supervise(b);
    childState(a, "working");
    childState(b, "working");
    const before = frames.filter((frame) => frame.nodeId === node).length;
    childState(b, "waiting");
    const mine = frames.filter((frame) => frame.nodeId === node);
    expect(mine).toHaveLength(before + 1);
    expect(mine.at(-1)).toMatchObject({
      phrase: "waitingOnChildren",
      children: { total: 2, finished: 0, needsYou: 1 },
    });
  });

  it("emits pullsChanged when the child set changed but the counts did not", () => {
    setState("done");
    const a = fixture.agentNode("a", "codex");
    supervise(a);
    childState(a, "working");
    const before = frames.filter((frame) => frame.nodeId === node).length;
    // 同一批里换了一个子节点，计数不变。
    fixture.database
      .prepare("DELETE FROM edges WHERE target_node_id = ?")
      .run(a);
    const b = fixture.agentNode("b", "codex");
    supervise(b);
    childState(b, "working");
    const mine = frames.filter((frame) => frame.nodeId === node);
    expect(mine).toHaveLength(before + 1);
    expect(mine.at(-1)).toMatchObject({
      pullsChanged: true,
      children: { total: 1, finished: 0, needsYou: 0 },
    });
  });

  it("a work item change refreshes the coordinator", () => {
    setState("done");
    const child = fixture.agentNode("kid", "codex");
    fixture.database
      .prepare(
        "INSERT INTO workflow_task_runs (task_id, coordinator_node_id, runner_id, node_id, status, started_at) " +
          "VALUES ('t9', ?, 'r', ?, 'running', ?)",
      )
      .run(node, child, NOW - 1000);
    bus.emit("workspace.event", {
      workspaceId: fixture.workspaceId,
      event: {
        type: "workflow.task",
        taskId: "t9",
        boardId: fixture.boardId,
        coordinatorNodeId: node,
        nodeId: child,
        status: "running",
      },
    });
    expect(
      frames.filter((frame) => frame.nodeId === node).at(-1),
    ).toMatchObject({
      phrase: "waitingOnChildren",
      children: { total: 1, finished: 0 },
    });
  });

  it("a workflow.run step frame refreshes the collect role node", () => {
    setState("done");
    const child = fixture.agentNode("kid", "codex");
    fixture.database
      .prepare(
        "INSERT INTO workflow_runs (id, template_id, template_version, template_json, workspace_id, board_id, status, started_at) " +
          "VALUES ('r1', 't', 1, ?, ?, ?, 'running', 1)",
      )
      .run(
        JSON.stringify({
          steps: [
            { id: "s1", kind: "prompt" },
            { id: "c", kind: "collect", from: ["s1"] },
          ],
        }),
        fixture.workspaceId,
        fixture.boardId,
      );
    const step = fixture.database.prepare(
      "INSERT INTO workflow_run_steps (run_id, step_id, kind, status, node_id, started_at) VALUES ('r1', ?, ?, ?, ?, ?)",
    );
    step.run("s1", "prompt", "running", child, NOW - 1000);
    step.run("c", "collect", "running", node, NOW - 500);
    bus.emit("workspace.event", {
      workspaceId: fixture.workspaceId,
      event: {
        type: "workflow.run",
        runId: "r1",
        boardId: fixture.boardId,
        status: "running",
        stepId: "s1",
        stepStatus: "running",
      },
    });
    expect(
      frames.filter((frame) => frame.nodeId === node).at(-1),
    ).toMatchObject({
      lane: "working",
      phrase: "waitingOnChildren",
      children: { total: 1, finished: 0 },
    });
  });

  it("does not subscribe to board.changed", () => {
    setState("done");
    const before = frames.length;
    bus.emit("workspace.event", {
      workspaceId: fixture.workspaceId,
      event: {
        type: "board.changed",
        boardId: fixture.boardId,
        updatedAt: "t",
      },
    });
    expect(frames).toHaveLength(before);
  });
});
