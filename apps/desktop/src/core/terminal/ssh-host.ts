import type { DatabaseSync } from "node:sqlite";

/**
 * 一个终端节点连的是哪台 SSH 主机：节点数据里的 `ssh.hostId`。
 *
 * 全 core 只有这一处读它——`acp/ssh.ts`、`resources/sessions.ts`、终端管理器接回
 * 会话时各写过一份，格式一变就会有一份没跟上。
 */

/** 节点数据里的 `ssh.hostId`；不是 SSH 节点答 `undefined`。 */
export function sshHostOfData(
  data: Record<string, unknown> | undefined,
): string | undefined {
  const ssh = data?.ssh;
  if (ssh === null || typeof ssh !== "object") return undefined;
  const hostId = (ssh as { hostId?: unknown }).hostId;
  return typeof hostId === "string" && hostId !== "" ? hostId : undefined;
}

/** 同上，按节点 id 查库；节点不存在、库读不了都答 `undefined`。 */
export function sshHostOfNode(
  database: DatabaseSync,
  nodeId: string | null,
): string | undefined {
  if (nodeId === null) return undefined;
  try {
    const row = database
      .prepare(
        "SELECT json_extract(data_json, '$.ssh.hostId') AS host_id FROM nodes WHERE id = ?",
      )
      .get(nodeId) as { host_id?: unknown } | undefined;
    const hostId = row?.host_id;
    return typeof hostId === "string" && hostId !== "" ? hostId : undefined;
  } catch {
    return undefined;
  }
}
