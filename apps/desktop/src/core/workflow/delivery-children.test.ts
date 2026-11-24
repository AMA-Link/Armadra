import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { createBoard } from "../canvas/boards";
import { childrenOf, collectStateOf, parentsOf } from "./delivery-children";
import { deliveryFacts, deliveryNode } from "./delivery-facts";

const NOW = 1_800_000_000_000;
const SINCE = NOW - 24 * 3_600_000;

let fx: AgentFixture;
let parent: string;

beforeEach(() => {
  fx = agentFixture();
  parent = fx.agentNode("parent", "ama");
});

afterEach(() => fx.close());

function state(
  nodeId: string,
  value: string | null,
  extra: { pending?: string; at?: number } = {},
): void {
  const at = new Date(extra.at ?? NOW).toISOString();
  fx.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, pending_id, unread, verified, restored, " +
        "updated_at, last_event_at) VALUES (?, ?, 'codex', ?, ?, 0, 1, 0, ?, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, pending_id = excluded.pending_id, " +
        "last_event_at = excluded.last_event_at",
    )
    .run(nodeId, fx.workspaceId, value, extra.pending ?? null, at, at);
}

function task(
  taskId: string,
  coordinator: string,
  node: string,
  status: "running" | "done" | "failed",
  startedAt: number,
  endedAt: number | null = null,
): void {
  fx.database
    .prepare(
      "INSERT INTO workflow_task_runs (task_id, coordinator_node_id, runner_id, node_id, status, started_at, ended_at) " +
        "VALUES (?, ?, 'r', ?, ?, ?, ?)",
    )
    .run(taskId, coordinator, node, status, startedAt, endedAt);
}

function supervises(source: string, target: string): void {
  const now = new Date(NOW).toISOString();
  fx.database
    .prepare(
      "INSERT INTO edges (id, board_id, source_node_id, target_node_id, kind, role, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 'link', 'supervises', ?, ?)",
    )
    .run(`e-${source}-${target}`, fx.boardId, source, target, now, now);
}

interface StepSeed {
  id: string;
  kind: "prompt" | "collect";
  node: string;
  status: string;
  startedAt?: number | null;
  endedAt?: number | null;
  from?: string[];
}

function run(id: string, status: string, steps: StepSeed[]): void {
  const template = {
    steps: steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      ...(step.from === undefined ? {} : { from: step.from }),
    })),
  };
  fx.database
    .prepare(
      "INSERT INTO workflow_runs (id, template_id, template_version, template_json, workspace_id, board_id, status, started_at) " +
        "VALUES (?, 't', 1, ?, ?, ?, ?, 1)",
    )
    .run(id, JSON.stringify(template), fx.workspaceId, fx.boardId, status);
  for (const step of steps) {
    fx.database
      .prepare(
        "INSERT INTO workflow_run_steps (run_id, step_id, kind, status, node_id, started_at, ended_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        step.id,
        step.kind,
        step.status,
        step.node,
        step.startedAt ?? null,
        step.endedAt ?? null,
      );
  }
}

describe("childrenOf", () => {
  it("reads a work item child, running and ended", () => {
    const a = fx.agentNode("a", "codex");
    const b = fx.agentNode("b", "codex");
    task("t1", parent, a, "running", 100);
    task("t2", parent, b, "done", 50, NOW - 1000);
    const rows = childrenOf(fx.database, parent, SINCE);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      nodeId: a,
      source: "task",
      finished: false,
      startedAtMs: 100,
      endedAtMs: null,
    });
    expect(rows).toContainEqual({
      nodeId: b,
      source: "task",
      finished: true,
      startedAtMs: 50,
      endedAtMs: NOW - 1000,
    });
  });

  it("drops ended work items older than the window", () => {
    const a = fx.agentNode("a", "codex");
    task("t1", parent, a, "done", 1, SINCE - 1);
    expect(childrenOf(fx.database, parent, SINCE)).toEqual([]);
  });

  it("reads the source steps of a live collect step of this node", () => {
    const a = fx.agentNode("a", "codex");
    const b = fx.agentNode("b", "codex");
    run("r1", "running", [
      { id: "s1", kind: "prompt", node: a, status: "running", startedAt: 10 },
      {
        id: "s2",
        kind: "prompt",
        node: b,
        status: "done",
        startedAt: 5,
        endedAt: 20,
      },
      {
        id: "c",
        kind: "collect",
        node: parent,
        status: "pending",
        from: ["s1", "s2"],
      },
    ]);
    const rows = childrenOf(fx.database, parent, SINCE);
    expect(rows).toEqual([
      {
        nodeId: a,
        source: "workflow",
        finished: false,
        startedAtMs: 10,
        endedAtMs: null,
      },
      {
        nodeId: b,
        source: "workflow",
        finished: true,
        startedAtMs: 5,
        endedAtMs: 20,
      },
    ]);
  });

  it("ignores a collect step of a finished run or in a final state", () => {
    const a = fx.agentNode("a", "codex");
    run("r1", "succeeded", [
      {
        id: "s1",
        kind: "prompt",
        node: a,
        status: "done",
        startedAt: 1,
        endedAt: 2,
      },
      { id: "c", kind: "collect", node: parent, status: "done", from: ["s1"] },
    ]);
    expect(childrenOf(fx.database, parent, SINCE)).toEqual([]);
  });

  it("reads a supervises child by its status row; done with a pending prompt is not finished", () => {
    const a = fx.agentNode("a", "codex");
    const b = fx.agentNode("b", "codex");
    supervises(parent, a);
    supervises(parent, b);
    state(a, "working");
    state(b, "done", { at: NOW - 5 });
    const rows = childrenOf(fx.database, parent, SINCE);
    expect(rows).toContainEqual({
      nodeId: a,
      source: "edge",
      finished: false,
      startedAtMs: null,
      endedAtMs: null,
    });
    expect(rows).toContainEqual({
      nodeId: b,
      source: "edge",
      finished: true,
      startedAtMs: null,
      endedAtMs: NOW - 5,
    });
    state(b, "done", { pending: "p1" });
    expect(
      childrenOf(fx.database, parent, SINCE).find((row) => row.nodeId === b)
        ?.finished,
    ).toBe(false);
  });

  it("does not count a supervises child without a status row or with a null state", () => {
    const none = fx.agentNode("none", "codex");
    const empty = fx.agentNode("empty", "codex");
    supervises(parent, none);
    supervises(parent, empty);
    state(empty, null);
    expect(childrenOf(fx.database, parent, SINCE)).toEqual([]);
  });

  it("does not count a peer edge", () => {
    const a = fx.agentNode("a", "codex");
    fx.link(parent, a);
    state(a, "working");
    expect(childrenOf(fx.database, parent, SINCE)).toEqual([]);
  });

  it("keeps one row per node, work item over workflow over edge", () => {
    const a = fx.agentNode("a", "codex");
    task("t1", parent, a, "running", 100);
    supervises(parent, a);
    state(a, "done");
    run("r1", "running", [
      {
        id: "s1",
        kind: "prompt",
        node: a,
        status: "done",
        startedAt: 1,
        endedAt: 2,
      },
      {
        id: "c",
        kind: "collect",
        node: parent,
        status: "running",
        from: ["s1"],
      },
    ]);
    const rows = childrenOf(fx.database, parent, SINCE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "task", finished: false });
  });

  it("prefers the workflow row over the edge row", () => {
    const a = fx.agentNode("a", "codex");
    supervises(parent, a);
    state(a, "working");
    run("r1", "running", [
      {
        id: "s1",
        kind: "prompt",
        node: a,
        status: "done",
        startedAt: 1,
        endedAt: 2,
      },
      {
        id: "c",
        kind: "collect",
        node: parent,
        status: "running",
        from: ["s1"],
      },
    ]);
    expect(childrenOf(fx.database, parent, SINCE)).toEqual([
      {
        nodeId: a,
        source: "workflow",
        finished: true,
        startedAtMs: 1,
        endedAtMs: 2,
      },
    ]);
  });

  it("skips a child on another board, a non-agent node and the node itself", () => {
    const other = createBoard(fx.database, fx.workspaceId, "other");
    fx.database
      .prepare(
        "INSERT INTO nodes (id, board_id, type, title, data_json, x, y, width, height, created_at, updated_at) " +
          "VALUES ('far', ?, 'terminal', 'far', ?, 0, 0, 1, 1, 't', 't')",
      )
      .run(
        other.id,
        JSON.stringify({ kind: "terminal", agent: { id: "codex" } }),
      );
    const plain = fx.agentNode("plain", null);
    task("t1", parent, "far", "running", 1);
    task("t2", parent, plain, "running", 1);
    task("t3", parent, parent, "running", 1);
    task("t4", parent, "ghost", "running", 1);
    expect(childrenOf(fx.database, parent, SINCE)).toEqual([]);
  });
});

describe("collectStateOf", () => {
  it("is running / escalated by the collect step status, else null", () => {
    const a = fx.agentNode("a", "codex");
    expect(collectStateOf(fx.database, parent)).toBeNull();
    run("r1", "running", [
      {
        id: "s1",
        kind: "prompt",
        node: a,
        status: "done",
        startedAt: 1,
        endedAt: 2,
      },
      {
        id: "c",
        kind: "collect",
        node: parent,
        status: "running",
        from: ["s1"],
      },
    ]);
    expect(collectStateOf(fx.database, parent)).toBe("running");
    fx.database
      .prepare(
        "UPDATE workflow_run_steps SET status = 'waiting' WHERE step_id = 'c'",
      )
      .run();
    expect(collectStateOf(fx.database, parent)).toBe("escalated");
    fx.database
      .prepare(
        "UPDATE workflow_run_steps SET status = 'done' WHERE step_id = 'c'",
      )
      .run();
    expect(collectStateOf(fx.database, parent)).toBeNull();
  });

  it("is null when the run is over", () => {
    run("r1", "cancelled", [
      { id: "c", kind: "collect", node: parent, status: "running", from: [] },
    ]);
    expect(collectStateOf(fx.database, parent)).toBeNull();
  });
});

describe("parentsOf", () => {
  it("finds the coordinator, the supervising source and the collect role of the same run", () => {
    const child = fx.agentNode("child", "codex");
    const lead = fx.agentNode("lead", "ama");
    const boss = fx.agentNode("boss", "ama");
    task("t1", parent, child, "running", 1);
    supervises(lead, child);
    run("r1", "running", [
      {
        id: "s1",
        kind: "prompt",
        node: child,
        status: "running",
        startedAt: 1,
      },
      { id: "c", kind: "collect", node: boss, status: "pending", from: ["s1"] },
    ]);
    expect(parentsOf(fx.database, child).sort()).toEqual(
      [parent, lead, boss].sort(),
    );
  });

  it("does not return a peer link, a collect that does not list the step, or an ended run", () => {
    const child = fx.agentNode("child", "codex");
    const peer = fx.agentNode("peer", "ama");
    const boss = fx.agentNode("boss", "ama");
    fx.link(peer, child);
    run("r1", "running", [
      {
        id: "s1",
        kind: "prompt",
        node: child,
        status: "running",
        startedAt: 1,
      },
      { id: "s2", kind: "prompt", node: peer, status: "running", startedAt: 1 },
      { id: "c", kind: "collect", node: boss, status: "pending", from: ["s2"] },
    ]);
    run("r2", "succeeded", [
      {
        id: "s1",
        kind: "prompt",
        node: child,
        status: "done",
        startedAt: 1,
        endedAt: 2,
      },
      { id: "c", kind: "collect", node: peer, status: "done", from: ["s1"] },
    ]);
    expect(parentsOf(fx.database, child)).toEqual([]);
  });
});

describe("deliveryFacts / deliveryNode with children", () => {
  it("counts a supervised child in flight and shows waitingOnChildren on an idle parent", () => {
    const child = fx.agentNode("child", "codex");
    supervises(parent, child);
    state(child, "working");
    state(parent, "done");
    const view = deliveryNode(fx.database, parent, NOW);
    expect(view.status).toEqual({
      lane: "working",
      phrase: "waitingOnChildren",
    });
    expect(view.children).toMatchObject({ total: 1, finished: 0, needsYou: 0 });
  });

  it("marks a child that itself needs the human", () => {
    const child = fx.agentNode("child", "codex");
    task("t1", parent, child, "running", 1);
    state(child, "working", { pending: "p1" });
    state(parent, "done");
    const view = deliveryNode(fx.database, parent, NOW);
    expect(view.status).toEqual({
      lane: "working",
      phrase: "waitingOnChildren",
    });
    expect(view.children).toMatchObject({ total: 1, needsYou: 1 });
  });

  it("reads idleAtMs from done_at and a collect step into the facts", () => {
    state(parent, "done", { at: NOW - 10 });
    fx.database
      .prepare("UPDATE agent_status SET done_at = ? WHERE node_id = ?")
      .run(new Date(NOW - 10).toISOString(), parent);
    const facts = deliveryFacts(fx.database, parent, NOW);
    expect(facts.idleAtMs).toBe(NOW - 10);
    expect(facts.collect).toBeNull();
    expect(facts.children).toEqual([]);
  });

  it("does not recurse: children: false skips children and collect", () => {
    const child = fx.agentNode("child", "codex");
    supervises(parent, child);
    state(child, "working");
    expect(
      deliveryFacts(fx.database, parent, NOW, { children: false }).children,
    ).toEqual([]);
  });

  it("survives a supervision cycle", () => {
    const child = fx.agentNode("child", "codex");
    supervises(parent, child);
    supervises(child, parent);
    state(child, "working");
    state(parent, "working");
    expect(() => deliveryNode(fx.database, parent, NOW)).not.toThrow();
  });
});
