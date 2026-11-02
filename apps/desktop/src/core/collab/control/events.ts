import {
  DEFAULT_EVENTS,
  MAX_EVENTS,
  ackEvent,
  countOpen,
  eventLine,
  openEvents,
} from "../router-events";
import type { Caller } from "../nodes";
import { type Args, Refused } from "../refusals";
import { type CollabContext, nowDate } from "../service";
import { type Outcome, result } from "./outcome";

/**
 * 协调者事件队列的两个动词（契约 §93.3）：`events` 读未确认的事件，
 * `ack --event` 确认「我处理了」。事件按协调者节点归属，调用者只读到、只确认
 * 自己名下的；别人的与不存在的同答，不泄露它在不在。
 */

/** `canvas events [--limit N]` */
export function events(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const limit = Math.min(
    MAX_EVENTS,
    Math.max(1, args.count(["limit"]) ?? DEFAULT_EVENTS),
  );
  const open = openEvents(context.database, caller.node.id, limit);
  const total = countOpen(context.database, caller.node.id);
  const message =
    total === 0
      ? "没有未确认的事件。"
      : `${open.map(eventLine).join("\n")}\n共 ${total} 条未确认` +
        (total > open.length
          ? `，列出最早的 ${open.length} 条；处理并 \`canvas ack --event <事件 id>\` 之后再读。`
          : "。") +
        "\n确认：`canvas ack --event <事件 id>`；工作项详情：`canvas items --item <工作项 id>`。";
  return result(message, {
    events: open.map((event) => ({
      id: event.id,
      item: event.itemId,
      kind: event.kind,
      source: event.sourceNodeId,
      summary: event.summary,
      at: new Date(event.createdAt).toISOString(),
    })),
    total,
  });
}

/** `canvas ack --event <id>` */
export function ackEventVerb(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  if (args.value("event") === true || args.text("event") === undefined) {
    throw new Refused(400, "bad_request", "--event 要带一个事件 id。");
  }
  const id = args.text("event") as string;
  if (args.text("id") !== undefined) {
    throw new Refused(
      400,
      "bad_request",
      "--event 与 --id 只能给一个：--id 确认收件箱消息，--event 确认协调者事件。",
    );
  }
  const outcome = ackEvent(
    context.database,
    caller.node.id,
    id,
    nowDate(context).getTime(),
  );
  if (outcome === "missing") {
    throw new Refused(404, "event_not_found", `没有你名下的事件 \`${id}\`。`);
  }
  return result(
    outcome === "acked" ? `已确认事件 ${id}。` : `事件 ${id} 早已确认过。`,
    { event: id, acked: outcome === "acked" },
  );
}
