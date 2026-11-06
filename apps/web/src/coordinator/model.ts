import type {
  AgentStallKind,
  AgentState,
  CanvasEdge,
  CanvasNode,
  WorkItemStage,
} from "@armadra/shared";

import type { StatusTone } from "@/ui/status-pill";
import {
  INTAKE_PAGE_SIZE,
  type IntakeSource,
  type SaveSourceInput,
  type DispatchTask,
} from "./api";

/**
 * 分派抽屉的数据（设计系统 §5.4）：一个协调者、它分派出去的成员、汇总便签。
 *
 * 纯函数，输入是三份已有的数据——画布文档（节点与边）、`workflow_task_runs`
 * 的任务行（契约 §15.7）、Agent 状态（与 `AgentActivityNode` 同一份 hook
 * 流）——不另造状态。
 *
 *   * 成员 = 这个协调者的任务行（同一个节点只取最新一行）∪ 它经 `supervises`
 *     线驱动、但没有任务行的终端节点（`canvas_team` 建的）。节点已经不在画布
 *     上的任务不列。
 *   * 汇总 = 来源是这个协调者（输出到画板）或与它连着线的便签。
 */

export interface DispatchStatus {
  readonly tone: StatusTone;
  /** i18n 键。 */
  readonly label: string;
}

export interface DispatchMember {
  readonly nodeId: string;
  readonly title: string;
  readonly agentId: string;
  readonly status: DispatchStatus;
  /** 耗时（毫秒）；没有任务行时为 `null`。 */
  readonly elapsedMs: number | null;
  readonly taskId: string | null;
  readonly retryable: boolean;
  /** 由事实推出的阶段（契约 §90）；没有任务行时为 `null`。 */
  readonly stage: WorkItemStage | null;
  /** 进展看门狗的标记（契约 §91）；没有标记省略。 */
  readonly stalled?: AgentStallKind;
  /** 协调者说的最新一句话（契约 §101）；没有为 `null`。 */
  readonly reply: DispatchTask["reply"];
  /** 绑定的 PR（契约 §103）；没有为空数组。 */
  readonly pulls: DispatchTask["pulls"];
}

export interface DispatchSummary {
  readonly nodeId: string;
  readonly title: string;
}

export interface DispatchModel {
  readonly lead: {
    readonly nodeId: string;
    readonly title: string;
    readonly agentId: string;
    readonly status: DispatchStatus | null;
  } | null;
  readonly members: readonly DispatchMember[];
  readonly summaries: readonly DispatchSummary[];
}

export interface DispatchInput {
  readonly coordinatorId: string | null;
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  readonly tasks: readonly DispatchTask[];
  readonly states: Readonly<Record<string, AgentState | undefined>>;
  /** 看门狗的标记，按节点 id；没有的节点省略。 */
  readonly stalled?: Readonly<Record<string, AgentStallKind | undefined>>;
  readonly now: number;
}

const STATUS = {
  working: { tone: "working", label: "coordinator.status.working" },
  attention: { tone: "attention", label: "coordinator.status.attention" },
  done: { tone: "done", label: "coordinator.status.done" },
  failed: { tone: "failed", label: "coordinator.status.failed" },
  stopped: { tone: "paused", label: "coordinator.status.stopped" },
  idle: { tone: "idle", label: "coordinator.status.idle" },
} as const satisfies Record<string, DispatchStatus>;

/**
 * 阶段 → 状态（契约 §90.2）。`working` 与 `idle` 沿用原有的文案；`person/*` 与
 * 排队是账本新增的几种。
 */
export const STAGE_STATUS: Readonly<Record<WorkItemStage, DispatchStatus>> = {
  "person/delivery": { tone: "failed", label: "coordinator.stage.delivery" },
  "person/answer": { tone: "attention", label: "coordinator.stage.answer" },
  "person/review": { tone: "attention", label: "coordinator.stage.review" },
  "person/blocked": { tone: "attention", label: "coordinator.stage.blocked" },
  "person/failed": { tone: "failed", label: "coordinator.stage.failed" },
  "working/queued": { tone: "queued", label: "coordinator.stage.queued" },
  idle: STATUS.idle,
  working: STATUS.working,
  done: STATUS.done,
};

/** 要人处理的阶段排在前面。 */
export function isPersonStage(stage: WorkItemStage | null): boolean {
  return stage !== null && stage.startsWith("person/");
}

function agentOf(node: CanvasNode): string {
  return node.data.kind === "terminal" ? (node.data.agent?.id ?? "") : "";
}

/** 只看 Agent 状态：没有任务行的成员与协调者自己。 */
function liveStatus(state: AgentState | undefined): DispatchStatus {
  if (state === "working") return STATUS.working;
  if (state === "blocked" || state === "waiting") return STATUS.attention;
  return STATUS.idle;
}

/** 任务行为主，`running` 时再细分「需要你」。 */
function taskStatus(
  task: DispatchTask,
  state: AgentState | undefined,
): DispatchStatus {
  switch (task.status) {
    case "done":
      return STATUS.done;
    case "failed":
      return STATUS.failed;
    case "stopped":
      return STATUS.stopped;
    default:
      return state === "blocked" || state === "waiting"
        ? STATUS.attention
        : STATUS.working;
  }
}

/**
 * 一行任务的状态：要人处理的阶段永远优先；运行中的行再按阶段细分（排队、空
 * 闲），阶段是 `working` 或没有阶段时仍看 Agent 状态；已结束的行照任务行。
 */
function memberStatus(
  task: DispatchTask,
  state: AgentState | undefined,
): DispatchStatus {
  const stage = task.stage;
  if (stage !== null) {
    if (isPersonStage(stage)) return STAGE_STATUS[stage];
    if (task.status === "running" && stage !== "working") {
      return STAGE_STATUS[stage];
    }
  }
  return taskStatus(task, state);
}

function elapsed(task: DispatchTask, now: number): number | null {
  const start = Date.parse(task.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = task.endedAt === null ? now : Date.parse(task.endedAt);
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function stickyTitle(node: CanvasNode): string {
  if (node.title.trim() !== "") return node.title;
  const content = node.data.kind === "sticky" ? node.data.content : "";
  return (
    content
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

export function buildDispatch(input: DispatchInput): DispatchModel {
  const { coordinatorId, nodes, edges, tasks, states, now } = input;
  const marks = input.stalled ?? {};
  /** 只在还在做的行上画标记：结束的任务行不再说「停滞」。 */
  const markOf = (nodeId: string, status: DispatchStatus) => {
    const stalled = marks[nodeId];
    return stalled === undefined ||
      status.tone === "done" ||
      status.tone === "failed" ||
      status.tone === "paused"
      ? {}
      : { stalled };
  };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const leadNode = coordinatorId ? byId.get(coordinatorId) : undefined;
  if (!coordinatorId || !leadNode) {
    return { lead: null, members: [], summaries: [] };
  }

  const members: DispatchMember[] = [];
  const seen = new Set<string>();
  // 任务行按开始时刻从早到晚：抽屉里是分派的先后。
  const own = tasks
    .filter((task) => task.coordinatorNodeId === coordinatorId)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const latest: DispatchTask[] = [];
  for (const task of own) {
    if (seen.has(task.nodeId)) continue;
    seen.add(task.nodeId);
    latest.push(task);
  }
  latest.reverse();
  for (const task of latest) {
    const node = byId.get(task.nodeId);
    if (!node) continue;
    const status = memberStatus(task, states[node.id]);
    members.push({
      nodeId: node.id,
      title: node.title,
      agentId: agentOf(node) || task.runnerId,
      status,
      elapsedMs: elapsed(task, now),
      taskId: task.taskId,
      retryable: task.retryable && task.status !== "running",
      stage: task.stage,
      reply: task.reply,
      pulls: task.pulls,
      ...markOf(node.id, status),
    });
  }
  for (const edge of edges) {
    if (edge.source !== coordinatorId || edge.role !== "supervises") continue;
    if (seen.has(edge.target)) continue;
    const node = byId.get(edge.target);
    if (!node || node.type !== "terminal") continue;
    seen.add(node.id);
    const status = liveStatus(states[node.id]);
    members.push({
      nodeId: node.id,
      title: node.title,
      agentId: agentOf(node),
      status,
      elapsedMs: null,
      taskId: null,
      retryable: false,
      stage: null,
      reply: null,
      pulls: [],
      ...markOf(node.id, status),
    });
  }

  // 要人处理的排在前面；其余保持分派的先后（排序是稳定的）。
  members.sort(
    (a, b) => Number(isPersonStage(b.stage)) - Number(isPersonStage(a.stage)),
  );

  const linked = new Set<string>();
  for (const edge of edges) {
    if (edge.source === coordinatorId) linked.add(edge.target);
    if (edge.target === coordinatorId) linked.add(edge.source);
  }
  const summaries: DispatchSummary[] = nodes
    .filter(
      (node) =>
        node.data.kind === "sticky" &&
        (node.data.source?.nodeId === coordinatorId || linked.has(node.id)),
    )
    .map((node) => ({ nodeId: node.id, title: stickyTitle(node) }));

  return {
    lead: {
      nodeId: leadNode.id,
      title: leadNode.title,
      agentId: agentOf(leadNode),
      status: states[leadNode.id] ? liveStatus(states[leadNode.id]) : null,
    },
    members,
    summaries,
  };
}

/** 节点头部「N 成员」的 N：与抽屉同一条规则，不读任务行时只数主从线。 */
export function memberCount(
  coordinatorId: string,
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  tasks: readonly DispatchTask[] = [],
): number {
  return buildDispatch({
    coordinatorId,
    nodes,
    edges,
    tasks,
    states: {},
    now: 0,
  }).members.length;
}

/* ----------------------- 来源与候选（契约 §104.7） ----------------------- */

/** 规则文件对人确认过的那一份：已确认 / 已变更 / 还没确认 / 缺失。 */
export type RulesState = "confirmed" | "changed" | "unconfirmed" | "missing";

export function rulesState(
  source: Pick<IntakeSource, "rulesPresent" | "rulesHash" | "rulesCurrentHash">,
): RulesState {
  if (!source.rulesPresent) return "missing";
  if (source.rulesHash === "") return "unconfirmed";
  return source.rulesHash === source.rulesCurrentHash ? "confirmed" : "changed";
}

/** 允许名单输入框的文字 → 登录名列表：逗号、空白分隔，去掉 `@` 与重复。 */
export function parseAllow(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\s,\uff0c]+/)) {
    const login = part.replace(/^@/, "").trim();
    if (login !== "") seen.add(login);
  }
  return [...seen];
}

/** 一个来源改一两项之后的保存入参（其余照旧）。 */
export function sourceInput(
  source: IntakeSource,
  patch: Partial<Omit<SaveSourceInput, "id" | "coordinatorNodeId">> = {},
): SaveSourceInput {
  return {
    id: source.id,
    coordinatorNodeId: source.coordinatorNodeId,
    repo: source.repo,
    kinds: source.kinds,
    mode: source.mode,
    allow: source.allow,
    enabled: source.enabled,
    ...patch,
  };
}

export interface CoordinatorOption {
  readonly nodeId: string;
  readonly title: string;
}

/** 这块画板上的协调者（ama 终端节点）。 */
export function coordinatorsOf(
  nodes: readonly CanvasNode[],
): CoordinatorOption[] {
  return nodes
    .filter(
      (node) => node.data.kind === "terminal" && node.data.agent?.id === "ama",
    )
    .map((node) => ({ nodeId: node.id, title: node.title }));
}

/** 候选的结果列：派发了、被拒了（带原因码）或还没有。 */
export function outcomeOf(
  outcome: string | null,
):
  | { readonly kind: "dispatched" }
  | { readonly kind: "refused"; readonly code: string }
  | null {
  if (outcome === "dispatched") return { kind: "dispatched" };
  if (outcome !== null && outcome.startsWith("refused:")) {
    return { kind: "refused", code: outcome.slice("refused:".length) };
  }
  return null;
}

/** 候选总数 → 页数（至少一页）。 */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / INTAKE_PAGE_SIZE));
}

/** 工作项（任务）→ 成员节点，用来从「已派发」定位到画布上的节点。 */
export function nodeOfItem(
  tasks: readonly DispatchTask[],
  itemId: string | null,
): string | undefined {
  if (itemId === null) return undefined;
  return tasks.find((task) => task.taskId === itemId)?.nodeId;
}
