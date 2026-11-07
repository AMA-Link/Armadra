import type { CanvasNodeData } from "@armadra/shared";

import { currentPresence, currentRealtime } from "./presence";
import type { CanvasState } from "./types";

/**
 * 实时板放行写入之前的系统写回队列。
 *
 * 实时板在同步层放行写入前是只读的（`isReadOnly`），经高延迟中继时这一段能
 * 持续好几秒。这期间用户的编辑照旧不落；但终端的 `sessionId`、上一次退出码这类
 * 系统写回（`history: "ignore"`）不是用户在改东西，丢了就没法接回会话。所以
 * 它们在这里按节点合并排队，同步层一放行就补写，节点没了就丢。
 *
 * 排队只是「晚一点写」，不授予任何权限：补写走的仍是 `updateNodeData`，
 * 那里会再判一次只读。访客与只读链接的同步层永远不放行，队列也就永远不落。
 */

/** 队列里最多留这么多个节点；超出时丢最早排进来的。 */
export const MAX_QUEUED_NODES = 256;

interface Queued {
  boardId: string;
  patches: Map<string, Partial<CanvasNodeData>>;
}

let queued: Queued | null = null;

type DeferState = Pick<CanvasState, "boardId" | "presence"> &
  Partial<Pick<CanvasState, "realtime">>;

/**
 * 这次写回该不该先排着：板在实时、同步层还没放行，并且不是服务器明确说了
 * 没有写权限（那种永远写不了，排着没有意义）。
 */
export function shouldDeferWriteBack(state: DeferState): boolean {
  const live = currentRealtime(state);
  if (!live || live.writable) return false;
  return currentPresence(state)?.writable !== false;
}

/** 排一条写回；同一节点的多条按先后合并。 */
export function deferWriteBack(
  boardId: string,
  nodeId: string,
  patch: Partial<CanvasNodeData>,
): void {
  if (!queued || queued.boardId !== boardId) {
    queued = { boardId, patches: new Map() };
  }
  const merged = {
    ...queued.patches.get(nodeId),
    ...patch,
  } as Partial<CanvasNodeData>;
  // 先删再放：被更新的节点排到队尾，满了丢的是最久没动的。
  queued.patches.delete(nodeId);
  queued.patches.set(nodeId, merged);
  while (queued.patches.size > MAX_QUEUED_NODES) {
    const oldest = queued.patches.keys().next().value;
    if (oldest === undefined) break;
    queued.patches.delete(oldest);
  }
}

/**
 * 取走这块板排着的写回并清空队列。别的画布的条目一并丢掉：切板之后补写到
 * 另一块板上是错的。
 */
export function takeWriteBacks(
  boardId: string,
): [string, Partial<CanvasNodeData>][] {
  const taken = queued && queued.boardId === boardId ? queued.patches : null;
  queued = null;
  return taken ? [...taken] : [];
}

/** 丢掉排着的全部写回（切板、停实时）。 */
export function clearWriteBacks(): void {
  queued = null;
}

/** 仅测试用：此刻排着几个节点。 */
export function queuedWriteBackCount(): number {
  return queued?.patches.size ?? 0;
}
