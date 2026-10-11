import type { E2eChannels } from "./manager";

/**
 * 测试用的「通道」：不握手，`fetchFor`/`socketFor` 直接答给定的那一个，好让只关心
 * 访问流程的用例照旧用路由假网络。
 */
export function plainE2e(
  fetch: typeof globalThis.fetch,
  WebSocket: typeof globalThis.WebSocket = globalThis.WebSocket,
): E2eChannels {
  const stub = {
    channel: async () => ({ sas: "000000" }),
    fetchFor: () => fetch,
    socketFor: () => WebSocket,
    awaitApproval: async () => true as const,
    pinned: () => true,
    forget: () => undefined,
    close: () => undefined,
  };
  return stub as unknown as E2eChannels;
}
