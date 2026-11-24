import {
  deliveryBoardResponseSchema,
  type DeliveryBoardResponse,
} from "@armadra/shared";

import type { Source } from "@/api/source";
import { activeSource, srcPrefix } from "@/sources/scope";

/**
 * 交付看板的调用面：`GET /api/workspaces/:workspaceId/boards/:boardId/delivery`。
 * 答复按 shared 的 schema 解析；旧 core 没有这条路由（404）时按空看板处理，
 * 其余错误抛出，由 store 决定是否重试。
 */
export const deliveryApi = {
  async board(
    workspaceId: string,
    boardId: string,
    source: Source = activeSource(),
  ): Promise<DeliveryBoardResponse> {
    const url = `${source.httpBase}/api/workspaces/${encodeURIComponent(workspaceId)}/boards/${encodeURIComponent(boardId)}/delivery`;
    const response = await source.fetch(url);
    if (response.status === 404) return { nodes: [] };
    if (!response.ok) throw new Error(`delivery ${response.status}`);
    return deliveryBoardResponseSchema.parse(await response.json());
  },
};

export const deliveryKeys = {
  board: (boardId: string) => [...srcPrefix(), "delivery", boardId] as const,
};
