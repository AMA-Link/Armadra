import type { DatabaseSync } from "node:sqlite";
import type { DeliveryBoardResponse } from "@armadra/shared";
import { getBoard } from "../canvas/boards";
import type { CoreServer } from "../http/server";
import { answered, workspaceId } from "../workspaces/routes";
import { agentNodesOfBoard, deliveryNode } from "./delivery-facts";

/**
 * 交付状态路由（Armadra#988）：一块画板上带 Agent 的终端节点各自的栏、短语与
 * 名下的 PR 快照。首读与重连后重读用它；之后靠 `delivery.changed` 帧增量更新。
 *
 * 权限：路由门按 `http/route-scopes.ts` 的 `/api/workspaces/…/boards` 一行判
 * `canvas:read`；画板必须属于路径里的工作空间，否则 404。
 */

export const DELIVERY_PATH =
  "/api/workspaces/{workspaceId}/boards/{boardId}/delivery";

export function boardDelivery(
  database: DatabaseSync,
  ws: string,
  boardId: string,
  nowMs: number,
): DeliveryBoardResponse {
  getBoard(database, ws, boardId);
  return {
    nodes: agentNodesOfBoard(database, boardId).map((nodeId) => {
      const view = deliveryNode(database, nodeId, nowMs);
      return {
        nodeId,
        taskId: view.taskId,
        lane: view.status.lane,
        phrase: view.status.phrase,
        // 快照类型是只读的，线上 schema 推出的是可写的：同一个形状。
        pulls: [
          ...view.pulls,
        ] as DeliveryBoardResponse["nodes"][number]["pulls"],
        endedAtMs: view.endedAtMs,
      };
    }),
  };
}

export function installDeliveryRoutes(
  server: CoreServer,
  options: { readonly database: DatabaseSync; readonly now?: () => number },
): void {
  const now = options.now ?? Date.now;
  server.router.handle(
    "GET",
    DELIVERY_PATH,
    answered((match) => ({
      status: 200,
      body: boardDelivery(
        options.database,
        workspaceId(match),
        match.params.boardId as string,
        now(),
      ),
    })),
  );
}
