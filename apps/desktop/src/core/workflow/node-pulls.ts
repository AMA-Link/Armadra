import type { DatabaseSync } from "node:sqlite";
import type { EventBus } from "../bus";
import { launchOf, loadNode } from "../collab/nodes";
import type { ForgeService } from "../forge/service";
import { ForgeError, type ForgePull } from "../forge/types";
import type {
  NodeBranch,
  WorkspaceRepositoryService,
} from "../forge/workspace";
import { type SnapshotTarget, parseRepo } from "./pr-watch";
import { threadsOf } from "./task-runs";

/**
 * 节点 → PR 关联（契约 §116，#988 P2）。
 *
 * 一个 Agent 节点停在哪个分支，那个分支上开着的 PR 就记进 `node_pull_links`，之后
 * 只经 PR 轮询的「只刷快照」入口（`snapshotTargets`）读状态。这条路径不读讨论、
 * 不记事件账、不碰任何 Agent 终端：本文件没有任何写入收件箱或事件账的代码。
 */

/** 回合结束后多久之内还会去找 PR（毫秒）。 */
export const LINK_WINDOW_MS = 30 * 60_000;
/** `(工作空间, cwd)` → 分支的缓存时间；有结果的 head 查询也按这个时间缓存。 */
export const BRANCH_TTL_MS = 2 * 60_000;
/** head 查询查到空的负缓存时间。 */
export const EMPTY_TTL_MS = 5 * 60_000;
/** 每次 tick 最多发这么多次 head 查询。 */
export const MAX_HEAD_QUERIES = 10;

interface LinkRow {
  readonly node_id: string;
  readonly workspace_id: string;
  readonly repo: string;
  readonly number: number;
  readonly head_ref: string;
}

/** 这个节点关联着的 PR（含已合并、已关闭的，供「移出看板」）；不含已释放的。 */
export function linkedPulls(
  database: DatabaseSync,
  nodeId: string,
): readonly { readonly repo: string; readonly number: number }[] {
  const rows = database
    .prepare(
      "SELECT repo, number FROM node_pull_links WHERE node_id = ? AND released_at IS NULL " +
        "ORDER BY linked_at, repo, number",
    )
    .all(nodeId) as { repo: string; number: number }[];
  return rows.map((row) => ({ repo: row.repo, number: Number(row.number) }));
}

/** 这个 PR 现在归哪个节点（至多一个）。 */
export function nodesOfPull(
  database: DatabaseSync,
  repo: string,
  number: number,
): readonly string[] {
  const rows = database
    .prepare(
      "SELECT node_id FROM node_pull_links WHERE repo = ? AND number = ? AND released_at IS NULL",
    )
    .all(repo, number) as { node_id: string }[];
  return rows.map((row) => row.node_id);
}

/** 要只刷快照的 PR：关联还在，且快照还没有终态（或一次都没读过）。 */
export function snapshotTargets(
  database: DatabaseSync,
  _nowMs: number,
): readonly SnapshotTarget[] {
  const rows = database
    .prepare(
      "SELECT l.repo AS repo, l.number AS number, l.workspace_id AS workspace_id " +
        "FROM node_pull_links l LEFT JOIN pull_snapshots s ON s.repo = l.repo AND s.number = l.number " +
        "WHERE l.released_at IS NULL AND " +
        "COALESCE(json_extract(s.snapshot_json, '$.state'), 'open') NOT IN ('merged', 'closed') " +
        "ORDER BY l.linked_at, l.repo, l.number",
    )
    .all() as { repo: string; number: number; workspace_id: string }[];
  return rows.map((row) => ({
    repo: row.repo,
    number: Number(row.number),
    workspaceId: row.workspace_id,
  }));
}

export interface NodePullLinkerOptions {
  readonly database: DatabaseSync;
  readonly forge: () => ForgeService | undefined;
  readonly repositories: () => WorkspaceRepositoryService | undefined;
  readonly bus?: EventBus | undefined;
  /** 毫秒。 */
  readonly clock?: () => number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** 一个节点的关联集合变了（新关联或释放）；订阅者自己去读 {@link linkedPulls}。 */
  readonly onLinkChanged?: (nodeId: string) => void;
}

interface Candidate {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly lastEventAt: number;
  readonly branch: NodeBranch;
}

function byRecency(a: Candidate, b: Candidate): number {
  if (a.lastEventAt !== b.lastEventAt) return b.lastEventAt - a.lastEventAt;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

function time(text: string | null): number {
  if (text === null) return 0;
  const value = Date.parse(text);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 找节点的 PR。触发：总线上 `agent.status` 变成 `done`（回合结束）时把节点放进
 * 待查集合；每次 tick（60 秒）再查「上一回合 30 分钟内结束、还没有关联」的节点。
 * 归属规则（契约 §116.3）：
 *
 *   1. 绑在某个运行中工作项上的 PR 归那个工作项的节点，这里不为它建关联；
 *   2. 已经有有效关联的保持不变，除非那个节点没了或切走了分支；
 *   3. 新的竞争取 `agent_status.last_event_at` 最新的节点，相同取 id 最小的。
 */
export class NodePullLinker {
  private running = false;
  private readonly pending = new Set<string>();
  private readonly branches = new Map<
    string,
    { readonly at: number; readonly value: NodeBranch | null }
  >();
  private readonly heads = new Map<
    string,
    { readonly at: number; readonly pulls: readonly ForgePull[] }
  >();
  private off: (() => void) | undefined;

  constructor(private readonly options: NodePullLinkerOptions) {
    this.off = options.bus?.on("workspace.event", ({ event }) => {
      if (event.type !== "agent.status") return;
      const status = event.status as { nodeId?: unknown; state?: unknown };
      if (typeof status.nodeId === "string" && status.state === "done") {
        this.pending.add(status.nodeId);
      }
    });
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
  }

  private get now(): number {
    return (this.options.clock ?? Date.now)();
  }

  /** 查一遍。上一遍没完就什么也不做；单个节点出错不影响别的。 */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const forge = this.options.forge();
      const repositories = this.options.repositories();
      if (forge === undefined || repositories === undefined) return;
      const fresh = new Set(this.pending);
      this.pending.clear();
      const changed = new Set<string>();
      await this.verify(repositories, fresh, changed);
      await this.discover(forge, repositories, fresh, changed);
      for (const nodeId of changed) {
        try {
          this.options.onLinkChanged?.(nodeId);
        } catch (error) {
          this.options.log?.("节点关联回调失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** 缓存两分钟；`fresh` 的节点刚结束回合，绕过缓存。读不到是 `null`。 */
  private async branchOf(
    repositories: WorkspaceRepositoryService,
    workspaceId: string,
    cwd: string,
    fresh: boolean,
  ): Promise<NodeBranch | null> {
    const key = `${workspaceId}|${cwd}`;
    const hit = this.branches.get(key);
    if (!fresh && hit !== undefined && this.now - hit.at < BRANCH_TTL_MS) {
      return hit.value;
    }
    const value = await repositories.branchAt(workspaceId, cwd);
    this.branches.set(key, { at: this.now, value });
    return value;
  }

  /** 绑在运行中工作项上的 PR → 那个工作项的节点。 */
  private boundOwners(): Map<string, string> {
    const rows = this.options.database
      .prepare(
        "SELECT node_id, threads FROM workflow_task_runs WHERE status = 'running' " +
          "AND threads IS NOT NULL AND threads <> '[]'",
      )
      .all() as { node_id: string; threads: string }[];
    const owners = new Map<string, string>();
    for (const row of rows) {
      for (const thread of threadsOf(row.threads)) {
        if (thread.kind !== "pull") continue;
        const key = `${thread.repo}#${thread.number}`;
        if (!owners.has(key)) owners.set(key, row.node_id);
      }
    }
    return owners;
  }

  private release(row: LinkRow): void {
    this.options.database
      .prepare(
        "UPDATE node_pull_links SET released_at = ? WHERE node_id = ? AND repo = ? AND number = ? " +
          "AND released_at IS NULL",
      )
      .run(this.now, row.node_id, row.repo, row.number);
  }

  /** 已有的关联：节点没了、切走了分支、被工作项绑定夺走的释放掉。 */
  private async verify(
    repositories: WorkspaceRepositoryService,
    fresh: ReadonlySet<string>,
    changed: Set<string>,
  ): Promise<void> {
    const database = this.options.database;
    const rows = database
      .prepare(
        "SELECT node_id, workspace_id, repo, number, head_ref FROM node_pull_links " +
          "WHERE released_at IS NULL ORDER BY node_id, repo, number",
      )
      .all() as unknown as LinkRow[];
    if (rows.length === 0) return;
    const bound = this.boundOwners();
    const byNode = new Map<string, LinkRow[]>();
    for (const row of rows) {
      const owner = bound.get(`${row.repo}#${row.number}`);
      if (owner !== undefined && owner !== row.node_id) {
        this.release(row);
        changed.add(row.node_id);
        continue;
      }
      byNode.set(row.node_id, [...(byNode.get(row.node_id) ?? []), row]);
    }
    for (const [nodeId, links] of byNode) {
      try {
        const node = loadNode(database, nodeId);
        if (node === undefined) {
          for (const row of links) this.release(row);
          changed.add(nodeId);
          continue;
        }
        const cwd = launchOf(database, nodeId).cwd;
        if (cwd === undefined) continue;
        const branch = await this.branchOf(
          repositories,
          node.workspaceId,
          cwd,
          fresh.has(nodeId),
        );
        // 读不到（游离 HEAD、默认分支、主机不可达）分不出是切走还是读失败：保持。
        if (branch === null) continue;
        for (const row of links) {
          if (row.repo === branch.repo && row.head_ref === branch.branch) {
            continue;
          }
          this.release(row);
          changed.add(nodeId);
        }
      } catch (error) {
        this.logFailure("节点关联复核失败", nodeId, error);
      }
    }
  }

  /** 回合刚结束（或最近 30 分钟内结束）又还没关联的节点：去找 PR。 */
  private async discover(
    forge: ForgeService,
    repositories: WorkspaceRepositoryService,
    fresh: ReadonlySet<string>,
    changed: Set<string>,
  ): Promise<void> {
    const database = this.options.database;
    const now = this.now;
    const rows = database
      .prepare(
        "SELECT node_id, workspace_id, last_event_at FROM agent_status WHERE state = 'done' " +
          "ORDER BY last_event_at DESC LIMIT 200",
      )
      .all() as {
      node_id: string;
      workspace_id: string;
      last_event_at: string | null;
    }[];
    const seen = new Set(rows.map((row) => row.node_id));
    const lookup = database.prepare(
      "SELECT node_id, workspace_id, last_event_at FROM agent_status WHERE node_id = ? AND state = 'done'",
    );
    for (const nodeId of fresh) {
      if (seen.has(nodeId)) continue;
      const row = lookup.get(nodeId) as (typeof rows)[number] | undefined;
      if (row !== undefined) rows.push(row);
    }
    const linked = new Set(
      (
        database
          .prepare(
            "SELECT DISTINCT node_id FROM node_pull_links WHERE released_at IS NULL",
          )
          .all() as { node_id: string }[]
      ).map((row) => row.node_id),
    );
    const groups = new Map<string, Candidate[]>();
    for (const row of rows) {
      const lastEventAt = time(row.last_event_at);
      if (linked.has(row.node_id)) continue;
      if (!fresh.has(row.node_id) && now - lastEventAt > LINK_WINDOW_MS) {
        continue;
      }
      try {
        if (loadNode(database, row.node_id) === undefined) continue;
        const cwd = launchOf(database, row.node_id).cwd;
        if (cwd === undefined) continue;
        const branch = await this.branchOf(
          repositories,
          row.workspace_id,
          cwd,
          fresh.has(row.node_id),
        );
        if (branch === null) continue;
        const key = `${branch.repo}|${branch.head.repo}|${branch.branch}`;
        groups.set(key, [
          ...(groups.get(key) ?? []),
          {
            nodeId: row.node_id,
            workspaceId: row.workspace_id,
            lastEventAt,
            branch,
          },
        ]);
      } catch (error) {
        this.logFailure("节点分支读取失败", row.node_id, error);
      }
    }
    let queries = 0;
    for (const [key, contenders] of groups) {
      const first = contenders[0] as Candidate;
      const hit = this.heads.get(key);
      const ttl =
        hit !== undefined && hit.pulls.length === 0
          ? EMPTY_TTL_MS
          : BRANCH_TTL_MS;
      let pulls: readonly ForgePull[];
      if (hit !== undefined && now - hit.at < ttl) {
        pulls = hit.pulls;
      } else {
        if (queries >= MAX_HEAD_QUERIES) continue;
        queries += 1;
        try {
          pulls = await this.queryHead(forge, first);
        } catch (error) {
          pulls = [];
          this.logFailure("head 查询失败", first.nodeId, error);
        }
        this.heads.set(key, { at: now, pulls });
      }
      this.claim(contenders, pulls, changed);
    }
  }

  private async queryHead(
    forge: ForgeService,
    candidate: Candidate,
  ): Promise<readonly ForgePull[]> {
    const { branch } = candidate;
    const repo = parseRepo(branch.repo);
    if (repo === undefined) return [];
    const remote = await forge.forgeForReady(repo, candidate.workspaceId);
    if (remote.pullsByHead === undefined) return [];
    return await remote.pullsByHead(repo, {
      owner: branch.head.owner,
      ref: branch.branch,
      name: branch.head.name,
    });
  }

  /** 把查到的 PR 按规则 1 → 2 → 3 分给竞争者。 */
  private claim(
    contenders: readonly Candidate[],
    pulls: readonly ForgePull[],
    changed: Set<string>,
  ): void {
    if (pulls.length === 0) return;
    const database = this.options.database;
    const bound = this.boundOwners();
    const winner = [...contenders].sort(byRecency)[0] as Candidate;
    for (const pull of pulls) {
      const repo = winner.branch.repo;
      if (bound.has(`${repo}#${pull.number}`)) continue;
      if (nodesOfPull(database, repo, pull.number).length > 0) continue;
      database
        .prepare(
          "INSERT INTO node_pull_links (node_id, workspace_id, repo, number, head_ref, url, linked_at, released_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(node_id, repo, number) DO UPDATE SET " +
            "workspace_id = excluded.workspace_id, head_ref = excluded.head_ref, url = excluded.url, " +
            "linked_at = excluded.linked_at, released_at = NULL",
        )
        .run(
          winner.nodeId,
          winner.workspaceId,
          repo,
          pull.number,
          winner.branch.branch,
          pull.url,
          this.now,
        );
      changed.add(winner.nodeId);
    }
  }

  private logFailure(message: string, nodeId: string, error: unknown): void {
    // 只记固定的种类，不记远端原话，更不会有凭据。
    this.options.log?.(message, {
      nodeId,
      kind: error instanceof ForgeError ? error.kind : "unknown",
      reason: error instanceof ForgeError ? error.reason : "",
    });
  }
}
