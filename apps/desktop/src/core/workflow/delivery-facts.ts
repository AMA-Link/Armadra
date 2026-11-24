import type { DatabaseSync } from "node:sqlite";
import type { AgentState, DeliveryStatus, PullSnapshot } from "@armadra/shared";
import { getAgentStatus } from "../agent/status";
import { type DeliveryFacts, deliveryStatus } from "./delivery";
import { linkedPulls } from "./node-pulls";
import { loadSnapshots } from "./pull-snapshots";
import type { TaskRun } from "./task-runs";
import { itemsOfNode, stageOf } from "./work-items";

/**
 * 交付状态的事实收集（Armadra#988）：把一个节点的 Agent 状态、最近的工作项与
 * 它名下的 PR 快照读成 {@link DeliveryFacts}，再交给纯函数。只读库，不碰终端输出。
 */

/** 工作项自己结束的结论（自己开的 PR 合并或关闭，契约 §103.4）。 */
function itemResultOf(run: TaskRun): "merged" | "closed" | null {
  if (run.status !== "done") return null;
  const result = run.result as { result?: unknown } | null;
  if (result === null || typeof result !== "object") return null;
  return result.result === "merged" || result.result === "closed"
    ? result.result
    : null;
}

/** 一个节点最近的工作项；没有是 `undefined`。 */
function latestItem(
  database: DatabaseSync,
  nodeId: string,
): TaskRun | undefined {
  return itemsOfNode(database, nodeId)[0];
}

/**
 * 一个节点名下的 PR 快照。
 *
 * 两个来源，按 (repo, number) 去重，绑定优先：最近那个工作项绑定的 pull 线程，
 * 和按分支找到的节点关联（`node-pulls.ts` 的 `linkedPulls`，契约 §116）。没有
 * 工作项、只靠分支关联的节点也有 PR。还没读到快照的 PR 先不出现。
 */
export function pullsOfNode(
  database: DatabaseSync,
  nodeId: string,
  nowMs: number,
): PullSnapshot[] {
  const item = latestItem(database, nodeId);
  const keys = new Map<string, { repo: string; number: number }>();
  for (const thread of item?.threads ?? []) {
    if (thread.kind !== "pull") continue;
    keys.set(`${thread.repo}#${thread.number}`, {
      repo: thread.repo,
      number: thread.number,
    });
  }
  for (const link of linkedPulls(database, nodeId)) {
    const key = `${link.repo}#${link.number}`;
    if (!keys.has(key)) keys.set(key, link);
  }
  return loadSnapshots(database, [...keys.values()], nowMs);
}

export interface DeliveryNodeView {
  readonly nodeId: string;
  readonly taskId: string | null;
  readonly status: DeliveryStatus;
  readonly pulls: readonly PullSnapshot[];
  readonly endedAtMs: number | null;
}

export function deliveryFacts(
  database: DatabaseSync,
  nodeId: string,
  nowMs: number,
): DeliveryFacts & {
  readonly allPulls: readonly PullSnapshot[];
  readonly taskId: string | null;
  readonly endedAt: number | null;
} {
  const row = getAgentStatus(database, nodeId);
  const item = latestItem(database, nodeId);
  const allPulls = pullsOfNode(database, nodeId, nowMs);
  return {
    agent:
      row === undefined
        ? null
        : {
            state: (row.state ?? null) as AgentState | null,
            pending: row.pendingId !== undefined,
            errored: row.errored === true,
            interrupted: row.interrupted === true,
            endedBy: row.endedBy ?? null,
          },
    stage:
      item === undefined
        ? null
        : stageOf(database, item, Math.floor(nowMs / 1000)),
    itemResult: item === undefined ? null : itemResultOf(item),
    pulls: allPulls,
    allPulls,
    taskId: item?.taskId ?? null,
    endedAt: item?.endedAt ?? null,
  };
}

/** 一个节点的交付状态与它名下的 PR；离开看板的节点带上离开的时刻。 */
export function deliveryNode(
  database: DatabaseSync,
  nodeId: string,
  nowMs: number,
): DeliveryNodeView {
  const facts = deliveryFacts(database, nodeId, nowMs);
  const status = deliveryStatus(facts);
  let endedAtMs: number | null = null;
  if (status.lane === "offBoard") {
    // 终态的快照不再被轮询，读取时刻就是记下终态的时刻；没有快照时用工作项的结束时刻。
    const times = facts.allPulls.map((pull) => pull.fetchedAtMs);
    endedAtMs = times.length > 0 ? Math.max(...times) : facts.endedAt;
  }
  return {
    nodeId,
    taskId: facts.taskId,
    status,
    pulls: facts.allPulls,
    endedAtMs,
  };
}

/** 一块画板上带 Agent 的终端节点。 */
export function agentNodesOfBoard(
  database: DatabaseSync,
  boardId: string,
): string[] {
  const rows = database
    .prepare(
      "SELECT id, data_json FROM nodes WHERE board_id = ? AND type = 'terminal' ORDER BY id",
    )
    .all(boardId) as { id: string; data_json: string }[];
  const found: string[] = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { agent?: { id?: unknown } };
      if (typeof data.agent?.id === "string" && data.agent.id !== "") {
        found.push(row.id);
      }
    } catch {
      // 损坏的节点数据：不列。
    }
  }
  return found;
}
