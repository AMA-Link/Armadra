import type { RouteEntry } from "./routes";

/**
 * 端到端通道的路由（契约 §77 设备钥登记、§78 通道）：设备登记只有 owner；身份公钥
 * 与等候匿名；本机设备钥签名只在回环。`ROUTES` 在原位置展开它。
 */
export const E2E_ROUTES: readonly RouteEntry[] = (
  [
    ["/api/devices", ["GET"]],
    ["/api/devices/approve", ["POST"]],
    ["/api/devices/reject", ["POST"]],
    ["/api/devices/revoke", ["POST"]],
    ["/api/devices/forget", ["POST"]],
    ["/api/devices/rename", ["POST"]],
    ["/api/e2e/identity", ["GET"]],
    ["/api/e2e/wait", ["POST"]],
    ["/api/e2e/sign", ["POST"]],
    ["/api/e2e/sources/wait", ["POST"]],
    ["/api/e2e/pairing-secret", ["POST"]],
  ] as const
).map(([path, methods]) => ({
  path,
  methods,
  surface: "runtime",
  implemented: true,
}));
