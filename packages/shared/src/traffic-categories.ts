/**
 * 流量统计的类别表（契约 §76）：core 的计量（`core/traffic/`）与客户端自己的计量
 * 共用这一份，两端按同一个口径分类，数字才对得上。
 *
 * 按隧道 `OPEN` 里的路径前缀判，顺序匹配，第一条中的算数；`kind`（`http` / `ws`）
 * 先收着，同一路径两种流目前归同一类。路径只用于匹配，不落库、不进日志。
 *
 * `transport` 不是由路径判出来的：它是通道级的线上字节（隧道 WebSocket 消息的
 * 载荷），由计量直接记。
 */

export const TRAFFIC_CATEGORIES = [
  "transport",
  "api",
  "terminal",
  "events",
  "canvas",
  "files",
  "agent",
  "other",
] as const;

export type TrafficCategory = (typeof TRAFFIC_CATEGORIES)[number];

/** 内层流的类别（不含 `transport`）。 */
export type StreamTrafficCategory = Exclude<TrafficCategory, "transport">;

export type TrafficStreamKind = "http" | "ws";

/** 契约门面 `/api/rpc/<域>/<动词>` 按域归类；不在表里的域算 `api`。 */
const RPC_DOMAINS: Readonly<Record<string, StreamTrafficCategory>> = {
  terminals: "terminal",
  boards: "canvas",
  files: "files",
  acp: "agent",
  agents: "agent",
};

const WORKSPACE_FILES = new Set([
  "files",
  "file-download",
  "imports",
  "assets",
  "exports",
  "agent-uploads",
]);

/** 去掉查询串与片段；分类不看它们。 */
function pathOnly(path: string): string {
  let end = path.length;
  const query = path.indexOf("?");
  if (query !== -1) end = query;
  const hash = path.indexOf("#");
  if (hash !== -1 && hash < end) end = hash;
  return path.slice(0, end);
}

/**
 * 一条内层流的类别。规则（与 core 路由表对过，2026-10-12）：
 *
 *   1. `/api/terminals/{id}/ws` → terminal；
 *   2. `/api/ws`（控制面，含事件订阅）与 `/api/workspaces/{id}/events` → events；
 *   3. `/api/workspaces/{id}/boards/**`（文档、同步 WS、实时、在场、评论）→ canvas；
 *   4. `/api/workspaces/{id}/{files,file-download,imports,assets,exports,agent-uploads}/**`、
 *      `/api/media/*`、`/api/data/backup` → files；
 *   5. `/api/acp/**`、`/api/agents/**`、`/api/agent-status/**` → agent；
 *   6. `/api/terminals/**` → terminal；`/api/rpc/<域>/*` 按域归类；
 *   7. 其余 `/api` 与 `/api/**` → api；都不中 → other。
 */
export function trafficCategory(
  _kind: TrafficStreamKind,
  rawPath: string,
): StreamTrafficCategory {
  const path = pathOnly(rawPath);
  if (path !== "/api" && !path.startsWith("/api/")) return "other";
  const parts = path.split("/").slice(2);
  const [head = "", second = "", third = "", fourth = ""] = parts;
  switch (head) {
    case "terminals":
      return "terminal";
    case "ws":
      return parts.length === 1 ? "events" : "api";
    case "media":
      return "files";
    case "data":
      return second === "backup" ? "files" : "api";
    case "acp":
    case "agents":
    case "agent-status":
      return "agent";
    case "rpc":
      return RPC_DOMAINS[second] ?? "api";
    case "workspaces": {
      if (second === "" || third === "") return "api";
      if (third === "events") return "events";
      if (third === "boards" && fourth !== "") return "canvas";
      if (WORKSPACE_FILES.has(third)) return "files";
      return "api";
    }
    default:
      return "api";
  }
}
