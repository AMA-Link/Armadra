import type { DatabaseSync } from "node:sqlite";
import type { TaskRun } from "../workflow/task-runs";
import { loadNode } from "./nodes";
import { uuidV7 } from "../workspaces/support";
import {
  isCoordinator,
  nodeName,
  oneLine,
  recordRouterEvent,
  shortHash,
  versionOf,
} from "./router-events";
import { enqueue } from "./send-queue";
import { type CollabContext, nowSeconds } from "./service";

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
  /** 自己开的 PR 合并 / 关闭而结束时的原因（§103.4）；其余缺省。 */
  prResult?: "merged" | "closed",
): boolean {
  const who = nodeName(context.database, run.nodeId);
  return recordRouterEvent(context, {
    id: `task-done:${run.taskId}:${status}`,
    coordinatorNodeId: run.coordinatorNodeId,
    kind: "task-done",
    itemId: run.taskId,
    sourceNodeId: run.nodeId,
    summary:
      prResult === undefined
        ? `${who}的任务${status === "done" ? "已结束" : "失败了"}`
        : `${who}的任务已结束：它开的 PR ${prResult === "merged" ? "已合并" : "已关闭"}`,
  });
}

/**
 * 启动扫描发现一个工作项中断了（契约 §101.5）：进行中、成员没有活着的会话、也
 * 不在排队。id 带中断的时刻（成员最近一个会话的结束时刻），同一次中断只写一次；
 * 成员续接后再中断是新的时刻，写新的一条。**不自动重跑任何东西**。
 */
export function recordInterrupted(
  context: CollabContext,
  run: TaskRun,
  atMs: number,
): boolean {
  const who = nodeName(context.database, run.nodeId);
  return recordRouterEvent(context, {
    id: `interrupted:${run.taskId}:${versionOf(atMs)}`,
    coordinatorNodeId: run.coordinatorNodeId,
    kind: "interrupted",
    itemId: run.taskId,
    sourceNodeId: run.nodeId,
    summary: `${who}的工作中断了（重启或会话退出），没有自动重跑；请决定是等它续接、换人处理，还是上报给人。`,
  });
}

/** 成员续接后的固定恢复提示（契约 §101.5）。 */
export function recoveryHint(itemId: string): string {
  return (
    `你的工作项 \`${itemId}\` 上次中断时还在进行。先检查 worktree、git 历史和外部状态` +
    "（分支、PR、评论），再决定是否重复外部动作；然后用 `canvas report` 说明现状。"
  );
}

/**
 * 把恢复提示投给续接回来的成员：走投递队列和整条门链（`origin = mailbox-wake`，
 * 署名是应用，不替人回答任何提示）。key 带工作项，重复投同一个 key 什么也不做。
 * 答有没有（或早已）排进队列。
 */
export function deliverRecoveryHint(
  context: CollabContext,
  run: TaskRun,
): boolean {
  const database = context.database;
  const member = loadNode(database, run.nodeId);
  const coordinator = loadNode(database, run.coordinatorNodeId);
  if (
    member === undefined ||
    coordinator === undefined ||
    member.nodeType !== "terminal"
  ) {
    return false;
  }
  const inserted = enqueue(database, {
    id: uuidV7(),
    workspaceId: member.workspaceId,
    sourceNodeId: coordinator.id,
    targetNodeId: member.id,
    origin: "mailbox-wake",
    messageKey:
      `recovery:${run.taskId}:${versionOf(nowSeconds(context) * 1000)}`
        .replace(/[^A-Za-z0-9._:-]/g, "_")
        .slice(0, 128),
    body: recoveryHint(run.taskId),
    hops: 0,
    trail: [],
    now: nowSeconds(context),
    state: "queued",
  });
  if (inserted.kind === "inserted") context.nudge?.(member.id);
  return inserted.kind === "inserted" || inserted.kind === "duplicate";
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
