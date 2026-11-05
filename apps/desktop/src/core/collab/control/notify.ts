import type { DatabaseSync } from "node:sqlite";
import { type TaskRun, taskRun } from "../../workflow/task-runs";
import { stageOf } from "../../workflow/work-items";
import type { Caller } from "../nodes";
import { Args, Refused, stripControl } from "../refusals";
import { versionOf } from "../router-events";
import {
  REPLY_PURPOSES,
  type ReplyPurpose,
  insertReply,
  replyExists,
} from "../router-replies";
import { type CollabContext, nowDate, nowSeconds } from "../service";
import { type Outcome, result } from "./outcome";

/**
 * `canvas notify`（契约 §101.1，#704）：协调者对人说话的唯一出口，带闸门。
 *
 * 三种用途，各有前置条件，由 core 检查，不满足回 `409 notify_precondition` 并写明
 * 缺什么：
 *
 *   * `result`：这一项的阶段是 `person/review`；
 *   * `attention`：`--text` 原样包含这一项当前的待决问题；
 *   * `answer`：`--followup <事件 id>` 是这一项名下一条还没被回答的 `followup`。
 *
 * 没有 `progress` 这个用途：进度一律拒绝。同一个目标只能发一次（`router_replies`
 * 的 id 由用途和目标确定，重复回 `409 already_notified`）。只有协调者本人能对它
 * 派出的工作项用，别人和不存在的同答 `404 item_not_found`。
 */

/** 一般用途的 `--text` 上限。 */
export const MAX_REPLY_CHARS = 100;
/** `attention` 要原样带上待决问题，上限放宽到问题自己的上限。 */
export const MAX_ATTENTION_REPLY_CHARS = 300;

function bad(message: string): Refused {
  return new Refused(400, "bad_request", message);
}

function precondition(message: string): Refused {
  return new Refused(409, "notify_precondition", message);
}

/** 去控制字符、折叠空白：待决问题与 `--text` 都按这个口径比较。 */
function flat(text: string): string {
  return stripControl(text).replace(/\s+/g, " ").trim();
}

function ownedItem(
  database: DatabaseSync,
  caller: Caller,
  id: string,
): TaskRun {
  const run = taskRun(database, id);
  // 别人的与不存在的同答：不泄露它在不在。
  if (run === undefined || run.coordinatorNodeId !== caller.node.id) {
    throw new Refused(
      404,
      "item_not_found",
      `你派出的工作项里没有 \`${id}\`。`,
    );
  }
  return run;
}

function purposeOf(args: Args): ReplyPurpose {
  const purpose = args.text("purpose");
  if (purpose === undefined) {
    throw bad(`--purpose 不能缺，是 ${REPLY_PURPOSES.join(" / ")} 之一。`);
  }
  if ((REPLY_PURPOSES as readonly string[]).includes(purpose)) {
    return purpose as ReplyPurpose;
  }
  if (purpose === "progress") {
    throw new Refused(
      409,
      "notify_precondition",
      "没有 progress 这个用途：进度不对人说，人想看就读画布上的工作项。",
    );
  }
  throw bad(`--purpose 是 ${REPLY_PURPOSES.join(" / ")} 之一。`);
}

/** 这一刻按用途能发的回复的 id；前置条件不满足就拒绝。 */
function replyId(
  database: DatabaseSync,
  caller: Caller,
  purpose: ReplyPurpose,
  run: TaskRun,
  text: string,
  followup: string | undefined,
  stage: string,
): string {
  switch (purpose) {
    case "result": {
      if (stage !== "person/review" || run.report === null) {
        throw precondition(
          `工作项 ${run.taskId} 的阶段是 ${stage}，不是 person/review：成员报 ready 之后才能告诉人验收。`,
        );
      }
      return `result:${run.taskId}:${versionOf(Date.parse(run.report.at) || 0)}`;
    }
    case "attention": {
      if (run.attention === null) {
        throw precondition(
          `工作项 ${run.taskId} 没有待决问题：成员用 report --human-action 提出之后才能转达。`,
        );
      }
      if (!text.includes(flat(run.attention.question))) {
        throw precondition(
          `--text 要原样包含当前的待决问题：${flat(run.attention.question)}`,
        );
      }
      return `attention:${run.taskId}:${versionOf(Date.parse(run.attention.raisedAt) || 0)}`;
    }
    case "answer": {
      if (followup === undefined) {
        throw precondition("answer 要带 --followup <事件 id>。");
      }
      const event = database
        .prepare(
          "SELECT item_id FROM router_events WHERE id = ? AND coordinator_node_id = ? AND kind = 'followup'",
        )
        .get(followup, caller.node.id) as { item_id?: unknown } | undefined;
      if (
        event === undefined ||
        event.item_id !== run.taskId ||
        !followup.startsWith("followup:")
      ) {
        throw precondition(
          `\`${followup}\` 不是工作项 ${run.taskId} 名下的追问事件。`,
        );
      }
      return `answer:${followup}`;
    }
  }
}

/** `canvas notify` */
export function notify(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const database = context.database;
  const purpose = purposeOf(args);
  const itemId = args.text("item");
  if (itemId === undefined) throw bad("--item 不能缺。");
  const raw = args.text("text");
  if (raw === undefined) throw bad("--text 不能缺。");
  const text = flat(raw);
  if (text === "") throw bad("--text 不能缺。");
  const max =
    purpose === "attention" ? MAX_ATTENTION_REPLY_CHARS : MAX_REPLY_CHARS;
  if ([...text].length > max) throw bad(`--text 不超过 ${max} 个字符。`);
  const followup = args.text("followup");
  if (args.value("followup") === true) {
    throw bad("--followup 要带一个事件 id。");
  }

  const run = ownedItem(database, caller, itemId);
  const stage = stageOf(database, run, nowSeconds(context));
  const id = replyId(database, caller, purpose, run, text, followup, stage);
  if (replyExists(database, id)) {
    throw new Refused(
      409,
      "already_notified",
      `这件事已经对人说过了（${id}）；等阶段再变化、有新的问题或新的追问再发。`,
    );
  }
  insertReply(database, {
    id,
    coordinatorNodeId: caller.node.id,
    itemId: run.taskId,
    purpose,
    stage,
    text,
    createdAt: nowDate(context).getTime(),
  });
  publishReply(context, run, purpose, id);
  return result(`已把「${text}」告诉人（${purpose}，工作项 ${run.taskId}）。`, {
    item: run.taskId,
    purpose,
    id,
    stage,
  });
}

/**
 * 推一帧 `workflow.reply`：页面据此重读任务行，推送规则据此对 `result` /
 * `attention` 叫人。帧里**不带 `--text`**（推送从不读消息文本）。
 */
function publishReply(
  context: CollabContext,
  run: TaskRun,
  purpose: ReplyPurpose,
  replyId: string,
): void {
  if (context.publish === undefined) return;
  const place = context.database
    .prepare(
      "SELECT n.board_id AS board_id, b.workspace_id AS workspace_id " +
        "FROM nodes n JOIN boards b ON b.id = n.board_id WHERE n.id = ?",
    )
    .get(run.coordinatorNodeId) as
    | { board_id?: unknown; workspace_id?: unknown }
    | undefined;
  if (
    typeof place?.board_id !== "string" ||
    typeof place.workspace_id !== "string"
  ) {
    return;
  }
  context.publish(place.workspace_id, {
    type: "workflow.reply",
    replyId,
    taskId: run.taskId,
    boardId: place.board_id,
    coordinatorNodeId: run.coordinatorNodeId,
    nodeId: run.nodeId,
    purpose,
  });
}
