import { create } from "zustand";
import {
  deliveryChangedPayloadSchema,
  type DeliveryLane,
  type DeliveryNode,
  type DeliveryPull,
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
  readonly pulls: readonly DeliveryPull[];
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

/** 终态的起点：最后一次读到的 PR 时间（终态一旦记下就不再轮询），没有就取现在。 */
function offBoardSince(node: DeliveryNode, now: number): number | null {
  if (node.lane !== "offBoard") return null;
  const fetched = node.pulls.map((pull) => pull.fetchedAtMs);
  return fetched.length === 0 ? now : Math.max(...fetched);
}

export function rowFromNode(
  node: DeliveryNode,
  now: number,
  previous?: DeliveryRow,
): DeliveryRow {
  const since =
    node.lane !== "offBoard"
      ? null
      : previous?.lane === "offBoard" && previous.offBoardAtMs !== null
        ? previous.offBoardAtMs
        : offBoardSince(node, now);
  return {
    nodeId: node.nodeId,
    taskId: node.taskId,
    lane: node.lane,
    phrase: node.phrase,
    pulls: node.pulls,
    offBoardAtMs: since,
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
        const now = Date.now();
        const rows: Record<string, DeliveryRow> = {};
        for (const node of answer.nodes) {
          rows[node.nodeId] = rowFromNode(node, now, get().rows[node.nodeId]);
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
    if ((event as { type: string }).type !== "delivery.changed") return;
    const parsed = deliveryChangedPayloadSchema.safeParse(event);
    if (!parsed.success) return;
    const change = parsed.data;
    const { boardId, workspaceId, rows } = get();
    if (boardId === null || workspaceId === null) return;
    if (change.boardId !== boardId) return;
    if (get().sourceId !== activeSourceId()) return;
    const previous = rows[change.nodeId];
    if (
      previous !== undefined &&
      previous.lane === change.lane &&
      previous.phrase === change.phrase &&
      change.pullsChanged !== true
    ) {
      return;
    }
    const now = Date.now();
    const row: DeliveryRow = {
      nodeId: change.nodeId,
      taskId: previous?.taskId ?? null,
      lane: change.lane,
      phrase: change.phrase,
      pulls: previous?.pulls ?? [],
      offBoardAtMs:
        change.lane !== "offBoard" ? null : (previous?.offBoardAtMs ?? now),
    };
    set({ rows: { ...rows, [change.nodeId]: row } });
    // 新出现的节点没有 PR 明细，PR 变了也一样：读一遍路由补上。
    if (previous === undefined || change.pullsChanged === true) {
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
