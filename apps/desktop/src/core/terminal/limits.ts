import type { DatabaseSync } from "node:sqlite";
import { fail } from "../http/errors";
import { isOwner } from "../identity/authorize";
import { currentSubject } from "../identity/gate";
import type { SpawnRequest } from "./spawn-request";

/** `limits.terminalsPerPrincipal` / `limits.agentsPerWorkspace`；`0` = 不限。 */
export interface CoreLimits {
  readonly terminalsPerPrincipal: number;
  readonly agentsPerWorkspace: number;
}

/**
 * 单台 core 的上限（平台设计 A6-2，契约 §85）：一个成员（非 owner 的
 * principal）名下运行中的终端、一个工作空间里运行中的 Agent 会话。超出答
 * `429 limit_reached { scope, limit, current }`。owner 与 core 自己开的不受终端
 * 数限制（没有 principal），Agent 数对谁都算。同一节点重新起会话不重复计。
 */
export function enforceLimits(
  database: DatabaseSync,
  limits: CoreLimits | undefined,
  request: SpawnRequest,
): void {
  if (limits === undefined) return;
  const count = (sql: string, ...params: (string | null)[]): number =>
    Number((database.prepare(sql).get(...params) as { n: number }).n);
  if (request.agentId !== undefined) {
    const limit = limits.agentsPerWorkspace;
    if (limit <= 0) return;
    const current = count(
      "SELECT COUNT(*) AS n FROM terminal_sessions WHERE workspace_id = ? " +
        "AND status = 'running' AND agent_id IS NOT NULL " +
        "AND (owner_node_id IS NULL OR owner_node_id IS NOT ?)",
      request.workspaceId,
      request.ownerNodeId ?? null,
    );
    if (current >= limit) {
      throw fail(
        "limit_reached",
        `这个工作空间最多同时运行 ${limit} 个 Agent`,
        { scope: "workspace", limit, current },
      );
    }
    return;
  }
  const subject = currentSubject();
  const limit = limits.terminalsPerPrincipal;
  if (isOwner(subject) || subject.principalId === "" || limit <= 0) return;
  const current = count(
    "SELECT COUNT(*) AS n FROM terminal_sessions WHERE creator_principal_id = ? " +
      "AND status = 'running' AND agent_id IS NULL",
    subject.principalId,
  );
  if (current >= limit) {
    throw fail("limit_reached", `每个成员最多同时打开 ${limit} 个终端`, {
      scope: "principal",
      limit,
      current,
    });
  }
}
