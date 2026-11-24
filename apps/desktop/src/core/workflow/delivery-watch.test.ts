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

  it("onLinkChanged refreshes the node with pullsChanged", () => {
    setState("working");
    watch.onLinkChanged(node);
    expect(frames.at(-1)).toMatchObject({ nodeId: node, pullsChanged: true });
  });
});
