import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";

import { clientFor } from "@/api/client";
import { knownSources, type Source } from "@/api/source";
import { useCanvasStore } from "@/store/canvas-store";

/**
 * 会话分享的访客（契约 §60、§71）：没有画布，只被分享了一两条终端 / ACP 会话。
 * core 在身份会话的 `scopes` 里给只限一条会话的授权带上 `resourceId`，页面据此
 * 知道他能开哪几条；读写照旧只由 core 判定。
 */

export interface SharedSession {
  readonly workspaceId: string;
  readonly sessionId: string;
}

interface ScopeLike {
  readonly permission: string;
  readonly workspaceId?: string | undefined;
  readonly resourceId?: string | undefined;
}

export interface SessionShare {
  /** 只限一条会话的终端读授权，按出现顺序、去重。 */
  readonly sessions: readonly SharedSession[];
  /** 只有会话、没有任何画布：这个人能开的就是这几条会话。 */
  readonly sessionOnly: boolean;
}

export function sessionShareOf(scopes: readonly ScopeLike[]): SessionShare {
  const seen = new Set<string>();
  const sessions: SharedSession[] = [];
  for (const scope of scopes) {
    const sessionId = scope.resourceId ?? "";
    if (scope.permission !== "terminal:read" || sessionId === "") continue;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    sessions.push({ workspaceId: scope.workspaceId ?? "", sessionId });
  }
  const canvas = scopes.some((scope) => scope.permission === "canvas:read");
  return { sessions, sessionOnly: sessions.length > 0 && !canvas };
}

/** 那台源上我是不是会话查看者。源还没连上时不问。 */
export function useSessionShare(
  sourceId: string,
  enabled = true,
): SessionShare | undefined {
  return useQuery({
    queryKey: ["shared-session", "scopes", sourceId],
    queryFn: async () => {
      const source = sourceNamed(sourceId);
      if (source === undefined) throw new Error("source not ready");
      const session = await clientFor(source).identity.session({});
      return sessionShareOf(session.scopes);
    },
    enabled,
    // 撤链接、改授权随时会变；这份只决定开哪一页，真正的拦截在 core。
    staleTime: 30_000,
    retry: (failures) => failures < 20,
    retryDelay: 2_000,
  }).data;
}

/** 已登记的源；`sourceById` 不认得时会退回当前源，这里不要那个退路。 */
export function sourceNamed(sourceId: string): Source | undefined {
  return knownSources().find((one) => one.sourceId === sourceId);
}

/* ------------------------------ 打开的那一页 ------------------------------ */

export interface SharedSessionTarget extends SharedSession {
  readonly sourceId: string;
}

interface SharedSessionViewState {
  readonly target: SharedSessionTarget | null;
  open(target: SharedSessionTarget): void;
  close(): void;
}

/** 正在看的那条被分享的会话；打开工作空间时让位给画布。 */
export const useSharedSessionView = create<SharedSessionViewState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

useCanvasStore.subscribe((state, previous) => {
  if (state.workspace !== null && state.workspace !== previous.workspace)
    useSharedSessionView.getState().close();
});
