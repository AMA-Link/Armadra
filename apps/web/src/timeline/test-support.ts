/** 数据层测试的共用件：假 core、假传输、手动帧调度器、条目工厂。 */
import {
  applyTimelineOps,
  emptyTimelineState,
  timelineChangesSince,
  turnIndexOf,
  type SessionActivity,
  type TimelineActivityEvent,
  type TimelineAssistantItem,
  type TimelineDelta,
  type TimelineItem,
  type TimelineOp,
  type TimelineState,
  type TimelineUserItem,
} from "@armadra/shared";
import { vi } from "vitest";

import type { TimelineListener, TimelineTransport } from "./api";
import type { FrameScheduler } from "./sync";

export const TIMELINE_ID = "sess-1";
export const SOURCE_ID = "local";

export function user(turn: number, text = `q${turn}`): TimelineUserItem {
  return {
    id: `u:${turn}`,
    kind: "user",
    turn,
    ord: 0,
    rev: 0,
    source: "acp",
    at: 1_000 + turn,
    gen: 1,
    text,
  };
}

export function assistant(
  turn: number,
  text = `a${turn}`,
  streaming = false,
): TimelineAssistantItem {
  return {
    id: `a:${turn}:0`,
    kind: "assistant",
    turn,
    ord: 1,
    rev: 0,
    source: "acp",
    at: 1_000 + turn,
    gen: 1,
    parts: [{ type: "text", text }],
    streaming,
  };
}

export function put(seq: number, item: TimelineItem): TimelineOp {
  return { seq, op: "put", item };
}

export function append(seq: number, itemId: string, text: string): TimelineOp {
  return { seq, op: "append", itemId, delta: { text } };
}

export function frame(
  from: number,
  to: number,
  ops: TimelineOp[],
  timelineId = TIMELINE_ID,
): TimelineDelta {
  return { timelineId, nodeId: "node-1", from, to, ops };
}

export function activity(n: number, phase: SessionActivity["phase"] = "idle") {
  return { phase, since: 1_000 * n, rev: `boot:${n}` } as SessionActivity;
}

export function assistantText(item: TimelineItem | undefined): string {
  if (item?.kind !== "assistant") return "";
  return item.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** 一个会随操作演进的假 core；帧由测试决定怎么投递（丢、重、乱序）。 */
export class FakeCore {
  state: TimelineState = emptyTimelineState();
  readonly calls: string[] = [];
  readonly listeners = new Set<TimelineListener>();
  failNext: Error | undefined;
  currentActivity: SessionActivity | undefined;

  /** `turns` 个回合，每回合一条用户 + 一条助手消息。 */
  seedTurns(turns: number): this {
    const ops: TimelineOp[] = [];
    let seq = this.state.seq;
    for (let turn = 0; turn < turns; turn++) {
      ops.push(put(++seq, user(turn)), put(++seq, assistant(turn)));
    }
    this.state = applyTimelineOps(this.state, ops).state;
    return this;
  }

  /** 应用操作并给出对应的帧（不投递）。 */
  emit(...ops: Omit<TimelineOp, "seq">[]): TimelineDelta {
    const from = this.state.seq;
    const withSeq = ops.map(
      (op, index) => ({ ...op, seq: from + index + 1 }) as TimelineOp,
    );
    this.state = applyTimelineOps(this.state, withSeq).state;
    return frame(from, this.state.seq, withSeq);
  }

  deliver(delta: TimelineDelta): void {
    for (const listener of this.listeners) listener.delta(delta);
  }

  deliverActivity(event: SessionActivity): void {
    const payload: TimelineActivityEvent = {
      timelineId: TIMELINE_ID,
      nodeId: "node-1",
      activity: event,
    };
    for (const listener of this.listeners) listener.activity(payload);
  }

  reconnect(): void {
    for (const listener of this.listeners) listener.reconnected();
  }

  private maybeFail(): void {
    const error = this.failNext;
    this.failNext = undefined;
    if (error !== undefined) throw error;
  }

  private turnNumbers(): number[] {
    return [
      ...new Set(Object.values(this.state.items).map((i) => i.turn)),
    ].sort((a, b) => a - b);
  }

  readonly transport: TimelineTransport = {
    open: vi.fn(async (_id: string, tail = 3) => {
      this.calls.push("open");
      this.maybeFail();
      const keep = new Set(this.turnNumbers().slice(-tail));
      const all = Object.values(this.state.items);
      return {
        headSeq: this.state.seq,
        head: this.state.head,
        headRev: this.state.headRev,
        turns: turnIndexOf(all),
        items: all.filter((item) => keep.has(item.turn)),
        ...(this.currentActivity === undefined
          ? {}
          : { activity: this.currentActivity }),
      };
    }),
    sync: vi.fn(async (_id: string, after: number) => {
      this.calls.push(`sync:${after}`);
      this.maybeFail();
      if (after > this.state.seq) {
        throw Object.assign(new Error("cursor ahead"), {
          code: "cursor_ahead",
        });
      }
      return timelineChangesSince(this.state, after);
    }),
    page: vi.fn(async (_id: string, before: number, turns = 5) => {
      this.calls.push(`page:${before}`);
      this.maybeFail();
      const keep = new Set(
        this.turnNumbers()
          .filter((turn) => turn < before)
          .slice(-turns),
      );
      return {
        items: Object.values(this.state.items).filter((item) =>
          keep.has(item.turn),
        ),
      };
    }),
    blob: vi.fn(async () => ({ mimeType: "text/plain", bytes: 0, data: "" })),
    subscribe: (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };
}

/** 手动推进的帧调度器：`runFrame()` 触发一次。 */
export function manualScheduler() {
  let queued: (() => void) | undefined;
  let requests = 0;
  const scheduler: FrameScheduler = {
    request(run) {
      requests++;
      queued = run;
      return () => {
        if (queued === run) queued = undefined;
      };
    },
  };
  return {
    scheduler,
    get requests() {
      return requests;
    },
    get pending() {
      return queued !== undefined;
    },
    runFrame() {
      const run = queued;
      queued = undefined;
      run?.();
    },
  };
}
