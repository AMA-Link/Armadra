import { create } from "zustand";
import {
  type DeliveryLane,
  type DeliveryNode,
  type PullSnapshot,
  type WorkspaceEvent,
} from "@armadra/shared";

import { activeSourceId } from "@/sources/scope";
import { sourceById } from "@/api/source";
import { deliveryApi } from "./api";
import { OFF_BOARD_KEEP_MS } from "./model";

/**
 * 交付状态在页面上的镜像（Armadra#988 P4）。栏与短语由 core 推导，页面不算：
 * 首读走路由；`delivery.changed` 只带 `{ boardId, nodeId, lane, phrase }`，
 * 更新对应一行；`pullsChanged` 为真（PR 细节变了、栏没变）时重读路由；
 * 重连后也重读，断线期间的帧补不回来。
 */

export interface DeliveryRow {
  readonly nodeId: string;
  readonly taskId: string | null;
  readonly lane: DeliveryLane;
  readonly phrase: string;
  readonly pulls: readonly PullSnapshot[];
  /** 进入终态（移出看板）的时刻；不在终态为 `null`。D7 的 24 小时从这里数。 */
  readonly offBoardAtMs: number | null;
}

interface DeliveryState {
  readonly sourceId: string | null;
  readonly workspaceId: string | null;
  readonly boardId: string | null;
  readonly loaded: boolean;
  readonly rows: Readonly<Record<string, DeliveryRow>>;
  refresh: (workspaceId: string, boardId: string) => Promise<void>;
  handleEvent: (event: WorkspaceEvent) => void;
  reset: () => void;
}

export function rowFromNode(node: DeliveryNode): DeliveryRow {
  return {
    nodeId: node.nodeId,
    taskId: node.taskId,
    lane: node.lane,
    phrase: node.phrase,
    pulls: node.pulls,
    // core 给的进入终态时刻；没有这个值的终态条目不显示（设计 D7）。
    offBoardAtMs: node.lane === "offBoard" ? (node.endedAtMs ?? null) : null,
  };
}

/** 终态条目是否还在保留期内。 */
export function offBoardVisible(row: DeliveryRow, now: number): boolean {
  return (
    row.offBoardAtMs !== null && now - row.offBoardAtMs < OFF_BOARD_KEEP_MS
  );
}

let inFlight: { key: string; promise: Promise<void> } | null = null;

export const useDeliveryBoard = create<DeliveryState>((set, get) => ({
  sourceId: null,
  workspaceId: null,
  boardId: null,
  loaded: false,
  rows: {},
  refresh: (workspaceId, boardId) => {
    const sourceId = activeSourceId();
    const key = `${sourceId}:${workspaceId}:${boardId}`;
    if (inFlight?.key === key) return inFlight.promise;
    const same = () =>
      get().sourceId === sourceId &&
      get().workspaceId === workspaceId &&
      get().boardId === boardId;
    if (!same()) {
      set({ sourceId, workspaceId, boardId, loaded: false, rows: {} });
    }
    const promise = deliveryApi
      .board(workspaceId, boardId, sourceById(sourceId))
      .then((answer) => {
        if (!same()) return;
        const rows: Record<string, DeliveryRow> = {};
        for (const node of answer.nodes) {
          rows[node.nodeId] = rowFromNode(node);
        }
        set({ loaded: true, rows });
      })
      .catch(() => {
        // 读不到（旧 core、网络抖动）就保留已有的行；下一帧或重连再读。
        if (same()) set({ loaded: true });
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { key, promise };
    return promise;
  },
  handleEvent: (event) => {
    if (event.type !== "delivery.changed") return;
    const { boardId, workspaceId, rows } = get();
    if (boardId === null || workspaceId === null) return;
    if (event.boardId !== boardId) return;
    if (get().sourceId !== activeSourceId()) return;
    const previous = rows[event.nodeId];
    if (
      previous !== undefined &&
      previous.lane === event.lane &&
      previous.phrase === event.phrase &&
      event.pullsChanged !== true
    ) {
      return;
    }
    const row: DeliveryRow = {
      nodeId: event.nodeId,
      taskId: previous?.taskId ?? null,
      lane: event.lane,
      phrase: event.phrase,
      pulls: previous?.pulls ?? [],
      offBoardAtMs:
        event.lane === "offBoard" ? (previous?.offBoardAtMs ?? null) : null,
    };
    set({ rows: { ...rows, [event.nodeId]: row } });
    // 帧里没有 PR 明细与终态时刻：新节点、PR 变了、刚进终态都读一遍路由补上。
    if (
      previous === undefined ||
      event.pullsChanged === true ||
      (event.lane === "offBoard" && previous.offBoardAtMs === null)
    ) {
      void get().refresh(workspaceId, boardId);
    }
  },
  reset: () => {
    inFlight = null;
    set({
      sourceId: null,
      workspaceId: null,
      boardId: null,
      loaded: false,
      rows: {},
    });
  },
}));
