import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { EventBus } from "../bus";
import type { ForgeService } from "../forge/service";
import { PULL_EXTRAS, type ForgePull } from "../forge/types";
import type {
  NodeBranch,
  WorkspaceRepositoryService,
} from "../forge/workspace";
import {
  BRANCH_TTL_MS,
  EMPTY_TTL_MS,
  LINK_WINDOW_MS,
  MAX_HEAD_QUERIES,
  NodePullLinker,
  linkedPulls,
  nodesOfPull,
  snapshotTargets,
} from "./node-pulls";
import { bindThread } from "./threads";
import { recordTaskStart } from "./task-runs";

/**
 * 节点 → PR 关联（契约 §116）：用脚本化的平台与分支读取代替远端，断言触发、归属
 * 三条规则、释放、缓存、额度，以及这条路径上没有任何投递。
 */

const REPO = "github.com/acme/app";
const T0 = 1_800_000_000_000;

let fixture: AgentFixture;
let clock = T0;
let bus: EventBus;
let linker: NodePullLinker;
let changed: string[];
let branchReads: string[];
let headQueries: string[];
/** cwd → 分支；没有的读不到。 */
let branches: Map<string, string | null>;
/** `<owner>:<ref>` → 查到的 PR 编号。 */
let heads: Map<string, number[]>;

function pull(number: number): ForgePull {
  return {
    number,
    title: "t",
    body: "",
    state: "open",
    draft: false,
    author: "bob",
    baseRef: "main",
    headRef: "feat",
    headSha: "a".repeat(40),
    mergeable: "mergeable",
    url: `https://github.com/acme/app/pull/${number}`,
    createdAtMs: T0,
    updatedAtMs: T0,
    mergedAtMs: null,
    autoMerge: false,
    fromFork: false,
    ...PULL_EXTRAS,
  };
}

const repositories = {
  branchAt: async (_workspace: string, cwd: string) => {
    branchReads.push(cwd);
    const branch = branches.get(cwd);
    if (branch === undefined || branch === null) return null;
    return {
      repo: REPO,
      branch,
      head: { repo: REPO, owner: "acme", name: "app" },
    } satisfies NodeBranch;
  },
} as unknown as WorkspaceRepositoryService;

const service = {
  forgeForReady: async () => ({
    pullsByHead: async (
      _repo: unknown,
      head: { owner: string; ref: string },
    ) => {
      headQueries.push(`${head.owner}:${head.ref}`);
      return (heads.get(`${head.owner}:${head.ref}`) ?? []).map(pull);
    },
  }),
} as unknown as ForgeService;

/** 一个已经结束回合的节点，cwd 是 `/work/<名字>`，在 `branch` 上。 */
function node(name: string, branch: string | null, endedAt = clock): string {
  const id = fixture.agentNode(name, "codex");
  fixture.session(id, "codex");
  const cwd = `/work/${name}`;
  fixture.database
    .prepare("UPDATE terminal_sessions SET cwd = ? WHERE owner_node_id = ?")
    .run(cwd, id);
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at, last_event_at) " +
        "VALUES (?, ?, 'codex', 'done', 0, 0, 0, ?, ?)",
    )
    .run(
      id,
      fixture.workspaceId,
      new Date(endedAt).toISOString(),
      new Date(endedAt).toISOString(),
    );
  branches.set(cwd, branch);
  return id;
}

function emitDone(nodeId: string): void {
  bus.emit("workspace.event", {
    workspaceId: fixture.workspaceId,
    event: {
      type: "agent.status",
      status: { nodeId, state: "done" },
    } as never,
  });
}

function count(table: string): number {
  return (
    fixture.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  fixture = agentFixture();
  clock = T0;
  bus = new EventBus();
  changed = [];
  branchReads = [];
  headQueries = [];
  branches = new Map();
  heads = new Map();
  linker = new NodePullLinker({
    database: fixture.database,
    forge: () => service,
    repositories: () => repositories,
    bus,
    clock: () => clock,
    onLinkChanged: (nodeId) => changed.push(nodeId),
  });
});

afterEach(() => {
  linker.stop();
  fixture.close();
});

describe("triggers", () => {
  it("links a node whose turn just ended, and does nothing in the bus handler itself", async () => {
    const a = node("a", "feat/x", T0 - 3 * LINK_WINDOW_MS);
    heads.set("acme:feat/x", [5]);
    await linker.tick();
    // 回合早就结束了、也没有 done 事件：不查
    expect(headQueries).toEqual([]);
    emitDone(a);
    expect(headQueries).toEqual([]);
    await linker.tick();
    expect(headQueries).toEqual(["acme:feat/x"]);
    expect(linkedPulls(fixture.database, a)).toEqual([
      { repo: REPO, number: 5 },
    ]);
    expect(nodesOfPull(fixture.database, REPO, 5)).toEqual([a]);
    expect(snapshotTargets(fixture.database, clock)).toEqual([
      { repo: REPO, number: 5, workspaceId: fixture.workspaceId },
    ]);
    expect(changed).toEqual([a]);
  });

  it("looks again on the tick for turns that ended within 30 minutes, and stops after", async () => {
    const a = node("a", "feat/x", T0 - 10 * 60_000);
    heads.set("acme:feat/x", [5]);
    await linker.tick();
    expect(linkedPulls(fixture.database, a)).toHaveLength(1);
    const late = node("late", "feat/late", T0 - LINK_WINDOW_MS - 1);
    heads.set("acme:feat/late", [6]);
    await linker.tick();
    expect(linkedPulls(fixture.database, late)).toEqual([]);
  });

  it("skips detached heads, default branches and unreadable cwds", async () => {
    node("a", null);
    await linker.tick();
    expect(headQueries).toEqual([]);
    expect(count("node_pull_links")).toBe(0);
  });
});

describe("ownership", () => {
  it("first come keeps the pull, and a newcomer on the same branch gets nothing", async () => {
    const a = node("a", "feat/x", T0 - 60_000);
    heads.set("acme:feat/x", [5]);
    await linker.tick();
    const b = node("b", "feat/x", T0);
    clock += BRANCH_TTL_MS;
    emitDone(b);
    await linker.tick();
    expect(nodesOfPull(fixture.database, REPO, 5)).toEqual([a]);
    expect(linkedPulls(fixture.database, b)).toEqual([]);
  });

  it("a new contest goes to the newest last event, then the smallest node id", async () => {
    const older = node("older", "feat/x", T0 - 60_000);
    const newer = node("newer", "feat/x", T0);
    heads.set("acme:feat/x", [5]);
    await linker.tick();
    expect(nodesOfPull(fixture.database, REPO, 5)).toEqual([newer]);
    expect(linkedPulls(fixture.database, older)).toEqual([]);

    const x = node("x", "feat/y", T0);
    const y = node("y", "feat/y", T0);
    heads.set("acme:feat/y", [6]);
    await linker.tick();
    expect(nodesOfPull(fixture.database, REPO, 6)).toEqual([[x, y].sort()[0]]);
  });

  it("releases when the node moves off the branch, and a waiting node takes over in the same tick", async () => {
    const a = node("a", "feat/x", T0 - 60_000);
    heads.set("acme:feat/x", [5]);
    await linker.tick();
    const b = node("b", "feat/x", T0);
    branches.set("/work/a", "feat/other");
    clock += BRANCH_TTL_MS;
    await linker.tick();
    expect(linkedPulls(fixture.database, a)).toEqual([]);
    expect(nodesOfPull(fixture.database, REPO, 5)).toEqual([b]);
    expect(changed).toContain(a);
    const row = fixture.database
      .prepare(
        "SELECT released_at FROM node_pull_links WHERE node_id = ? AND number = 5",
      )
      .get(a) as { released_at: number | null };
    expect(row.released_at).toBe(clock);
  });

  it("keeps the link when the branch cannot be read, and releases when the node is deleted", async () => {
    const a = node("a", "feat/x", T0 - 60_000);
    heads.set("acme:feat/x", [5]);
    await linker.tick();
    branches.set("/work/a", null);
    clock += BRANCH_TTL_MS;
    await linker.tick();
    expect(linkedPulls(fixture.database, a)).toHaveLength(1);
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(a);
    await linker.tick();
    expect(linkedPulls(fixture.database, a)).toEqual([]);
    expect(nodesOfPull(fixture.database, REPO, 5)).toEqual([]);
  });

  function bound(owner: string): void {
    recordTaskStart(fixture.database, {
      taskId: "t1",
      coordinatorNodeId: fixture.agentNode("lead", "ama"),
      runnerId: "codex",
      nodeId: owner,
      now: T0 - 10_000,
    });
    bindThread(
      fixture.database,
      "t1",
      {
        kind: "pull",
        repo: REPO,
        number: 5,
        own: true,
        url: "https://github.com/acme/app/pull/5",
      },
      T0,
    );
  }

  it("a pull bound to a running work item is not linked to a branch node", async () => {
    const worker = node("worker", "feat/w");
    node("a", "feat/x");
    bound(worker);
    heads.set("acme:feat/x", [5]);
    await linker.tick();
    expect(count("node_pull_links")).toBe(0);
  });

  it("a binding that appears later takes the pull away from a linked node", async () => {
    const a = node("a", "feat/x", T0 - 60_000);
    const worker = node("worker", "feat/w");
    heads.set("acme:feat/x", [5]);
    await linker.tick();
    expect(nodesOfPull(fixture.database, REPO, 5)).toEqual([a]);
    bound(worker);
    await linker.tick();
    expect(nodesOfPull(fixture.database, REPO, 5)).toEqual([]);
    expect(changed.filter((id) => id === a)).toHaveLength(2);
  });
});

describe("caches and budget", () => {
  it("caches an empty answer for five minutes", async () => {
    const a = node("a", "feat/x");
    await linker.tick();
    expect(headQueries).toHaveLength(1);
    clock += EMPTY_TTL_MS - 1;
    await linker.tick();
    expect(headQueries).toHaveLength(1);
    clock += 1;
    heads.set("acme:feat/x", [5]);
    await linker.tick();
    expect(headQueries).toHaveLength(2);
    expect(linkedPulls(fixture.database, a)).toHaveLength(1);
  });

  it("caches the branch of a cwd for two minutes, but not for a node whose turn just ended", async () => {
    const a = node("a", "feat/x");
    await linker.tick();
    expect(branchReads).toEqual(["/work/a"]);
    clock += BRANCH_TTL_MS - 1;
    await linker.tick();
    expect(branchReads).toHaveLength(1);
    emitDone(a);
    await linker.tick();
    expect(branchReads).toHaveLength(2);
    clock += BRANCH_TTL_MS;
    await linker.tick();
    expect(branchReads).toHaveLength(3);
  });

  it("asks at most ten heads per tick and carries the rest over", async () => {
    for (let i = 0; i < MAX_HEAD_QUERIES + 2; i += 1) {
      node(`n${i}`, `feat/${i}`);
      heads.set(`acme:feat/${i}`, [100 + i]);
    }
    await linker.tick();
    expect(headQueries).toHaveLength(MAX_HEAD_QUERIES);
    expect(count("node_pull_links")).toBe(MAX_HEAD_QUERIES);
    await linker.tick();
    expect(count("node_pull_links")).toBe(MAX_HEAD_QUERIES + 2);
  });
});

describe("snapshotTargets", () => {
  it("drops pulls whose snapshot is merged or closed, keeps the unread and open ones", async () => {
    node("a", "feat/a");
    node("b", "feat/b");
    node("c", "feat/c");
    heads.set("acme:feat/a", [1]);
    heads.set("acme:feat/b", [2]);
    heads.set("acme:feat/c", [3]);
    await linker.tick();
    const save = fixture.database.prepare(
      "INSERT INTO pull_snapshots (repo, number, snapshot_json, fingerprint, fetched_at) VALUES (?, ?, ?, 'f', 1)",
    );
    save.run(REPO, 1, JSON.stringify({ state: "open" }));
    save.run(REPO, 2, JSON.stringify({ state: "merged" }));
    expect(
      snapshotTargets(fixture.database, clock).map((target) => target.number),
    ).toEqual([1, 3]);
    // 终态的关联仍在，供「移出看板」。
    expect(count("node_pull_links")).toBe(3);
  });
});

describe("no delivery", () => {
  it("writes neither the mailbox nor the thread ledger", async () => {
    const a = node("a", "feat/x");
    heads.set("acme:feat/x", [5]);
    emitDone(a);
    await linker.tick();
    expect(count("node_pull_links")).toBe(1);
    expect(count("agent_mailbox")).toBe(0);
    expect(count("thread_events")).toBe(0);
    expect(fixture.terminal.writes).toEqual([]);
    expect(fixture.terminal.submits).toEqual([]);
  });

  it("the module has no way to read discussions or deliver", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "node-pulls.ts"),
      "utf8",
    );
    for (const word of ["conversation", "recordThreadEvent", "deliver"]) {
      expect(source).not.toContain(word);
    }
  });
});
