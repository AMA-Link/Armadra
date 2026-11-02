import { attempt } from "./control/send";
import { loadNode } from "./nodes";
import {
  cardEvents,
  coordinatorsWithFresh,
  composeCard,
  countFresh,
  countOpen,
  markCarded,
  pruneAcked,
} from "./router-events";
import { byId, enqueue, pendingFor, settle } from "./send-queue";
import { type CollabContext, nowDate, nowSeconds } from "./service";
import { uuidV7 } from "../workspaces/support";

/**
 * 批卡片的投递（契约 §93.2，#696）。
 *
 * 事件已经在 `router_events` 里（先落库）；这里只决定**什么时候投、投什么**：
 *
 *   * 协调者空闲、队列里没有别的排队项、且有还没提醒过的事件时，把未确认的事件
 *     （最多 20 行）合并成一张卡片，走收件箱唤醒同一条门链（`origin =
 *     mailbox-wake`，署名是应用）投进去。忙就什么也不做——事件留在表里，下次
 *     空闲合并；
 *   * **不用五分钟的队列期限**：卡片不是排进 `agent_send_queue` 等着过期的一条，
 *     而是每次尝试现编、当场投（`queue: false`）。投不进去（门链拒绝、写失败）
 *     按 5 秒到 300 秒的指数退避重试，没有放弃的那一步；只要事件还没确认就还会
 *     出现在下一张卡片里；
 *   * 退避状态在内存里：重启后第一次扫描（60 秒一次）会把仍有未提醒事件的协调
 *     者再投一遍。
 */

export const CARD_BACKOFF_MIN_SECONDS = 5;
export const CARD_BACKOFF_MAX_SECONDS = 300;

/** 第 `attempts` 次失败之后等多久（秒）：5、10、20 …… 封顶 300。 */
export function backoffSeconds(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(
    CARD_BACKOFF_MAX_SECONDS,
    CARD_BACKOFF_MIN_SECONDS * 2 ** Math.min(exponent, 10),
  );
}

export type CardResult =
  /** 没有要提醒的事件，或协调者不在。 */
  | "none"
  /** 协调者不空闲，或队列里还有别的：等下次空闲。 */
  | "busy"
  /** 还在退避里。 */
  | "waiting"
  | "delivered"
  | "failed";

interface Backoff {
  attempts: number;
  /** 毫秒：这之前不再试。 */
  until: number;
}

export class RouterCards {
  private readonly backoff = new Map<string, Backoff>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /**
   * @param retry 退避到点了，请对这个协调者再试一次（出队泵的 `drain`）。
   */
  constructor(private readonly retry: (nodeId: string) => void) {}

  /** 此刻在退避里的协调者数（用例用）。 */
  waiting(): number {
    return this.backoff.size;
  }

  /** 一次投递尝试。从不抛。 */
  async deliver(
    context: CollabContext,
    coordinatorNodeId: string,
  ): Promise<CardResult> {
    const database = context.database;
    if (countFresh(database, coordinatorNodeId) === 0) {
      this.forget(coordinatorNodeId);
      return "none";
    }
    const node = loadNode(database, coordinatorNodeId);
    if (node === undefined || node.nodeType !== "terminal") return "none";
    const nowMs = nowDate(context).getTime();
    const held = this.backoff.get(coordinatorNodeId);
    if (held !== undefined && held.until > nowMs) {
      this.arm(coordinatorNodeId, held.until - nowMs);
      return "waiting";
    }
    // 忙时事件留在表里；只在真的空闲、且队里没有别的排队项时投，不和别的投递抢
    // 同一个空闲窗口（串行门之外再多一次粘贴）。
    // `starting`（刚接回、只报过一条开场）也试一次：门链里有「会话够老、画面安静
    // 就算空闲」的判据（`attempt` 的 `sessionStart`），不让一个停在提示符上却
    // 还没开过一轮的协调者永远收不到卡片；门链说还不行就按退避重试。
    const drive = context.terminals?.driveTarget;
    const state = drive?.(coordinatorNodeId).state;
    if (state !== "idle" && state !== "starting") return "busy";
    const now = nowSeconds(context);
    if (pendingFor(database, coordinatorNodeId, now).length > 0) return "busy";

    const events = cardEvents(database, coordinatorNodeId);
    const body = composeCard(events, countOpen(database, coordinatorNodeId));
    const inserted = enqueue(database, {
      id: uuidV7(nowMs),
      workspaceId: node.workspaceId,
      sourceNodeId: coordinatorNodeId,
      targetNodeId: coordinatorNodeId,
      origin: "mailbox-wake",
      messageKey: `card:${uuidV7(nowMs)}`,
      body,
      hops: 0,
      trail: [],
      now,
      state: "queued",
    });
    if (inserted.kind !== "inserted")
      return this.fail(coordinatorNodeId, nowMs);
    const item = inserted.item;
    let delivered = false;
    try {
      const outcome = await attempt(context, item, { queue: false });
      delivered = outcome.raw?.outcome === "delivered";
    } catch {
      delivered = false;
    }
    // 这一条只活一次：没投成就收掉，不留在队列里等五分钟的期限。
    const left = byId(database, item.id);
    if (left !== undefined && left.state !== "done") {
      settle(database, item.id, "cancelled", "CARD_RETRY", "source");
    }
    if (!delivered) return this.fail(coordinatorNodeId, nowMs);
    markCarded(
      database,
      events.map((event) => event.id),
      nowMs,
    );
    this.forget(coordinatorNodeId);
    return "delivered";
  }

  /**
   * 兜底清扫（挂在出队泵的 60 秒清扫上）：清掉确认过很久的事件，答仍有未提醒
   * 事件的协调者——丢了触发、重启之后，事件不会就此沉底。调用方对它们各走一次
   * 出队（那里有同一目标不并发的保护）。
   */
  due(context: CollabContext): string[] {
    pruneAcked(context.database, nowDate(context).getTime());
    return coordinatorsWithFresh(context.database);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.backoff.clear();
  }

  private fail(coordinatorNodeId: string, nowMs: number): CardResult {
    const attempts = (this.backoff.get(coordinatorNodeId)?.attempts ?? 0) + 1;
    const delay = backoffSeconds(attempts) * 1000;
    this.backoff.set(coordinatorNodeId, { attempts, until: nowMs + delay });
    this.arm(coordinatorNodeId, delay);
    return "failed";
  }

  /**
   * 协调者报了一条不在忙的状态（一轮结束了）：这是比计时更强的信号，退避清零，
   * 下一次 `deliver` 立刻试。
   */
  reset(coordinatorNodeId: string): void {
    this.forget(coordinatorNodeId);
  }

  private forget(coordinatorNodeId: string): void {
    this.backoff.delete(coordinatorNodeId);
    const timer = this.timers.get(coordinatorNodeId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(coordinatorNodeId);
  }

  private arm(coordinatorNodeId: string, delayMs: number): void {
    if (this.timers.has(coordinatorNodeId)) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(coordinatorNodeId);
        this.retry(coordinatorNodeId);
      },
      Math.max(0, delayMs),
    );
    timer.unref?.();
    this.timers.set(coordinatorNodeId, timer);
  }
}
