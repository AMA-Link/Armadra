import type { MockApi } from "./create-mock-client";

/**
 * 给 `trust.list` 的每条请求补上 core 的 `pendingId`（`pending_<requestId>`）。mock 的请求缺省不带它（同旧云端），
 * 页面又只在带 `pendingId` 时才给「信任」，所以展示页与测试用它模拟云端下发了它的形状。
 */
export function addPendingIds(api: MockApi): MockApi {
  const list = api.client.trust.list;
  api.client.trust.list = (async (...args: Parameters<typeof list>) => {
    const answer = await list(...args);
    return {
      ...answer,
      requests: answer.requests.map((request) => ({
        ...request,
        pendingId: `pending_${request.requestId}`,
      })),
    };
  }) as typeof list;
  return api;
}
