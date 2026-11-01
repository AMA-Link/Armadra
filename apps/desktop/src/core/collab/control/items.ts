import type { DatabaseSync } from "node:sqlite";
import {
  WORK_ITEM_REPORT_STATES,
  WORK_ITEM_STAGES,
  type WorkItemReportState,
  type WorkItemStage,
} from "@armadra/shared";
import { type TaskRun, publishTask, taskRun } from "../../workflow/task-runs";
import {
  itemsOfNode,
  recordHandback,
  recordReport,
  stageOf,
  stageRank,
} from "../../workflow/work-items";
import type { Caller } from "../nodes";
import { type Args, Refused, stripControl } from "../refusals";
import { type CollabContext, nowDate, nowSeconds } from "../service";
import { type Outcome, result } from "./outcome";

/**
 * 工作项账本的三个动词（契约 §90.3）：`report`、`handback`、`items`。
 *
 * 账本就是 `workflow_task_runs`：协调者分派出去的每件事一行。成员用 `report`
 * 写结构化的报告，用 `handback` 把一条跟进交回协调者；协调者用 `items` 读
 * 账本，而不是翻聊天历史。**阶段不是任何人写的**，由 `work-items.ts::itemStage`
 * 从事实推出。
 */

export const MAX_SUMMARY_CHARS = 300;
export const MAX_ACTION_CHARS = 300;
export const MAX_REASON_CHARS = 100;
/** `items` 一页缺省与最多多少行。 */
export const DEFAULT_ITEMS = 20;
export const MAX_ITEMS = 50;
/** 单项详情里来源原文一段多少字节（沿用 #674 的 `--offset` 续读约定）。 */
export const ORIGIN_SEGMENT_BYTES = 2048;

function bad(message: string): Refused {
  return new Refused(400, "bad_request", message);
}

/** 必填的一行文字：去控制字符、折叠换行，限长（超长拒绝，不静默截断）。 */
function limited(
  args: Args,
  name: string,
  max: number,
  required: boolean,
): string | undefined {
  const raw = args.text(name);
  if (raw === undefined) {
    if (required) throw bad(`--${name} 不能缺。`);
    return undefined;
  }
  const text = stripControl(raw).replace(/\s+/g, " ").trim();
  if (text === "") {
    if (required) throw bad(`--${name} 不能缺。`);
    return undefined;
  }
  if ([...text].length > max) {
    throw bad(`--${name} 不超过 ${max} 个字符。`);
  }
  return text;
}

function ownItem(database: DatabaseSync, caller: Caller, id: string): TaskRun {
  const run = taskRun(database, id);
  // 别人的工作项与不存在的同答：不泄露它在不在。
  if (run === undefined || run.nodeId !== caller.node.id) {
    throw new Refused(404, "item_not_found", `你名下没有工作项 \`${id}\`。`);
  }
  return run;
}

/** `report` 缺省的工作项：本节点名下唯一一个进行中的。 */
function defaultItem(database: DatabaseSync, caller: Caller): TaskRun {
  const all = itemsOfNode(database, caller.node.id);
  if (all.length === 0) {
    throw new Refused(
      404,
      "no_work_item",
      "这个节点名下没有工作项，没人认领的报告不收；工作项由协调者派发时建立。",
    );
  }
  const running = all.filter((item) => item.status === "running");
  if (running.length === 1) return running[0] as TaskRun;
  throw new Refused(
    409,
    running.length === 0 ? "no_running_item" : "ambiguous_item",
    running.length === 0
      ? `没有进行中的工作项，用 --item 指明：${all.map((item) => item.taskId).join(" / ")}。`
      : `有 ${running.length} 个进行中的工作项，用 --item 指明：${running.map((item) => item.taskId).join(" / ")}。`,
  );
}

/** `canvas report` */
export function report(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const state = args.text("state");
  if (
    state === undefined ||
    !(WORK_ITEM_REPORT_STATES as readonly string[]).includes(state)
  ) {
    throw bad(`--state 是 ${WORK_ITEM_REPORT_STATES.join(" / ")} 之一。`);
  }
  const summary = limited(args, "summary", MAX_SUMMARY_CHARS, true) as string;
  if (args.value("human-action") === true) {
    throw bad("--human-action 要带一个具体的问题。");
  }
  const action = limited(args, "human-action", MAX_ACTION_CHARS, false);
  const clear = args.flag("clear-action");
  if (action !== undefined && clear) {
    throw bad("--human-action 与 --clear-action 只能给一个。");
  }
  const wanted = args.text("item");
  const item =
    wanted === undefined
      ? defaultItem(context.database, caller)
      : ownItem(context.database, caller, wanted);
  // 单槽：给出就替换，省略就保持，`--clear-action` 清除。
  const attention = clear ? null : action;
  const updated = recordReport(context.database, item.taskId, {
    state: state as WorkItemReportState,
    summary,
    attention,
    nowMs: nowDate(context).getTime(),
  });
  const stage = stageOf(context.database, updated, nowSeconds(context));
  publishTask(context.database, context.publish, item.taskId);
  return result(
    `已记下工作项 ${item.taskId} 的报告（${state}），阶段 ${stage}。`,
    {
      item: item.taskId,
      state,
      stage,
      attention: updated.attention,
    },
  );
}

/** `canvas handback` */
export function handback(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const id = args.text("item");
  if (id === undefined) throw bad("--item 不能缺。");
  const reason = limited(args, "reason", MAX_REASON_CHARS, true) as string;
  const item = ownItem(context.database, caller, id);
  if (
    !recordHandback(
      context.database,
      item.taskId,
      reason,
      nowDate(context).getTime(),
    )
  ) {
    throw new Refused(
      409,
      "already_handed_back",
      `工作项 ${item.taskId} 已经交回过一次了，每条只能交回一次。`,
    );
  }
  publishTask(context.database, context.publish, item.taskId);
  return result(`已把工作项 ${item.taskId} 交回协调者。`, {
    item: item.taskId,
    reason,
  });
}

interface Row {
  readonly run: TaskRun;
  readonly stage: WorkItemStage;
  readonly nodeTitle: string;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

function listLine(row: Row): string {
  const { run } = row;
  const parts = [
    run.taskId,
    run.title ?? "(无标题)",
    row.nodeTitle,
    row.stage,
    run.report === null
      ? "-"
      : `${run.report.state}: ${firstLine(run.report.summary)}`,
  ];
  if (run.attention !== null) parts.push(`? ${run.attention.question}`);
  return parts.join(" · ");
}

function rowJson(row: Row): Record<string, unknown> {
  const { run } = row;
  return {
    id: run.taskId,
    title: run.title,
    nodeId: run.nodeId,
    nodeTitle: row.nodeTitle,
    stage: row.stage,
    status: run.status,
    report: run.report,
    attention: run.attention,
  };
}

/** 调用者看得到的行：它派发的（协调者），与派给它的（成员自己的）。 */
function visible(database: DatabaseSync, caller: Caller): TaskRun[] {
  const rows = database
    .prepare(
      "SELECT task_id FROM workflow_task_runs WHERE coordinator_node_id = ? OR node_id = ? " +
        "ORDER BY started_at DESC, rowid DESC",
    )
    .all(caller.node.id, caller.node.id) as { task_id: string }[];
  return rows.map((row) => taskRun(database, row.task_id) as TaskRun);
}

function nodeTitleOf(database: DatabaseSync, nodeId: string): string {
  const row = database
    .prepare("SELECT title FROM nodes WHERE id = ?")
    .get(nodeId) as { title?: unknown } | undefined;
  return typeof row?.title === "string" ? row.title : "(已删除的节点)";
}

/** `canvas items` */
export function items(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const database = context.database;
  const now = nowSeconds(context);
  const rows: Row[] = visible(database, caller).map((run) => ({
    run,
    stage: stageOf(database, run, now),
    nodeTitle: nodeTitleOf(database, run.nodeId),
  }));
  const wanted = args.text("item");
  if (wanted !== undefined) {
    const row = rows.find((candidate) => candidate.run.taskId === wanted);
    if (row === undefined) {
      throw new Refused(404, "item_not_found", `没有工作项 \`${wanted}\`。`);
    }
    return detail(row, args);
  }

  const stage = args.text("stage");
  if (
    stage !== undefined &&
    !(WORK_ITEM_STAGES as readonly string[]).includes(stage)
  ) {
    throw bad(`--stage 是 ${WORK_ITEM_STAGES.join(" / ")} 之一。`);
  }
  const filtered = rows
    .filter((row) => stage === undefined || row.stage === stage)
    // `person/*` 在前；同一阶段里新的在前（`visible` 已按开始时刻排好，排序稳定）。
    .sort((a, b) => stageRank(a.stage) - stageRank(b.stage));
  const limit = Math.min(
    MAX_ITEMS,
    Math.max(1, args.count(["limit"]) ?? DEFAULT_ITEMS),
  );
  const offset = Math.max(0, args.count(["offset"]) ?? 0);
  const page = filtered.slice(offset, offset + limit);
  const next =
    offset + page.length < filtered.length ? offset + page.length : null;
  const lines = page.map(listLine);
  const message =
    filtered.length === 0
      ? "账本里没有工作项。"
      : `${lines.join("\n")}\n共 ${filtered.length} 项，第 ${offset + 1}–${offset + page.length} 项。` +
        (next === null
          ? ""
          : `接着读：\`canvas items${stage === undefined ? "" : ` --stage ${stage}`} --offset ${next}\`。`) +
        "\n单项详情：`canvas items --item <id>`。";
  return result(message, {
    items: page.map(rowJson),
    total: filtered.length,
    offset,
    next,
  });
}

/** UTF-8 的后续字节（10xxxxxx）：一个字符的中间。 */
function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** 来源原文的一段：起点与终点都对齐到字符边界，按提示接着读拼回原文。 */
export function originSegment(
  text: string,
  offset: number,
): { text: string; from: number; to: number; size: number } {
  const bytes = Buffer.from(text, "utf8");
  let from = Math.min(Math.max(0, offset), bytes.length);
  while (from < bytes.length && isContinuation(bytes[from])) from += 1;
  let to = Math.min(bytes.length, from + ORIGIN_SEGMENT_BYTES);
  if (to < bytes.length) {
    while (to > from && isContinuation(bytes[to])) to -= 1;
  }
  return {
    text: bytes.subarray(from, to).toString("utf8"),
    from,
    to,
    size: bytes.length,
  };
}

function detail(row: Row, args: Args): Outcome {
  const { run } = row;
  const origin = run.origin;
  const offset = args.count(["offset"]) ?? 0;
  const segment =
    origin?.text === undefined ? undefined : originSegment(origin.text, offset);
  const lines = [
    `${run.taskId} · ${run.title ?? "(无标题)"}`,
    `节点：${row.nodeTitle}（${run.nodeId}） · 阶段：${row.stage} · 状态：${run.status}`,
  ];
  if (run.mandate !== null) {
    lines.push(
      `授权：${run.mandate.by} · ${run.mandate.basis} · ${run.mandate.scope} · ${run.mandate.at}`,
    );
  }
  if (run.attention !== null) {
    lines.push(
      `待决问题：${run.attention.question}（${run.attention.raisedAt}）`,
    );
  }
  if (run.handback !== null) {
    lines.push(`已交回：${run.handback.reason}（${run.handback.at}）`);
  }
  if (origin !== null) {
    lines.push(`来源：${origin.kind} ${origin.ref}`);
  }
  if (segment !== undefined) {
    const part =
      segment.from > 0 || segment.to < segment.size
        ? `（第 ${segment.from}–${segment.to} 字节，共 ${segment.size} 字节）`
        : "";
    lines.push(`来源原文${part}：`, segment.text);
    if (segment.to < segment.size) {
      lines.push(
        `接着读：\`canvas items --item ${run.taskId} --offset ${segment.to}\`。`,
      );
    }
  }
  if (run.reports.length > 0) {
    lines.push("报告历史：");
    for (const entry of run.reports) {
      lines.push(`- ${entry.at} ${entry.state}: ${entry.summary}`);
    }
  }
  return result(lines.join("\n"), {
    ...rowJson(row),
    mandate: run.mandate,
    handback: run.handback,
    origin:
      origin === null
        ? null
        : {
            kind: origin.kind,
            ref: origin.ref,
            ...(segment === undefined
              ? {}
              : {
                  text: segment.text,
                  from: segment.from,
                  to: segment.to,
                  size: segment.size,
                  next: segment.to < segment.size ? segment.to : null,
                }),
          },
    reports: run.reports,
  });
}
