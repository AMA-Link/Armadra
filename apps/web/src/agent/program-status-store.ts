/**
 * 终端程序自报状态的前端镜像（契约 §53：OSC 7501 / OSC 9;4）。
 *
 * 与 `status-store.ts` 分开放：那张表里的每一条都是 Hook / 扩展 / ACP 的
 * 上报，好几处闸门（启动等待、投递）把「有一条」当作「报过了」。程序自报
 * 谁都能伪造——`cat` 一个文件就够——所以它只进这张表，只用来画节点头、
 * 小地图描边与离屏提醒，不进任何判据。
 *
 * 合并规则在共享层的 `sessionDisplay()` 里（{@link headerStateFor} 只是把
 * 节点头的输入喂给它）：节点有一条**本进程内**的上报状态时，上报说了算，程序自报
 * 只补进度；没有上报（普通终端、没装适配器的 CLI、core 重启后读回来的旧行）时，
 * 程序自报画节点头。侧栏、抽屉、铃铛走同一个函数，所以合并结果处处一致（S5）。
 */
import { create } from "zustand";
import type {
  AgentStatus,
  ProgramStatus,
  SessionSummary,
  WorkspaceEvent,
} from "@armadra/shared";

import { sessionDisplay } from "@armadra/shared";

import { headerOf, type HeaderState } from "./display";
import type { MirroredStatus } from "./status-store";
import { scoped } from "../sources/scope";

export interface ProgramStatusState {
  /** 键是 `${sourceId}:${nodeId}`，与 `status-store.ts` 同一套。 */
  programs: Record<string, ProgramStatus>;
  /** `done` 被看过的节点：规范把「什么时候收起 done」留给终端。 */
  seen: Record<string, true>;
  handleEvent: (event: WorkspaceEvent) => void;
  hydrate: (sessions: SessionSummary[], sourceId?: string) => void;
  /** 用户看过这个节点了：收起 `done` / `error` 的光晕。 */
  markSeen: (nodeId: string) => void;
  reset: () => void;
}

function millis(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? 0 : value;
}

export const useProgramStatusStore = create<ProgramStatusState>((set, get) => ({
  programs: {},
  seen: {},

  handleEvent: (event) => {
    if (event.type === "terminal.exit") {
      if (!event.nodeId) return;
      const key = scoped(event.nodeId);
      if (!get().programs[key]) return;
      set((current) => {
        const programs = { ...current.programs };
        delete programs[key];
        return { programs };
      });
      return;
    }
    if (event.type !== "terminal.program" || !event.nodeId) return;
    const key = scoped(event.nodeId);
    const status = event.status;
    set((current) => {
      const programs = { ...current.programs };
      const seen = { ...current.seen };
      if (status) programs[key] = status;
      else delete programs[key];
      // 新的一条状态：上一条「看过了」不再适用。
      delete seen[key];
      return { programs, seen };
    });
  },

  hydrate: (sessions, sourceId) =>
    set((current) => {
      const programs = { ...current.programs };
      let changed = false;
      for (const session of sessions) {
        const key = scoped(session.nodeId, sourceId);
        const incoming = session.alive ? session.programStatus : undefined;
        const previous = programs[key];
        if (!incoming) {
          if (previous) {
            delete programs[key];
            changed = true;
          }
          continue;
        }
        if (
          previous &&
          millis(previous.updatedAt) >= millis(incoming.updatedAt)
        )
          continue;
        programs[key] = incoming;
        changed = true;
      }
      return changed ? { programs } : current;
    }),

  markSeen: (nodeId) => {
    const key = scoped(nodeId);
    const program = get().programs[key];
    if (!program || get().seen[key]) return;
    if (program.state !== "done" && program.state !== "error") return;
    set((current) => ({ seen: { ...current.seen, [key]: true } }));
  },

  reset: () => set({ programs: {}, seen: {} }),
}));

export function useProgramStatus(
  nodeId: string,
  sourceId?: string,
): ProgramStatus | undefined {
  return useProgramStatusStore(
    (state) => state.programs[scoped(nodeId, sourceId)],
  );
}

export function useProgramSeen(nodeId: string, sourceId?: string): boolean {
  return useProgramStatusStore((state) =>
    Boolean(state.seen[scoped(nodeId, sourceId)]),
  );
}

/* -------------------------------- 显示映射 -------------------------------- */

/** 节点头里多出来的一项：这一刻说话的是上报，还是程序自报。 */
export interface MergedHeaderState extends HeaderState {
  /** 节点头这一刻说的话是谁说的：上报，还是程序自报。 */
  source?: "reported" | "program";
}

/** 上报的状态在这个 core 进程里是活的：它说了算。 */
export function reportedLive(status: AgentStatus | undefined): boolean {
  return Boolean(
    status?.state &&
      !status.restored &&
      (status.stateSource === "hook" ||
        status.stateSource === "extension" ||
        status.stateSource === "acp"),
  );
}

/**
 * 节点头最终画什么。`agent` 为假时（普通终端）上报不参与；Agent 节点有活的
 * 上报时用上报，程序自报只在两边都说「在跑」时补一个进度。
 */
export function headerStateFor(
  agent: boolean,
  status: MirroredStatus | undefined,
  program: ProgramStatus | undefined,
  seen = false,
): MergedHeaderState {
  const own = agent ? status : undefined;
  const live = reportedLive(own);
  // 程序自报在说话：没有活的上报，且它给出了一个有内容的状态。
  const programDrives =
    !live &&
    (program?.state === "working" ||
      program?.state === "blocked" ||
      program?.state === "done" ||
      program?.state === "error");
  // 程序自报的 `done` / `error` 被看过之后收起光晕，规范把这件事留给终端。
  const unread =
    programDrives && (program?.state === "done" || program?.state === "error")
      ? !seen
      : (own?.unread ?? false);
  const display = sessionDisplay({
    ...(own ? { status: own } : {}),
    ...(own?.alive !== undefined ? { alive: own.alive } : {}),
    ...(own?.activity ? { activity: own.activity } : {}),
    ...(program ? { program } : {}),
    unread,
  });
  const header = headerOf(display, unread);
  if (live) return { ...header, source: "reported" };
  if (programDrives && header.pill) return { ...header, source: "program" };
  return agent ? { ...header, source: "reported" } : header;
}
