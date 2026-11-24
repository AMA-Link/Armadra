import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { type ControlOutcome, controlDispatcher } from "../collab/control";
import { resetWaitTrackers } from "../collab/control/wait";
import { resetSendLimits } from "../collab/send-limits";
import { resetInboxWake } from "../collab/wake";
import type { ForgePullSnapshot } from "../forge/types";
import {
  agentNodesOfBoard,
  deliveryFacts,
  deliveryNode,
  pullsOfNode,
} from "./delivery-facts";
import { saveSnapshot } from "./pull-snapshots";

const NOW = 1_800_000_000_000;
const REPO = "h/o/r";

let fixture: AgentFixture;
let lead: string;

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
  fixture = agentFixture();
  lead = fixture.agentNode("lead", "ama");
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  resetInboxWake();
  resetWaitTrackers();
});

function snap(over: Partial<ForgePullSnapshot> = {}): ForgePullSnapshot {
  return {
    number: 7,
    url: "https://h/o/r/pull/7",
    title: "t",
    state: "open",
    draft: false,
    baseRef: "main",
    headRef: "x",
    headSha: "sha",
    fromFork: false,
    review: "notRequired",
    checks: { read: true, headSha: "sha", rollup: "success", failing: [] },
    mergeable: "mergeable",
    parent: { kind: "none" },
    ...over,
  };
}

async function dispatch(taskId: string): Promise<string> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  const outcome: ControlOutcome = await dispatcher.dispatch(
    "open-agent",
    callerFor(fixture, lead),
    { agent: "codex", task: `do ${taskId}`, "task-id": taskId },
  );
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  const member = (outcome.body.result as { id: string }).id;
  fixture.database
    .prepare(
      "UPDATE agent_send_queue SET state = 'done' WHERE target_node_id = ?",
    )
    .run(member);
  fixture.database
    .prepare(
      "UPDATE agent_dependency_launches SET state = 'launched' WHERE node_id = ?",
    )
    .run(member);
  return member;
}

function bind(taskId: string, number: number): void {
  const threads = [
    {
      kind: "pull",
      repo: REPO,
      number,
      own: true,
      url: `https://h/o/r/pull/${number}`,
      boundAt: NOW,
    },
  ];
  fixture.database
    .prepare("UPDATE workflow_task_runs SET threads = ? WHERE task_id = ?")
    .run(JSON.stringify(threads), taskId);
}

function status(
  nodeId: string,
  state: string,
  extra: { pending?: string; endedBy?: string; errored?: number } = {},
): void {
  const at = new Date(NOW).toISOString();
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, pending_id, unread, verified, restored, " +
        "updated_at, last_event_at, errored, interrupted, ended_by) VALUES (?, ?, 'codex', ?, ?, 0, 1, 0, ?, ?, ?, 0, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, pending_id = excluded.pending_id, " +
        "errored = excluded.errored, interrupted = excluded.interrupted, ended_by = excluded.ended_by",
    )
    .run(
      nodeId,
      fixture.workspaceId,
      state,
      extra.pending ?? null,
      at,
      at,
      extra.errored ?? 0,
      extra.endedBy ?? null,
    );
}

describe("deliveryFacts", () => {
  it("has no agent, stage or pulls for a bare node", () => {
    const node = fixture.agentNode("bare", "claude");
    const facts = deliveryFacts(fixture.database, node, NOW);
    expect(facts).toMatchObject({
      agent: null,
      stage: null,
      itemResult: null,
      pulls: [],
      taskId: null,
    });
  });

  it("reads the agent row, including pending and endedBy", async () => {
    const node = fixture.agentNode("n", "claude");
    status(node, "done", { endedBy: "stale", pending: "p1", errored: 1 });
    expect(deliveryFacts(fixture.database, node, NOW).agent).toEqual({
      state: "done",
      pending: true,
      errored: true,
      interrupted: false,
      endedBy: "stale",
    });
  });

  it("takes the stage and the bound pulls from the latest work item", async () => {
    const member = await dispatch("t1");
    status(member, "working");
    bind("t1", 7);
    saveSnapshot(fixture.database, REPO, snap(), NOW);
    const facts = deliveryFacts(fixture.database, member, NOW);
    expect(facts.taskId).toBe("t1");
    expect(facts.stage).toBe("working");
    expect(facts.pulls).toHaveLength(1);
    expect(facts.pulls[0]).toMatchObject({
      repo: REPO,
      number: 7,
      stale: false,
    });
  });

  it("skips a bound pull that has no snapshot yet", async () => {
    const member = await dispatch("t1");
    bind("t1", 7);
    expect(pullsOfNode(fixture.database, member, NOW)).toEqual([]);
  });

  it("marks a snapshot stale after ten minutes", async () => {
    const member = await dispatch("t1");
    bind("t1", 7);
    saveSnapshot(fixture.database, REPO, snap(), NOW);
    expect(
      pullsOfNode(fixture.database, member, NOW + 11 * 60_000)[0]?.stale,
    ).toBe(true);
  });

  it("reads the item result of a finished item", async () => {
    const member = await dispatch("t1");
    fixture.database
      .prepare(
        "UPDATE workflow_task_runs SET status = 'done', ended_at = ?, result_json = ? WHERE task_id = 't1'",
      )
      .run(NOW, JSON.stringify({ result: "merged" }));
    expect(deliveryFacts(fixture.database, member, NOW).itemResult).toBe(
      "merged",
    );
  });
});

describe("deliveryNode", () => {
  it("derives the status and carries the pulls", async () => {
    const member = await dispatch("t1");
    status(member, "done");
    bind("t1", 7);
    saveSnapshot(
      fixture.database,
      REPO,
      snap({
        checks: { read: true, headSha: "s", rollup: "failure", failing: ["a"] },
      }),
      NOW,
    );
    const view = deliveryNode(fixture.database, member, NOW);
    expect(view.status).toEqual({ lane: "needsYou", phrase: "ciFailing" });
    expect(view.taskId).toBe("t1");
    expect(view.pulls).toHaveLength(1);
    expect(view.endedAtMs).toBeNull();
  });

  it("gives the time every pull left the board", async () => {
    const member = await dispatch("t1");
    bind("t1", 7);
    saveSnapshot(
      fixture.database,
      REPO,
      snap({ state: "merged" }),
      NOW - 5_000,
    );
    const view = deliveryNode(fixture.database, member, NOW);
    expect(view.status).toEqual({ lane: "offBoard", phrase: "merged" });
    expect(view.endedAtMs).toBe(NOW - 5_000);
  });

  it("falls back to the item's end time when there is no snapshot", async () => {
    const member = await dispatch("t1");
    fixture.database
      .prepare(
        "UPDATE workflow_task_runs SET status = 'done', ended_at = ?, result_json = ? WHERE task_id = 't1'",
      )
      .run(NOW - 9_000, JSON.stringify({ result: "closed" }));
    const view = deliveryNode(fixture.database, member, NOW);
    expect(view.status).toEqual({ lane: "offBoard", phrase: "closed" });
    expect(view.endedAtMs).toBe(NOW - 9_000);
  });
});

describe("agentNodesOfBoard", () => {
  it("lists only terminal nodes that carry an agent", () => {
    const a = fixture.agentNode("a", "claude");
    fixture.agentNode("plain", null);
    fixture.stickyNode("note", "x");
    const listed = agentNodesOfBoard(fixture.database, fixture.boardId);
    expect(listed).toContain(a);
    expect(listed).toHaveLength(2); // lead 与 a
  });
});

describe("node links (契约 §116)", () => {
  function link(nodeId: string, number: number): void {
    fixture.database
      .prepare(
        "INSERT INTO node_pull_links (node_id, workspace_id, repo, number, head_ref, url, linked_at) VALUES (?, ?, ?, ?, 'x', 'u', 1)",
      )
      .run(nodeId, fixture.workspaceId, REPO, number);
  }

  it("a node with no work item gets the pulls linked by branch", () => {
    const node = fixture.agentNode("branchy", "claude");
    link(node, 7);
    saveSnapshot(fixture.database, REPO, snap(), NOW);
    const facts = deliveryFacts(fixture.database, node, NOW);
    expect(facts.taskId).toBeNull();
    expect(facts.pulls.map((pull) => pull.state)).toEqual(["open"]);
  });

  it("merges bound and linked pulls, de-duplicated by repo and number", async () => {
    const member = await dispatch("t1");
    bind("t1", 7);
    link(member, 7);
    link(member, 8);
    saveSnapshot(fixture.database, REPO, snap(), NOW);
    saveSnapshot(fixture.database, REPO, snap({ number: 8 }), NOW);
    const numbers = pullsOfNode(fixture.database, member, NOW).map(
      (pull) => pull.number,
    );
    expect(numbers).toEqual([7, 8]);
  });
});
