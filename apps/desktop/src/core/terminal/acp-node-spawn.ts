import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  acpAdapter,
  agentSettings as acpAgentSettings,
  prepareAcpStart,
  sshHostOf,
} from "../acp";
import { acpSpawnOnce } from "../acp/routes";
import { baseAgent } from "../agent/registry";
import { loadNode } from "../collab/nodes";
import type { EnvPairs } from "./environment";
import type { TerminalManager, TerminalSession } from "./manager";

export interface AcpNodeSpawnRequest {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly cwd: string;
}

/**
 * 替一个 ACP 节点起会话（依赖编排、定时冷启动）：新开，第一条任务经投递。
 *
 * 与页面挂载时的 `createSession` 走同一把节点锁，节点已经有活着的 ACP 行就复用
 * （#1077）：会话页新建的会话既由依赖编排起，又被会话页挂载，两条路以前各起一个
 * 适配器。
 */
export function spawnAcpNode(
  database: DatabaseSync,
  manager: TerminalManager,
  environment: (nodeId: string, agentId: string, ssh: boolean) => EnvPairs,
  request: AcpNodeSpawnRequest,
): Promise<TerminalSession> {
  return acpSpawnOnce(database, manager, request.nodeId, () => {
    const data = loadNode(database, request.nodeId)?.data;
    const ssh = sshHostOf(data) !== undefined;
    const agent = data?.agent as Record<string, unknown> | undefined;
    prepareAcpStart(request.nodeId, {
      agentId: request.agentId,
      permissionMode:
        typeof agent?.permissionMode === "string"
          ? agent.permissionMode
          : undefined,
      model: typeof agent?.model === "string" ? agent.model : undefined,
      resume: null,
    });
    return manager.spawn({
      workspaceId: request.workspaceId,
      // 执行主机上的路径不按本机的规则解析。
      cwd: ssh ? request.cwd : resolve(request.cwd),
      command: acpAdapter(baseAgent(acpAgentSettings(), request.agentId))
        ?.program,
      kind: "terminal",
      ownerNodeId: request.nodeId,
      agentId: request.agentId,
      backend: "acp",
      env: environment(request.nodeId, request.agentId, ssh),
    });
  });
}
