// 场景 11 的步骤 9：协调者的统一事件队列（契约 §93，#696）。单放一个文件：
// scenario-11-coordinator.mjs 已到仓库的单文件行数上限。
import { canvasAsIn, note, sleep, waitFor } from "./lib.mjs";

/** 占住协调者的那条 post：脚本化模型读到「慢速」就拖 {@link BUSY_MS} 毫秒再 ack。 */
export const BUSY_HOLD = "慢速：先别急着处理其他事";
export const BUSY_MS = 9_000;
/** 事件卡片的开头（`collab/router-events.ts::composeCard`）。 */
export const CARD_MARK = "协调者事件：未确认";

/**
 * 脚本化模型对事件卡片的回应：读 `canvas_events`，逐条 `canvas_ack --event`
 * 确认不是收件箱的事件（收件箱的消息仍走 inbox → ack --id，它们的事件随之确认）。
 * 最后一条用户消息不是卡片时答 `undefined`，由原来的脚本接着走。
 */
export function cardReply(messages, textOf, lastToolCall) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser === undefined || !textOf(lastUser).includes(CARD_MARK))
    return undefined;
  if (messages[messages.length - 1]?.role === "user")
    return { toolCalls: [{ name: "canvas_events", arguments: {} }] };
  if (lastToolCall(messages) === "canvas_events") {
    const listed = textOf(
      [...messages].reverse().find((m) => m.role === "tool"),
    );
    const ids = [
      ...listed.matchAll(
        /(?:report|attention|handback|task-done|stalled|followup|followup-failed):[^\s"·]+/g,
      ),
    ].map((match) => match[0]);
    return ids.length === 0
      ? { text: "没有要处理的事件。" }
      : {
          toolCalls: [...new Set(ids)].map((id) => ({
            name: "canvas_ack",
            arguments: { event: id },
          })),
        };
  }
  return { text: "事件已处理。" };
}

/**
 * 步骤 9：协调者忙的时候两个成员先后 `report ready`，只投一张卡片，列出这两项；
 * 协调者 `canvas ack --event` 之后，下一张卡片里没有这两条。
 */
export async function routerEventsStep({
  s,
  mock,
  context,
  data,
  database,
  one,
  lead,
  dispatcher,
  controlAs,
  textOf,
}) {
  const cards = () => {
    const request = mock.requests.at(-1);
    return (request?.messages ?? [])
      .filter((m) => m.role === "user" && textOf(m).includes(CARD_MARK))
      .map(textOf);
  };
  const leadState = () =>
    one("SELECT state FROM agent_status WHERE node_id = ?", lead.id)?.state;
  const leadFree = () =>
    !["working", "blocked", "waiting"].includes(leadState());
  const fresh = () =>
    Number(
      one(
        "SELECT COUNT(*) AS n FROM router_events WHERE coordinator_node_id = ? AND acked_at IS NULL AND carded_at IS NULL",
        lead.id,
      )?.n,
    );
  const eventOf = (taskId) =>
    one(
      "SELECT id, acked_at FROM router_events WHERE item_id = ? AND kind = 'report' ORDER BY created_at DESC LIMIT 1",
      taskId,
    );
  const rows = database
    .prepare(
      "SELECT task_id, node_id FROM workflow_task_runs WHERE coordinator_node_id = ? " +
        "AND task_id NOT LIKE 'team-%' ORDER BY started_at",
    )
    .all(lead.id);
  s.check("账本里有三个工作项可用来报告", rows.length === 3, rows);
  const [rowA, rowB, rowC] = rows;

  // 前面步骤留下的事件先被协调者处理掉，协调者空下来。
  await waitFor(
    "协调者空闲且没有没提醒过的事件",
    () => leadFree() && fresh() === 0,
    { timeout: 120_000, interval: 1000 },
  ).catch((error) => {
    note("事件队列诊断", {
      state: leadState(),
      status: database
        .prepare("SELECT * FROM agent_status WHERE node_id = ?")
        .get(lead.id),
      session: database
        .prepare(
          "SELECT id, status, generation, attach_state, agent_id FROM terminal_sessions WHERE owner_node_id = ?",
        )
        .all(lead.id),
      events: database
        .prepare(
          "SELECT id, kind, item_id, carded_at, acked_at FROM router_events",
        )
        .all(),
      cards: cards().length,
      queue: database
        .prepare(
          "SELECT origin, state, last_reason, target_node_id FROM agent_send_queue ORDER BY created_at DESC LIMIT 8",
        )
        .all(),
    });
    throw error;
  });
  await sleep(1500);
  const cardsBefore = cards().length;

  const held = await canvasAsIn(
    context,
    dispatcher.id,
    "post",
    "--to",
    lead.id,
    "--key",
    "task:busy-hold",
    "--body",
    BUSY_HOLD,
  );
  s.check("占住协调者的那条 post 成功", held.code === 0, held.stderr);
  await waitFor("协调者忙起来", () => leadState() === "working", {
    timeout: 60_000,
    interval: 200,
  });
  const readyA = await controlAs(data, rowA.node_id, "report", {
    state: "ready",
    summary: "A 检查完，等验收",
    item: rowA.task_id,
  });
  const readyB = await controlAs(data, rowB.node_id, "report", {
    state: "ready",
    summary: "B 检查完，等验收",
    item: rowB.task_id,
  });
  s.check(
    "协调者忙时两个成员 report ready 都被收下",
    readyA?.result?.notified === true && readyB?.result?.notified === true,
    { readyA, readyB },
  );
  await sleep(1500);
  s.check(
    "忙时两个事件在表里、还没提醒，没有投卡片",
    fresh() === 2 &&
      cards().length === cardsBefore &&
      leadState() === "working",
    {
      fresh: fresh(),
      cards: cards().length,
      cardsBefore,
      state: leadState(),
    },
  );

  await waitFor(
    "协调者空下来后多一张卡片",
    () => cards().length > cardsBefore,
    {
      timeout: 90_000,
      interval: 500,
    },
  );
  await sleep(2000);
  const idA = eventOf(rowA.task_id)?.id;
  const idB = eventOf(rowB.task_id)?.id;
  const merged = cards().slice(cardsBefore);
  s.check(
    "只投了一张卡片，同时列出这两个事件",
    merged.length === 1 &&
      merged[0].includes(idA) &&
      merged[0].includes(idB) &&
      (merged[0].match(/ · report · /g) ?? []).length === 2 &&
      merged[0].includes("canvas items --item"),
    merged,
  );
  s.check(
    "卡片不带终端原文，只有成员写的那一行",
    merged[0].includes("A 检查完，等验收") &&
      merged[0].includes("B 检查完，等验收"),
    merged[0],
  );
  await waitFor(
    "协调者 canvas ack --event 确认了这两条",
    () => eventOf(rowA.task_id)?.acked_at && eventOf(rowB.task_id)?.acked_at,
    { timeout: 60_000, interval: 500 },
  );
  s.check(
    "两个事件都已确认",
    Boolean(eventOf(rowA.task_id)?.acked_at && eventOf(rowB.task_id)?.acked_at),
  );

  await waitFor("协调者空闲", leadFree, { timeout: 60_000, interval: 500 });
  const failed = await controlAs(data, rowC.node_id, "report", {
    state: "failed",
    summary: "C 没做成",
    item: rowC.task_id,
  });
  s.check(
    "第三个成员 report failed 被收下",
    failed?.result?.notified === true,
    failed,
  );
  await waitFor("下一张卡片", () => cards().length > cardsBefore + 1, {
    timeout: 90_000,
    interval: 500,
  });
  const idC = eventOf(rowC.task_id)?.id;
  const next = cards().at(cardsBefore + 1) ?? "";
  s.check(
    "下一张卡片有新事件，没有已确认的那两条",
    next.includes(idC) && !next.includes(idA) && !next.includes(idB),
    next,
  );
}
