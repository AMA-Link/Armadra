import type { DatabaseSync } from "node:sqlite";
import type { DeliveryChildSource } from "@armadra/shared";

/**
 * 交付状态的子节点收集（Armadra#995，设计 §1.2）。三个来源：工作项
 * （`workflow_task_runs.coordinator_node_id`）、工作流 `collect` 步骤的来源步骤、
 * `supervises` 连线。只读库；只收与父节点同一块画板、带 Agent 的终端节点；
 * 同一子节点出现在多个来源时取 工作项 > 工作流 > 连线。
 */

export interface ChildRow {
  readonly nodeId: string;
  readonly source: DeliveryChildSource;
  readonly finished: boolean;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
}

const PRIORITY: Record<DeliveryChildSource, number> = {
  task: 0,
  workflow: 1,
  edge: 2,
};

const STEP_FINAL = ["done", "failed", "skipped", "cancelled"];

interface NodeRow {
  readonly board_id: string;
  readonly type: string;
  readonly data_json: string;
}

function nodeOf(database: DatabaseSync, nodeId: string): NodeRow | undefined {
  return database
    .prepare("SELECT board_id, type, data_json FROM nodes WHERE id = ?")
    .get(nodeId) as NodeRow | undefined;
}

function hasAgent(row: NodeRow): boolean {
  if (row.type !== "terminal") return false;
  try {
    const data = JSON.parse(row.data_json) as { agent?: { id?: unknown } };
    return typeof data.agent?.id === "string" && data.agent.id !== "";
  } catch {
    return false;
  }
}

function timeOf(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/** 一个 `workflow_runs.template_json` 里某个步骤的 `from`。 */
function fromOf(templateJson: string, stepId: string): string[] {
  try {
    const template = JSON.parse(templateJson) as {
      steps?: { id?: unknown; kind?: unknown; from?: unknown }[];
    };
    const step = template.steps?.find((item) => item.id === stepId);
    if (step === undefined || step.kind !== "collect") return [];
    return Array.isArray(step.from)
      ? step.from.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

interface CollectRow {
  readonly run_id: string;
  readonly step_id: string;
  readonly status: string;
  readonly template_json: string;
}

/** 本节点作为角色、运行还活着、步骤不在终态的 `collect` 步骤。 */
function liveCollects(database: DatabaseSync, nodeId: string): CollectRow[] {
  return database
    .prepare(
      "SELECT s.run_id AS run_id, s.step_id AS step_id, s.status AS status, r.template_json AS template_json " +
        "FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id " +
        "WHERE s.node_id = ? AND s.kind = 'collect' " +
        "AND r.status IN ('running', 'waiting') " +
        "AND s.status NOT IN ('done', 'failed', 'skipped', 'cancelled')",
    )
    .all(nodeId) as unknown as CollectRow[];
}

/** 一个节点的子节点（已去重、已滤掉跨画板与非 Agent 节点）。 */
export function childrenOf(
  database: DatabaseSync,
  nodeId: string,
  sinceMs: number,
): ChildRow[] {
  const parent = nodeOf(database, nodeId);
  if (parent === undefined) return [];
  const found = new Map<string, ChildRow>();
  const add = (row: ChildRow): void => {
    if (row.nodeId === nodeId || row.nodeId === "") return;
    const known = found.get(row.nodeId);
    if (known !== undefined && PRIORITY[known.source] <= PRIORITY[row.source])
      return;
    const node = nodeOf(database, row.nodeId);
    if (node === undefined || node.board_id !== parent.board_id) return;
    if (!hasAgent(node)) return;
    found.set(row.nodeId, row);
  };

  const tasks = database
    .prepare(
      "SELECT node_id, status, started_at, ended_at FROM workflow_task_runs " +
        "WHERE coordinator_node_id = ? AND (status = 'running' OR ended_at >= ?)",
    )
    .all(nodeId, sinceMs) as {
    node_id: string;
    status: string;
    started_at: number;
    ended_at: number | null;
  }[];
  for (const task of tasks) {
    const finished = task.status !== "running";
    add({
      nodeId: task.node_id,
      source: "task",
      finished,
      startedAtMs: Number(task.started_at),
      endedAtMs:
        finished && task.ended_at !== null ? Number(task.ended_at) : null,
    });
  }

  for (const collect of liveCollects(database, nodeId)) {
    const wanted = fromOf(collect.template_json, collect.step_id);
    if (wanted.length === 0) continue;
    const steps = database
      .prepare(
        "SELECT step_id, node_id, status, started_at, ended_at FROM workflow_run_steps " +
          "WHERE run_id = ? AND node_id IS NOT NULL",
      )
      .all(collect.run_id) as {
      step_id: string;
      node_id: string;
      status: string;
      started_at: number | null;
      ended_at: number | null;
    }[];
    for (const step of steps) {
      if (!wanted.includes(step.step_id)) continue;
      const finished = STEP_FINAL.includes(step.status);
      add({
        nodeId: step.node_id,
        source: "workflow",
        finished,
        startedAtMs: step.started_at === null ? null : Number(step.started_at),
        endedAtMs:
          finished && step.ended_at !== null ? Number(step.ended_at) : null,
      });
    }
  }

  const edges = database
    .prepare(
      "SELECT e.target_node_id AS target, s.state AS state, s.pending_id AS pending_id, " +
        "s.last_event_at AS last_event_at FROM edges e " +
        "JOIN agent_status s ON s.node_id = e.target_node_id " +
        "WHERE e.source_node_id = ? AND e.role = 'supervises' " +
        "AND s.state IS NOT NULL AND s.state <> ''",
    )
    .all(nodeId) as {
    target: string;
    state: string;
    pending_id: string | null;
    last_event_at: string | null;
  }[];
  for (const edge of edges) {
    const finished =
      edge.state === "done" &&
      (edge.pending_id === null || edge.pending_id === "");
    add({
      nodeId: edge.target,
      source: "edge",
      finished,
      startedAtMs: null,
      endedAtMs: finished ? timeOf(edge.last_event_at) : null,
    });
  }
  return [...found.values()];
}

/** 本节点的 `collect` 步骤：`running`，或步骤 `waiting`（验证升级成关卡）时 `escalated`。 */
export function collectStateOf(
  database: DatabaseSync,
  nodeId: string,
): "running" | "escalated" | null {
  const steps = liveCollects(database, nodeId);
  if (steps.some((step) => step.status === "waiting")) return "escalated";
  if (steps.some((step) => step.status === "running")) return "running";
  return null;
}

/**
 * 反查：哪些节点把这个节点当子节点——派发它的协调者、`supervises` 连线的源、
 * 同一运行里 `collect` 步骤的角色节点。不做画板与 Agent 过滤，调用方重算时会丢掉
 * 不是终端 Agent 的节点。
 */
export function parentsOf(database: DatabaseSync, nodeId: string): string[] {
  const parents = new Set<string>();
  const coordinators = database
    .prepare(
      "SELECT DISTINCT coordinator_node_id FROM workflow_task_runs WHERE node_id = ?",
    )
    .all(nodeId) as { coordinator_node_id: string }[];
  for (const row of coordinators) parents.add(row.coordinator_node_id);

  const sources = database
    .prepare(
      "SELECT source_node_id FROM edges WHERE target_node_id = ? AND role = 'supervises'",
    )
    .all(nodeId) as { source_node_id: string }[];
  for (const row of sources) parents.add(row.source_node_id);

  const runs = database
    .prepare(
      "SELECT DISTINCT s.run_id AS run_id FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id " +
        "WHERE s.node_id = ? AND r.status IN ('running', 'waiting')",
    )
    .all(nodeId) as { run_id: string }[];
  for (const run of runs) {
    const collects = database
      .prepare(
        "SELECT s.step_id AS step_id, s.node_id AS node_id, r.template_json AS template_json " +
          "FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id " +
          "WHERE s.run_id = ? AND s.kind = 'collect' AND s.node_id IS NOT NULL",
      )
      .all(run.run_id) as {
      step_id: string;
      node_id: string;
      template_json: string;
    }[];
    const mine = database
      .prepare(
        "SELECT step_id FROM workflow_run_steps WHERE run_id = ? AND node_id = ?",
      )
      .all(run.run_id, nodeId) as { step_id: string }[];
    for (const collect of collects) {
      const from = fromOf(collect.template_json, collect.step_id);
      if (mine.some((step) => from.includes(step.step_id)))
        parents.add(collect.node_id);
    }
  }
  parents.delete(nodeId);
  return [...parents];
}
