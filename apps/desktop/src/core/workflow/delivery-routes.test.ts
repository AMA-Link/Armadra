import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listBoards } from "../canvas/boards";
import { type Fixture, fixture } from "../workspaces/fixture";
import { createWorkspace } from "../workspaces/table";
import { installDeliveryRoutes } from "./delivery-routes";
import { saveSnapshot } from "./pull-snapshots";

const NOW = 1_800_000_000_000;

let fx: Fixture;
let ws: string;
let board: string;

function insertNode(id: string, data: Record<string, unknown>): void {
  fx.database
    .prepare(
      "INSERT INTO nodes (id, board_id, type, title, data_json, x, y, width, height, created_at, updated_at) " +
        "VALUES (?, ?, 'terminal', ?, ?, 0, 0, 100, 100, 't', 't')",
    )
    .run(id, board, id, JSON.stringify(data));
}

beforeEach(() => {
  fx = fixture([
    (context) =>
      installDeliveryRoutes(context.server, {
        database: context.db.database,
        now: () => NOW,
      }),
  ]);
  ws = createWorkspace(fx.database, { name: "w", rootPath: fx.directory }).id;
  board = listBoards(fx.database, ws)[0]?.id as string;
});

afterEach(() => fx.close());

describe("GET …/boards/{boardId}/delivery", () => {
  it("lists only the agent terminal nodes of the board, each with a lane and phrase", async () => {
    insertNode("a1", { kind: "terminal", agent: { id: "claude" } });
    insertNode("plain", { kind: "terminal" });
    const response = await fx.call(
      "GET",
      `/api/workspaces/${ws}/boards/${board}/delivery`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      nodes: [
        {
          nodeId: "a1",
          taskId: null,
          lane: "working",
          phrase: "idle",
          pulls: [],
          endedAtMs: null,
          children: null,
        },
      ],
    });
  });

  it("carries the current batch of children of a supervising node", async () => {
    insertNode("lead", { kind: "terminal", agent: { id: "ama" } });
    insertNode("kid", { kind: "terminal", agent: { id: "codex" } });
    fx.database
      .prepare(
        "INSERT INTO edges (id, board_id, source_node_id, target_node_id, kind, role, created_at, updated_at) " +
          "VALUES ('e1', ?, 'lead', 'kid', 'link', 'supervises', 't', 't')",
      )
      .run(board);
    fx.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at, last_event_at) " +
          "VALUES ('kid', ?, 'codex', 'working', 0, 1, 0, 't', ?)",
      )
      .run(ws, new Date(NOW).toISOString());
    const body = (
      await fx.call("GET", `/api/workspaces/${ws}/boards/${board}/delivery`)
    ).body as {
      nodes: { nodeId: string; phrase: string; children: unknown }[];
    };
    const lead = body.nodes.find((node) => node.nodeId === "lead");
    expect(lead).toMatchObject({
      phrase: "waitingOnChildren",
      children: {
        total: 1,
        finished: 0,
        needsYou: 0,
        nodes: [{ nodeId: "kid", source: "edge", finished: false }],
      },
    });
  });

  it("carries the bound pull snapshots of a work item", async () => {
    insertNode("a1", { kind: "terminal", agent: { id: "claude" } });
    fx.database
      .prepare(
        "INSERT INTO workflow_task_runs (task_id, coordinator_node_id, runner_id, node_id, status, started_at, threads) VALUES ('t1', 'a1', 'r', 'a1', 'running', 1, ?)",
      )
      .run(
        JSON.stringify([
          {
            kind: "pull",
            repo: "h/o/r",
            number: 7,
            own: true,
            url: "u",
            boundAt: 1,
          },
        ]),
      );
    saveSnapshot(
      fx.database,
      "h/o/r",
      {
        number: 7,
        url: "u",
        title: "t",
        state: "open",
        draft: false,
        baseRef: "main",
        headRef: "x",
        headSha: "s",
        fromFork: false,
        review: "reviewRequired",
        checks: { read: true, headSha: "s", rollup: "success", failing: [] },
        mergeable: "mergeable",
        parent: { kind: "none" },
      },
      NOW,
    );
    const body = (
      await fx.call("GET", `/api/workspaces/${ws}/boards/${board}/delivery`)
    ).body as {
      nodes: {
        lane: string;
        phrase: string;
        pulls: unknown[];
        taskId: string;
      }[];
    };
    expect(body.nodes[0]).toMatchObject({
      taskId: "t1",
      lane: "inReview",
      phrase: "awaitingReview",
    });
    expect(body.nodes[0]?.pulls).toHaveLength(1);
  });

  it("lists an agent node that has no work item but a branch-linked pull (taskId null)", async () => {
    insertNode("a1", { kind: "terminal", agent: { id: "claude" } });
    fx.database
      .prepare(
        "INSERT INTO node_pull_links (node_id, workspace_id, repo, number, head_ref, url, linked_at) VALUES ('a1', ?, 'h/o/r', 7, 'x', 'u', 1)",
      )
      .run(ws);
    saveSnapshot(
      fx.database,
      "h/o/r",
      {
        number: 7,
        url: "u",
        title: "t",
        state: "open",
        draft: false,
        baseRef: "main",
        headRef: "x",
        headSha: "s",
        fromFork: false,
        review: "approved",
        checks: { read: true, headSha: "s", rollup: "success", failing: [] },
        mergeable: "mergeable",
        parent: { kind: "none" },
      },
      NOW,
    );
    const body = (
      await fx.call("GET", `/api/workspaces/${ws}/boards/${board}/delivery`)
    ).body as {
      nodes: {
        taskId: unknown;
        lane: string;
        phrase: string;
        pulls: unknown[];
      }[];
    };
    expect(body.nodes[0]).toMatchObject({
      taskId: null,
      lane: "readyToMerge",
      phrase: "approved",
    });
    expect(body.nodes[0]?.pulls).toHaveLength(1);
  });

  it("answers 404 for a board of another workspace", async () => {
    const other = createWorkspace(fx.database, {
      name: "o",
      rootPath: `${fx.directory}/o`,
    }).id;
    const response = await fx.call(
      "GET",
      `/api/workspaces/${other}/boards/${board}/delivery`,
    );
    expect(response.status).toBe(404);
  });
});
