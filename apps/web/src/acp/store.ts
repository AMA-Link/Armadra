/**
 * 会话视图的投递状态（契约 §39.9）。
 *
 * 内容（消息、工具、计划、用量……）全部来自时间线，不在这里：`timeline/` 的数据层
 * 管同步。这里只记一件事——页面发出的那一轮 prompt 走到哪了：
 *
 *  * `pending`：提问已发出、core 还没把它回显成时间线条目（页面先把它画出来）；
 *  * `confirming`：请求断在路上，core 收没收到还不知道，正在对账；
 *  * `undelivered`：对账确认 core 没收到（或无从确认），重试沿用同一个 `clientTurnId`；
 *  * `failed`：core 当场拒绝了这一轮。
 */
import { create } from "zustand";
import type { TimelineAttachment } from "@armadra/shared";

import { scoped } from "../sources/scope";

export interface PendingPrompt {
  readonly clientTurnId: string;
  readonly text: string;
  readonly attachments: readonly TimelineAttachment[];
  /** 发出的时刻（毫秒）。 */
  readonly at: number;
}

export interface AcpDeliveryView {
  readonly pending: PendingPrompt | null;
  /** 本页最近发出的那一轮的 `clientTurnId`。 */
  readonly clientTurnId: string | null;
  readonly lastPrompt: string | null;
  readonly confirming: boolean;
  readonly undelivered: boolean;
  readonly failed: boolean;
}

export const EMPTY_DELIVERY: AcpDeliveryView = {
  pending: null,
  clientTurnId: null,
  lastPrompt: null,
  confirming: false,
  undelivered: false,
  failed: false,
};

/** 页面发出一条 prompt。重试没送达的那一轮（同一个 id）沿用已画出的提问。 */
export function beginDelivery(
  view: AcpDeliveryView,
  prompt: Omit<PendingPrompt, "at">,
  at: number,
): AcpDeliveryView {
  if (view.undelivered && prompt.clientTurnId === view.clientTurnId) {
    return { ...view, confirming: false, undelivered: false, failed: false };
  }
  return {
    pending: { ...prompt, at },
    clientTurnId: prompt.clientTurnId,
    lastPrompt: prompt.text,
    confirming: false,
    undelivered: false,
    failed: false,
  };
}

interface AcpDeliveryState {
  /** 键是 `${sourceId}:${sessionId}`（`sources/scope.ts`）。 */
  readonly sessions: Readonly<Record<string, AcpDeliveryView>>;
  begin: (sessionId: string, prompt: Omit<PendingPrompt, "at">) => void;
  /** core 把这一轮回显成了条目：不再需要页面自己画。`delivered` = 回显出自 core。 */
  ack: (sessionId: string, clientTurnId: string, delivered: boolean) => void;
  /** 发 prompt 的请求断在路上：进入「确认中」。 */
  confirm: (sessionId: string) => void;
  /** 对账确认 core 收到了。 */
  delivered: (sessionId: string) => void;
  /** 对账确认 core 没收到（或无从确认）。 */
  undeliver: (sessionId: string) => void;
  /** core 当场拒绝了这一轮。 */
  fail: (sessionId: string) => void;
  reset: () => void;
}

function patch(
  state: AcpDeliveryState,
  sessionId: string,
  next: (view: AcpDeliveryView) => AcpDeliveryView,
): Pick<AcpDeliveryState, "sessions"> {
  const key = scoped(sessionId);
  const view = state.sessions[key] ?? EMPTY_DELIVERY;
  const after = next(view);
  return after === view
    ? { sessions: state.sessions }
    : { sessions: { ...state.sessions, [key]: after } };
}

export const useAcpStore = create<AcpDeliveryState>((set) => ({
  sessions: {},
  begin: (sessionId, prompt) =>
    set((state) =>
      patch(state, sessionId, (view) =>
        beginDelivery(view, prompt, Date.now()),
      ),
    ),
  ack: (sessionId, clientTurnId, delivered) =>
    set((state) =>
      patch(state, sessionId, (view) => {
        if (view.pending?.clientTurnId !== clientTurnId) return view;
        return {
          ...view,
          pending: null,
          ...(delivered
            ? { confirming: false, undelivered: false, failed: false }
            : {}),
        };
      }),
    ),
  confirm: (sessionId) =>
    set((state) =>
      patch(state, sessionId, (view) => ({ ...view, confirming: true })),
    ),
  delivered: (sessionId) =>
    set((state) =>
      patch(state, sessionId, (view) =>
        view.confirming || view.undelivered
          ? { ...view, confirming: false, undelivered: false }
          : view,
      ),
    ),
  undeliver: (sessionId) =>
    set((state) =>
      patch(state, sessionId, (view) =>
        view.confirming
          ? { ...view, confirming: false, undelivered: true }
          : view,
      ),
    ),
  fail: (sessionId) =>
    set((state) =>
      patch(state, sessionId, (view) => ({
        ...view,
        confirming: false,
        failed: true,
      })),
    ),
  reset: () => set({ sessions: {} }),
}));
