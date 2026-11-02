import type { DatabaseSync } from "node:sqlite";
import { plainCommentText } from "../realtime/comment-text";
import { getComment } from "../realtime/comments-store";
import { type TaskRun, taskRun } from "../workflow/task-runs";
import { uuidV7 } from "../workspaces/support";
import { loadNode } from "./nodes";
import {
  FOLLOWUP_FAILED_PREFIX,
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
 *     与整条门链，不替人回答任何提示）。协调者的卡片里只多一行「已排队转给 X」，
 *     不带原话；它只能决定停掉这一项，不能再派一份。入队不等于转到：排队项后来
 *     被门链拒绝（连线删了）或过期了，{@link reportFailedFollowups} 补一行「没能
 *     转给 X」，由协调者决定换人。
 *   * 一段话点名了几个工作项时，每个成员只收到点名它的那几句（没点名的句子跟着
 *     前一个点名的句子走），给 B 的话 A 收不到。
 *   * 画布评论只认**进行中**的工作项、顶层评论；已结束成员上的备注与回复不转。
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
      ? `已排队转给${who}`
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
  const runs = referencedItems(context.database, coordinatorNodeId, prompt);
  const words =
    runs.length > 1
      ? partsByItem(context.database, coordinatorNodeId, prompt)
      : undefined;
  let forwarded = 0;
  for (const run of runs) {
    const text = words?.get(run.taskId) ?? prompt;
    if (routeFollowup(context, run, text, version)) forwarded += 1;
  }
  return forwarded;
}

/** 一段话切成句子：换行、中文句末、英文 `! ? ;` 后的空白。 */
function sentences(prompt: string): string[] {
  return prompt
    .split(/\n+|(?<=[。！？；])|(?<=[!?;])\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * 点名了好几个工作项时，每个工作项该收到的原话：点名它的句子，加上紧跟其后、没
 * 点名任何工作项的句子（那是接着说的）。开头就没点名的句子谁也不跟，分给每一项。
 */
export function partsByItem(
  database: DatabaseSync,
  coordinatorNodeId: string,
  prompt: string,
): Map<string, string> {
  const parts = new Map<string, string[]>();
  const orphans: string[] = [];
  let owners: string[] = [];
  for (const sentence of sentences(prompt)) {
    const named = referencedItems(database, coordinatorNodeId, sentence).map(
      (run) => run.taskId,
    );
    if (named.length > 0) owners = named;
    if (named.length === 0 && owners.length === 0) {
      orphans.push(sentence);
      continue;
    }
    for (const id of owners) {
      const list = parts.get(id) ?? [];
      list.push(sentence);
      parts.set(id, list);
    }
  }
  const out = new Map<string, string>();
  for (const [id, list] of parts) out.set(id, [...orphans, ...list].join("\n"));
  return out;
}

/**
 * 人在画布上评论了一个节点：它是某个协调者派出的、**进行中**的工作项的成员时，
 * 顶层评论的正文就是对这个工作项的跟进。同一节点有几个进行中的取最近的一个；
 * 没有进行中的（早已结束的成员）、或评论是讨论串里的回复，什么也不转。
 */
export function followupFromComment(
  context: CollabContext,
  boardId: string,
  commentId: string,
  nodeId: string,
): boolean {
  const row = context.database
    .prepare(
      "SELECT task_id FROM workflow_task_runs WHERE node_id = ? AND status = 'running' " +
        "ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(nodeId) as { task_id?: string } | undefined;
  if (row?.task_id === undefined) return false;
  const run = taskRun(context.database, row.task_id);
  if (run === undefined) return false;
  let body: string;
  try {
    const comment = getComment(context.database, boardId, commentId);
    // 讨论串里的回复是人跟人说话，不是对工作项的跟进。
    if (comment.parentId !== null) return false;
    body = plainCommentText(comment.body);
  } catch {
    return false;
  }
  return routeFollowup(context, run, body, `c${commentId}`);
}

/** 一行没投成的「原话转成员」排队项。 */
interface FailedRow {
  readonly id: string;
  readonly source_node_id: string;
  readonly target_node_id: string;
  readonly body: string;
  readonly state: string;
  readonly last_reason: string | null;
}

const FOLLOWUP_HEAD = /^\[人对工作项 (.+?) 的跟进，原话\]/;

/**
 * 排队转给成员的原话没投成（出队时连线已删、能力位关了、节点没了，或排满五分钟
 * 的期限过了）：给协调者补一行「没能转给 X」。入队时只能说「已排队」，投递结果
 * 是之后才知道的，没有这一行协调者会以为人的话已经到了。
 *
 * 事件 id 由排队项 id 定，重复扫描只写一次。`coordinatorNodeId` 缺省扫全部。
 * 答新写了几行。
 */
export function reportFailedFollowups(
  context: CollabContext,
  coordinatorNodeId?: string,
): number {
  const database = context.database;
  const rows = database
    .prepare(
      "SELECT id, source_node_id, target_node_id, body, state, last_reason FROM agent_send_queue " +
        "WHERE source_kind = 'node' AND origin = 'mailbox-wake' AND substr(message_key, 1, 9) = 'followup:' " +
        "AND state IN ('cancelled','expired') AND settled_by <> 'source' " +
        (coordinatorNodeId === undefined ? "" : "AND source_node_id = ? ") +
        "ORDER BY created_at, id",
    )
    .all(
      ...(coordinatorNodeId === undefined ? [] : [coordinatorNodeId]),
    ) as unknown as FailedRow[];
  let written = 0;
  for (const row of rows) {
    const taskId = FOLLOWUP_HEAD.exec(row.body)?.[1];
    if (taskId === undefined) continue;
    const reason =
      row.state === "expired"
        ? "排了五分钟没投进去"
        : row.last_reason === null
          ? "投递被拒绝"
          : `投递被拒绝：${row.last_reason}`;
    const recorded = recordRouterEvent(context, {
      id: `${FOLLOWUP_FAILED_PREFIX}${row.id}`,
      coordinatorNodeId: row.source_node_id,
      kind: "followup",
      itemId: taskId,
      sourceNodeId: row.target_node_id,
      summary: `没能转给${nodeName(database, row.target_node_id)}（${reason}），请决定是否换人处理`,
    });
    if (recorded) written += 1;
  }
  return written;
}
