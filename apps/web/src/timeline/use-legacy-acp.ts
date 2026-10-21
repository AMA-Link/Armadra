/**
 * 旧主机退路的页面侧（见 `legacy-acp.ts`）：读 `acp.log`、接 `acp.update` /
 * `acp.turn` / `agent.approval`，得到与 `useTimeline` 同形的条目。
 *
 * 状态放在 zustand 里（按 `${sourceId}:${sessionId}` 分键）：同一个节点可以同时挂
 * 两份会话视图（手机焦点页铺满时画布上那一份还在），两份读同一个状态；每条事件
 * 按对象去重，只并进去一次。先订阅再读，读回来之前到的分块已经在镜像里（core 先写
 * 镜像再发事件），丢掉不画；读失败时它们没被任何一次读覆盖，照常并进去。控制面断开
 * 又连上后重读一遍（契约 §39.9）。
 */
import * as React from "react";
import {
  type AcpLogResponse,
  type AcpPromptCapabilities,
  type AcpSessionUpdate,
  type AcpTurnEvent,
  type SessionActivity,
  type TimelineHead,
  type TimelineItem,
} from "@armadra/shared";
import { create } from "zustand";

import { acpApi } from "@/acp/api";
import { onWorkspaceConnection, onWorkspaceEvent } from "@/api/events";
import { isResolvedApproval } from "@/agent/status-store";
import { scoped } from "@/sources/scope";

import { acpElicitationOf, acpPermissionOf } from "@/acp/approval-views";
import {
  activityOf,
  addApproval,
  addElicitation,
  applyUpdate,
  beginTurn,
  confirmLocal,
  emptyLegacyState,
  endTurn,
  fromLog,
  itemsOf,
  resolvePending,
  type LegacyState,
  type LocalPrompt,
} from "./legacy-acp";

interface LegacyEntry {
  readonly state: LegacyState;
  readonly items: readonly TimelineItem[];
  readonly activity: SessionActivity | undefined;
  readonly promptCapabilities: AcpPromptCapabilities | null;
  readonly turns: AcpLogResponse["turns"];
}

const EMPTY_ENTRY: LegacyEntry = {
  state: emptyLegacyState(),
  items: [],
  activity: undefined,
  promptCapabilities: null,
  turns: undefined,
};

function entryOf(
  state: LegacyState,
  previous: LegacyEntry,
  extra: Partial<Pick<LegacyEntry, "promptCapabilities" | "turns">> = {},
): LegacyEntry {
  return {
    state,
    items: itemsOf(state),
    activity: activityOf(state),
    promptCapabilities: extra.promptCapabilities ?? previous.promptCapabilities,
    turns: "turns" in extra ? extra.turns : previous.turns,
  };
}

interface LegacyStoreState {
  readonly sessions: Readonly<Record<string, LegacyEntry>>;
  hydrate: (sessionId: string, log: AcpLogResponse) => void;
  update: (sessionId: string, update: AcpSessionUpdate) => void;
  begin: (sessionId: string, prompt: LocalPrompt) => void;
  end: (
    sessionId: string,
    event: Pick<AcpTurnEvent, "stopReason" | "error" | "clientTurnId">,
  ) => void;
  /** 审批 / 提问已答或已过期。 */
  resolve: (sessionId: string, pendingId: string) => void;
  approval: (sessionId: string, pendingId: string, request: unknown) => void;
  /** 对账确认 core 收到了这一轮：不再需要补回。 */
  delivered: (sessionId: string, clientTurnId: string) => void;
  reset: () => void;
}

function patch(
  state: LegacyStoreState,
  sessionId: string,
  next: (entry: LegacyEntry) => LegacyEntry,
): Pick<LegacyStoreState, "sessions"> {
  const key = scoped(sessionId);
  const entry = state.sessions[key] ?? EMPTY_ENTRY;
  return { sessions: { ...state.sessions, [key]: next(entry) } };
}

export const useLegacyAcpStore = create<LegacyStoreState>((set) => ({
  sessions: {},
  hydrate: (sessionId, log) =>
    set((state) =>
      patch(state, sessionId, (entry) =>
        entryOf(fromLog(log, entry.state, Date.now()), entry, {
          promptCapabilities: log.promptCapabilities ?? null,
          turns: log.turns,
        }),
      ),
    ),
  update: (sessionId, update) =>
    set((state) =>
      patch(state, sessionId, (entry) => {
        const next = applyUpdate(entry.state, update, Date.now());
        return next === entry.state ? entry : entryOf(next, entry);
      }),
    ),
  begin: (sessionId, prompt) =>
    set((state) =>
      patch(state, sessionId, (entry) => {
        // 重试没送达的那一轮：提问已经画着，不再画第二遍。
        if (
          entry.state.locals.some((l) => l.clientTurnId === prompt.clientTurnId)
        ) {
          return entry;
        }
        return entryOf(beginTurn(entry.state, Date.now(), prompt), entry);
      }),
    ),
  end: (sessionId, event) =>
    set((state) =>
      patch(state, sessionId, (entry) => {
        const next = endTurn(entry.state, event, Date.now());
        // 回合结束时挂起的审批都已由 core 回了 `cancelled`（ACP 设计 §5.5）：
        // `acpTurnEndOps` 的收尾在 `endTurn` 里已把它们记为 cancelled。
        return entryOf(next, entry);
      }),
    ),
  resolve: (sessionId, pendingId) =>
    set((state) =>
      patch(state, sessionId, (entry) =>
        entryOf(resolvePending(entry.state, pendingId), entry),
      ),
    ),
  approval: (sessionId, pendingId, request) =>
    set((state) =>
      patch(state, sessionId, (entry) => {
        const permission = acpPermissionOf(pendingId, request);
        if (permission !== null) {
          return entryOf(
            addApproval(entry.state, permission, Date.now()),
            entry,
          );
        }
        const elicitation = acpElicitationOf(pendingId, request);
        return elicitation === null
          ? entry
          : entryOf(
              addElicitation(entry.state, elicitation, Date.now()),
              entry,
            );
      }),
    ),
  delivered: (sessionId, clientTurnId) =>
    set((state) =>
      patch(state, sessionId, (entry) =>
        entryOf(confirmLocal(entry.state, clientTurnId), entry),
      ),
    ),
  reset: () => set({ sessions: {} }),
}));

/** 对账：本页那一轮在 core 的回合记录里（`log.turns`）。 */
export function turnRecordOf(
  turns: AcpLogResponse["turns"],
  clientTurnId: string | null,
) {
  if (clientTurnId === null) return undefined;
  return turns?.find((turn) => turn.clientTurnId === clientTurnId);
}

/**
 * 已经并进 store 的那几条事件（按对象认：同一条事件派给每个订阅者的是同一个
 * 对象）。两份视图各自订阅，不去重的话每个分块都会被拼两遍。
 */
const applied = new WeakSet<object>();

function firstTime(event: object): boolean {
  if (applied.has(event)) return false;
  applied.add(event);
  return true;
}

export type LegacyPhase = "idle" | "loading" | "ready" | "failed";

export interface LegacyAcpFeed {
  phase: LegacyPhase;
  items: readonly TimelineItem[];
  head: TimelineHead;
  activity: SessionActivity | undefined;
  promptCapabilities: AcpPromptCapabilities | null;
  /** 最近一次读到的回合记录（对账用）。 */
  turns: AcpLogResponse["turns"];
  /** 重读镜像（「确认中」对账、重连）；读到后已并进状态。 */
  reread(): Promise<AcpLogResponse>;
  retry(): void;
}

const NO_HEAD: TimelineHead = {};

export function useLegacyAcp(options: {
  sessionId: string | null;
  nodeId: string;
  workspaceId: string | null;
  enabled: boolean;
}): LegacyAcpFeed {
  const { sessionId, nodeId, workspaceId, enabled } = options;
  const [phase, setPhase] = React.useState<LegacyPhase>("idle");
  const [attempt, setAttempt] = React.useState(0);
  const rereadRef = React.useRef<(() => Promise<AcpLogResponse>) | null>(null);

  React.useEffect(() => {
    if (!enabled || !sessionId) {
      setPhase("idle");
      return;
    }
    const store = useLegacyAcpStore.getState;
    let loaded = false;
    let cancelled = false;
    let inflight: Promise<AcpLogResponse> | null = null;
    setPhase("loading");

    const early: { event: object; update: AcpSessionUpdate }[] = [];
    const offUpdate = onWorkspaceEvent("acp.update", (event) => {
      if (event.sessionId !== sessionId) return;
      if (!loaded) early.push({ event, update: event.update });
      else if (firstTime(event)) store().update(sessionId, event.update);
    });
    const offTurn = onWorkspaceEvent("acp.turn", (event) => {
      if (event.sessionId !== sessionId || !firstTime(event)) return;
      store().end(sessionId, event);
    });
    const offApproval = onWorkspaceEvent("agent.approval", (event) => {
      if (event.nodeId !== nodeId || !firstTime(event)) return;
      if (isResolvedApproval(event.request)) {
        store().resolve(sessionId, event.pendingId);
        return;
      }
      store().approval(sessionId, event.pendingId, event.request);
    });

    const read = (): Promise<AcpLogResponse> => {
      if (inflight) return inflight;
      loaded = false;
      const flush = (skipChunks: boolean) => {
        loaded = true;
        for (const { event, update } of early) {
          if (skipChunks && update.sessionUpdate.endsWith("_chunk")) continue;
          if (firstTime(event)) store().update(sessionId, update);
        }
        early.length = 0;
      };
      const pending = acpApi.log(sessionId).then(
        (log) => {
          inflight = null;
          if (cancelled) return log;
          store().hydrate(sessionId, log);
          flush(true);
          return log;
        },
        (error: unknown) => {
          inflight = null;
          if (!cancelled) flush(false);
          throw error;
        },
      );
      inflight = pending;
      return pending;
    };
    rereadRef.current = read;

    read()
      .then(() => {
        if (!cancelled) setPhase("ready");
      })
      .catch(() => {
        if (!cancelled) setPhase("failed");
      });

    let down = false;
    const offConnection = workspaceId
      ? onWorkspaceConnection((id, connected) => {
          if (id !== workspaceId) return;
          if (!connected) {
            down = true;
            return;
          }
          if (!down) return;
          down = false;
          // 断线那段的分块与 `acp.turn` 收不到了：重读一遍补上。失败不打扰，
          // 已经画着的照旧。
          read().catch(() => undefined);
        })
      : () => undefined;

    return () => {
      cancelled = true;
      if (rereadRef.current === read) rereadRef.current = null;
      offUpdate();
      offTurn();
      offApproval();
      offConnection();
    };
  }, [enabled, sessionId, nodeId, workspaceId, attempt]);

  const entry = useLegacyAcpStore((state) =>
    sessionId
      ? (state.sessions[scoped(sessionId)] ?? EMPTY_ENTRY)
      : EMPTY_ENTRY,
  );
  const reread = React.useCallback((): Promise<AcpLogResponse> => {
    const read = rereadRef.current;
    return read ? read() : Promise.reject(new Error("no session"));
  }, []);
  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);

  return {
    phase,
    items: entry.items,
    head: entry.state.timeline.head ?? NO_HEAD,
    activity: entry.activity,
    promptCapabilities: entry.promptCapabilities,
    turns: entry.turns,
    reread,
    retry,
  };
}
