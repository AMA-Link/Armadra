import { CHILD_DONE_MODES, type ChildDone } from "@armadra/shared";
import { getContextLinks } from "../canvas/context-links";
import { getAgentStatus } from "../agent/status";
import { uuidV7 } from "../workspaces/support";
import { nodeSummary } from "./context-link";
import { type NodeRef, loadNode } from "./nodes";
import { enqueue } from "./send-queue";
import { type CollabContext, nowSeconds } from "./service";

/**
 * 子会话完成回流（Armadra#1062 S6）：一个有上级的会话（主从连线的从那一侧）
 * 做完一轮，往上级的投递队列塞一条 `origin: "child-done"`。
 *
 * 与收件箱唤醒（`wake.ts`）同一个形状：同一条队列、同一条门链、同一份容量与
 * 限速，不开快车道；上级在忙就排着，空下来才投。不同的只有两处：
 *
 *   1. 这一条是**应用**替下级说的一句「我做完了」，署名是应用
 *      （{@link CHILD_DONE_SENDER}），所以「下级不能把文字打进上级终端」那条
 *      规矩对它不适用（`send.ts::authorize` 的 `allowUpward`）；连线授权照查。
 *   2. 来源链为空、跳数从零数起（与唤醒相同）：它是通知不是转来的指令；接上
 *      下级的链的话，上级回头再给下级派活就会被当成环（`LOOP_DETECTED`）。
 *
 * 档位在**上级**的节点设置 `data.agent.childDone`：`off` / `notify`（缺省，一句
 * 提示加怎么读）/ `deliver`（下级的摘要，读不到就退回提示）。
 *
 * 同一个下级的同一轮只回流一次：幂等键里带着下级状态的 `updatedAt`。上级是这个
 * 下级的协调者、正经 `wait` / 工作项账本跟着它时不回流——那边已经有一条路。
 */

export { CHILD_DONE_MODES };
export type { ChildDone };

export const DEFAULT_CHILD_DONE: ChildDone = "notify";

/** 回流消息信封上的署名。 */
export const CHILD_DONE_SENDER = "Armadra 下级回流";

/** `deliver` 档正文的上限（字节以字符近似，与摘要同一个量级）。 */
const MAX_DELIVER_CHARS = 2_000;

/** `data.agent.childDone`，读不出来就是默认档。 */
export function childDoneOf(data: unknown): ChildDone {
  if (data === null || typeof data !== "object") return DEFAULT_CHILD_DONE;
  const agent = (data as Record<string, unknown>).agent;
  if (agent === null || typeof agent !== "object") return DEFAULT_CHILD_DONE;
  const wanted = (agent as Record<string, unknown>).childDone;
  return (CHILD_DONE_MODES as readonly string[]).includes(wanted as string)
    ? (wanted as ChildDone)
    : DEFAULT_CHILD_DONE;
}

export interface ChildDoneOutcome {
  readonly queued: readonly string[];
  readonly skipped: readonly { mainId: string; reason: string }[];
}

/** 上级是这个下级在跑的任务的协调者：它有 `wait` 与账本，不需要再回流一次。 */
function coordinatedBy(
  context: CollabContext,
  childId: string,
  mainId: string,
): boolean {
  const row = context.database
    .prepare(
      "SELECT 1 FROM workflow_task_runs WHERE node_id = ? AND coordinator_node_id = ? AND status = 'running'",
    )
    .get(childId, mainId);
  return row !== undefined;
}

function displayName(child: NodeRef): string {
  return child.title === "" ? child.id : child.title;
}

function notifyBody(child: NodeRef): string {
  return (
    `下级「${displayName(child)}」做完了一轮。` +
    `用 \`armadra-hook context summary --node ${child.id}\` 看结果，` +
    "要原文用 `context transcript`。"
  );
}

function deliverBody(context: CollabContext, child: NodeRef): string {
  let summary: string;
  try {
    summary = nodeSummary(context, child);
  } catch {
    return notifyBody(child);
  }
  const clipped =
    summary.length > MAX_DELIVER_CHARS
      ? `${summary.slice(0, MAX_DELIVER_CHARS)}…`
      : summary;
  return `下级「${displayName(child)}」做完了一轮，摘要：\n${clipped}`;
}

/**
 * 这个节点刚报了一个状态；是「做完了」并且它有上级的话，往每个上级的队列里
 * 塞一条回流。
 */
export function noteChildDone(
  context: CollabContext,
  childId: string,
  state: string | undefined,
): ChildDoneOutcome {
  const queued: string[] = [];
  const skipped: { mainId: string; reason: string }[] = [];
  if (state !== "done") return { queued, skipped };
  const child = loadNode(context.database, childId);
  if (child === undefined || child.nodeType !== "terminal") {
    return { queued, skipped };
  }
  const mains = getContextLinks(context.database, childId).links.filter(
    (link) => link.role === "main",
  );
  if (mains.length === 0) return { queued, skipped };
  const turn = getAgentStatus(context.database, childId)?.updatedAt ?? "";
  const now = nowSeconds(context);
  for (const link of mains) {
    const main = loadNode(context.database, link.id);
    if (main === undefined || main.nodeType !== "terminal") {
      skipped.push({ mainId: link.id, reason: "gone" });
      continue;
    }
    const mode = childDoneOf(main.data);
    if (mode === "off") {
      skipped.push({ mainId: main.id, reason: "off" });
      continue;
    }
    if (coordinatedBy(context, childId, main.id)) {
      skipped.push({ mainId: main.id, reason: "coordinated" });
      continue;
    }
    const inserted = enqueue(context.database, {
      id: uuidV7(),
      workspaceId: main.workspaceId,
      sourceNodeId: childId,
      targetNodeId: main.id,
      origin: "child-done",
      messageKey: `child-done:${childId}:${turn}`,
      body:
        mode === "deliver" ? deliverBody(context, child) : notifyBody(child),
      // 与收件箱唤醒一样不接在任何来源链后面：它是应用的一句通知，不是转过来
      // 的指令。接上下级的链的话，上级回头再给下级派活会被当成环拒掉。
      hops: 0,
      trail: [],
      now,
      state: "queued",
    });
    if (inserted.kind === "full") {
      skipped.push({ mainId: main.id, reason: "queue-full" });
      continue;
    }
    queued.push(main.id);
  }
  return { queued, skipped };
}
