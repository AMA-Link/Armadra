import type { DatabaseSync } from "node:sqlite";
import type { TaskRun } from "../workflow/task-runs";
import { loadNode } from "./nodes";
import {
  isCoordinator,
  nodeName,
  oneLine,
  recordRouterEvent,
  shortHash,
} from "./router-events";
import type { CollabContext } from "./service";

/**
 * 往统一事件队列写事件的几个来源（契约 §93.1）：看门狗的判定、任务结束、别的
 * 节点留给协调者的话。报告与交回在 `control/items.ts`，人的追问在
 * `router-followup.ts`。每一个都只写 `router_events`，投递是 `router-cards.ts`
 * 的事。正文只有节点名、工作项 id、种类和成员自己写的那一行，不带终端原文。
 */

/** 看门狗的一次判定（契约 §91）。 */
export interface StallEvent {
  readonly coordinatorNodeId: string;
  readonly memberNodeId: string;
  readonly taskId: string;
  readonly reason: "stalled" | "idleWaiting" | "needsHuman";
  /** 已经多久（分钟，向下取整）。 */
  readonly minutes: number;
  /** 判定的状态指纹：同一个判定只写一次。 */
  readonly basis: string;
}

/** 看门狗：`stalled` 事件。id 带判定与状态指纹，同一个判定幂等。 */
export function recordStalled(
  context: CollabContext,
  stall: StallEvent,
): boolean {
  const who = nodeName(context.database, stall.memberNodeId);
  const head =
    stall.reason === "stalled"
      ? `${who}已 ${stall.minutes} 分钟没有进展`
      : stall.reason === "idleWaiting"
        ? `${who}已空闲 ${stall.minutes} 分钟，任务还没有结论`
        : `${who}已等人处理 ${stall.minutes} 分钟`;
  const tail =
    stall.reason === "needsHuman"
      ? "请上报给人，不要替人回答。"
      : "请决定是重试、追问，还是上报给人。";
  return recordRouterEvent(context, {
    id: `stalled:${stall.taskId}:${stall.reason}:${shortHash(stall.basis)}`,
    coordinatorNodeId: stall.coordinatorNodeId,
    kind: "stalled",
    itemId: stall.taskId,
    sourceNodeId: stall.memberNodeId,
    summary: `${head}。${tail}`,
  });
}

/**
 * 任务结束且没有人在 `wait`（core 自己盯着落的结束，契约 §15.7）：`task-done`。
 * `team` 成员也算。结果正文不进事件，只写成败；要看用 `items` 与 `wait` 的结果。
 */
export function recordTaskDone(
  context: CollabContext,
  run: TaskRun,
  status: "done" | "failed",
): boolean {
  const who = nodeName(context.database, run.nodeId);
  return recordRouterEvent(context, {
    id: `task-done:${run.taskId}:${status}`,
    coordinatorNodeId: run.coordinatorNodeId,
    kind: "task-done",
    itemId: run.taskId,
    sourceNodeId: run.nodeId,
    summary: `${who}的任务${status === "done" ? "已结束" : "失败了"}`,
  });
}

/** 这几种 key 的留言有自己的路，不再当普通留言报一遍。 */
const OWN_PATH_KEYS = ["task:", "handoff:"];

/**
 * 别的节点 `post` 给协调者的普通消息：`inbox`。收件箱里那条消息照旧在，事件 id
 * 带上它的 id，协调者 `canvas ack --id` 确认那条消息时事件一并确认
 * （`router-events.ts::ackInboxEvent`）。只有收件人是协调者（派过工作项）才写。
 */
export function noteInboxPost(
  context: CollabContext,
  input: {
    readonly messageId: string;
    readonly key: string;
    readonly body: string;
    readonly sourceNodeId: string;
    readonly targetNodeId: string;
  },
): boolean {
  if (OWN_PATH_KEYS.some((prefix) => input.key.startsWith(prefix)))
    return false;
  if (!isCoordinator(context.database, input.targetNodeId)) return false;
  const source = loadNode(context.database, input.sourceNodeId);
  if (source === undefined) return false;
  return recordRouterEvent(context, {
    id: `inbox:${input.messageId}`,
    coordinatorNodeId: input.targetNodeId,
    kind: "inbox",
    itemId: latestItemOf(
      context.database,
      input.targetNodeId,
      input.sourceNodeId,
    ),
    sourceNodeId: input.sourceNodeId,
    summary: `${nodeName(context.database, input.sourceNodeId)}留言：${oneLine(
      input.body.split("\n", 1)[0] ?? "",
      100,
    )}`,
  });
}

/** 协调者派给这个成员的最近一个工作项。 */
function latestItemOf(
  database: DatabaseSync,
  coordinatorNodeId: string,
  memberNodeId: string,
): string | null {
  const row = database
    .prepare(
      "SELECT task_id FROM workflow_task_runs WHERE coordinator_node_id = ? AND node_id = ? " +
        "ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(coordinatorNodeId, memberNodeId) as { task_id?: string } | undefined;
  return row?.task_id ?? null;
}
