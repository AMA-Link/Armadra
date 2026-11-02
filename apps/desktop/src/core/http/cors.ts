/**
 * Which origins a loopback core answers, and what it answers them with.
 *
 * The portless forms matter for the Unix socket and named pipe transports: a
 * caller that reached the core over one of those has no port to name. It is
 * still a loopback literal — this never widens to a hostname the network could
 * resolve, because a hostname is whatever somebody's `/etc/hosts` says.
 *
 * Ported from the pre-merge implementation.
 */
export function isLoopbackOrigin(origin: string): boolean {
  return (
    origin.startsWith("http://127.0.0.1:") ||
    origin.startsWith("http://localhost:") ||
    origin === "http://127.0.0.1" ||
    origin === "http://localhost"
  );
}

export const CORS_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
/**
 * `authorization`：桌面壳的页面跨端口打 core（页面在壳的静态服务上），GitHub 与
 * 自动化两面要它带票据换来的 Bearer（契约 §3.2，安全审查 L9）。它不在 CORS 的
 * 安全名单上，不在这里列出，浏览器的预检就把带它的请求拦掉。
 *
 * `x-armadra-csrf`：Bearer 模式的刷新与登出可以带着会话的 CSRF 密钥（契约 §17.4，
 * core 不核它）。不放行时预检把整次刷新拦掉，页面每个访问期都重新配对一次、多出
 * 一条会话（#706）；Gateway 与中继的预检本来就放行它。
 */
export const CORS_HEADERS = "content-type, authorization, x-armadra-csrf";

/**
 * 壳注入的额外允许来源。
 *
 * 回环之外的来源只有一种情况存在：服务器壳把页面托管在一个配置好的 HTTPS 来源
 * 上（R6a）。那个来源是运维给的（`--public-origin`）或监听地址本身，core 自己
 * 无从知道，所以由壳在绑定之后注入一次。桌面壳永远不调用它。
 *
 * 判定仍然只有 {@link corsHeaders} 与 {@link websocketOriginAllowed} 两处，这
 * 里只是把它们认的集合变成「回环 ∪ 壳声明的那几个」——注入的是数据，不是第二
 * 套规则。
 */
let injected: readonly string[] = [];

export function allowOrigins(origins: readonly string[]): void {
  injected = [...new Set(origins)];
}

/** 这次运行额外放行的来源，按注入时的去重结果。 */
export function allowedOrigins(): readonly string[] {
  return injected;
}

function answerable(origin: string): boolean {
  return isLoopbackOrigin(origin) || injected.includes(origin);
}

/**
 * The CORS headers for one request, or nothing when the origin is not one we
 * answer. A request with no `Origin` header is not a browser request and needs
 * no headers; refusing it would break `curl` and the shell's own probe.
 */
export function corsHeaders(
  origin: string | undefined,
): Record<string, string> | undefined {
  if (origin === undefined) return {};
  if (!answerable(origin)) return undefined;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": CORS_METHODS,
    "access-control-allow-headers": CORS_HEADERS,
    vary: "origin",
  };
}

/**
 * A WebSocket upgrade must name an origin, and it must be one of ours. Unlike
 * a `fetch`, the browser sends no preflight for a WebSocket, so this check is
 * the only thing between a page on any origin and the core's streams.
 */
export function websocketOriginAllowed(origin: string | undefined): boolean {
  return origin !== undefined && answerable(origin);
}
