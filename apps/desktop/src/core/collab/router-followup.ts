import type { DatabaseSync } from "node:sqlite";
import { plainCommentText } from "../realtime/comment-text";
import { getComment } from "../realtime/comments-store";
import { type TaskRun, taskRun } from "../workflow/task-runs";
import { uuidV7 } from "../workspaces/support";
import { loadNode } from "./nodes";
import {
  nodeName,
  oneLine,
  recordRouterEvent,
  versionOf,
} from "./router-events";
import { enqueue } from "./send-queue";
import { type CollabContext, nowDate, nowSeconds } from "./service";

/**
 * 跟进归属（契约 §93.4，#696）。
 *
 *   * 人在**成员节点**里说的话本来就归那个成员，不经过这里。
 *   * 人对**协调者**说的话里点名了工作项（`#<id>`），或在画布上评论了那个成员
 *     节点：core 记一条 `followup` 事件，并把原话**直接投给那个成员**（走投递队列
 *     与整条门链，不替人回答任何提示）。协调者的卡片里只多一行「已转给 X」，不带
 *     原话；它只能决定停掉这一项，不能再派一份。
 *   * 没有点名的就是新请求，什么也不做：由协调者决定接新项还是挂到已有项。
 *     点名只认协调者自己名下确实存在的工作项 id，话题相近不算。
 */

/** 一段话里最多认这么多个点名。 */
const MAX_REFS = 5;
/** 转给成员的原话最多这么多字。 */
const MAX_FORWARD_CHARS = 4_000;
/** core 自己投的信封（卡片、唤醒、别的节点的 `send`）不是人说的话。 */
const ENVELOPE_START = "--- ARMADRA MESSAGE";

/** `#` 后面的 id：前面不能是字母数字（不认 `abc#1`）。 */
const REFERENCE = /(?<![A-Za-z0-9])#([A-Za-z0-9][A-Za-z0-9._:-]{0,99})/g;

/** 点名的工作项 id 末尾常跟着句读，从长到短逐个试。 */
function resolveRef(
  database: DatabaseSync,
  coordinatorNodeId: string,
  token: string,
): TaskRun | undefined {
  let candidate = token;
  while (candidate !== "") {
    const run = taskRun(database, candidate);
    if (run !== undefined && run.coordinatorNodeId === coordinatorNodeId) {
      return run;
    }
    if (!/[._:-]$/.test(candidate)) return undefined;
    candidate = candidate.slice(0, -1);
  }
  return undefined;
}

/** 人对协调者说的话里点名的、协调者名下的工作项（去重，按出现顺序）。 */
export function referencedItems(
  database: DatabaseSync,
  coordinatorNodeId: string,
  prompt: string,
): TaskRun[] {
  const found = new Map<string, TaskRun>();
  for (const match of prompt.matchAll(REFERENCE)) {
    const token = match[1];
    if (token === undefined) continue;
    const run = resolveRef(database, coordinatorNodeId, token);
    if (run !== undefined) found.set(run.taskId, run);
    if (found.size >= MAX_REFS) break;
  }
  return [...found.values()];
}

/** 记一条 `followup` 事件，并把原话投给成员。答有没有转出去。 */
export function routeFollowup(
  context: CollabContext,
  run: TaskRun,
  text: string,
  version: string,
): boolean {
  const database = context.database;
  const member = loadNode(database, run.nodeId);
  const coordinator = loadNode(database, run.coordinatorNodeId);
  const words = oneLine(text, MAX_FORWARD_CHARS);
  let forwarded = false;
  if (
    member !== undefined &&
    coordinator !== undefined &&
    member.nodeType === "terminal" &&
    words !== ""
  ) {
    const key = `followup:${run.taskId}:${version}`
      .replace(/[^A-Za-z0-9._:-]/g, "_")
      .slice(0, 128);
    const inserted = enqueue(database, {
      id: uuidV7(),
      workspaceId: member.workspaceId,
      sourceNodeId: coordinator.id,
      targetNodeId: member.id,
      // 署名是应用：人的话经 core 原样转给成员，不冒充协调者说话。
      origin: "mailbox-wake",
      messageKey: key,
      body:
        `[人对工作项 ${run.taskId} 的跟进，原话]\n${words}\n` +
        `处理完用 \`canvas report --item ${run.taskId}\` 回报；这件事不归你，用 \`canvas handback --item ${run.taskId} --reason …\` 交回。`,
      hops: 0,
      trail: [],
      now: nowSeconds(context),
      state: "queued",
    });
    forwarded = inserted.kind === "inserted" || inserted.kind === "duplicate";
    if (inserted.kind === "inserted") context.nudge?.(member.id);
  }
  const who = nodeName(database, run.nodeId);
  recordRouterEvent(context, {
    id: `followup:${run.taskId}:${version}`,
    coordinatorNodeId: run.coordinatorNodeId,
    kind: "followup",
    itemId: run.taskId,
    sourceNodeId: run.nodeId,
    summary: forwarded
      ? `已转给${who}`
      : `没能转给${who}（节点不在或投递队列满了），请决定是否换人处理`,
  });
  return forwarded;
}

/**
 * 协调者的一轮开始了，提示词是 `prompt`：人点名了工作项就转给成员。core 自己投
 * 的信封不算人说的话。答转出去了几项。
 */
export function followupsFromPrompt(
  context: CollabContext,
  coordinatorNodeId: string,
  prompt: string,
): number {
  if (prompt.trimStart().startsWith(ENVELOPE_START)) return 0;
  if (!prompt.includes("#")) return 0;
  const version = versionOf(nowDate(context).getTime());
  let forwarded = 0;
  for (const run of referencedItems(
    context.database,
    coordinatorNodeId,
    prompt,
  )) {
    if (routeFollowup(context, run, prompt, version)) forwarded += 1;
  }
  return forwarded;
}

/**
 * 人在画布上评论了一个节点：它是某个协调者派出的工作项的成员时，评论正文就是
 * 对这个工作项的跟进。同一节点有几个工作项时认进行中的、最近的一个。
 */
export function followupFromComment(
  context: CollabContext,
  boardId: string,
  commentId: string,
  nodeId: string,
): boolean {
  const row = context.database
    .prepare(
      "SELECT task_id FROM workflow_task_runs WHERE node_id = ? " +
        "ORDER BY (status = 'running') DESC, started_at DESC, rowid DESC LIMIT 1",
    )
    .get(nodeId) as { task_id?: string } | undefined;
  if (row?.task_id === undefined) return false;
  const run = taskRun(context.database, row.task_id);
  if (run === undefined) return false;
  let body: string;
  try {
    body = plainCommentText(
      getComment(context.database, boardId, commentId).body,
    );
  } catch {
    return false;
  }
  return routeFollowup(context, run, body, `c${commentId}`);
}
