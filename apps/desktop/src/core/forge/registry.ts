import type { ForgeService } from "./service";

/**
 * 当前装配好的托管平台服务。工作项绑定的 PR（契约 §103）要认仓库、读 PR，而协作
 * 域与工作流域都不该 import 整个装配：这里只放一个读取点，`install` 设、停机清。
 */
let current: ForgeService | undefined;

export function setForgeService(service: ForgeService | undefined): void {
  current = service;
}

export function forgeService(): ForgeService | undefined {
  return current;
}

import type { WorkspaceRepositoryService } from "./workspace";

let currentWorkspaces: WorkspaceRepositoryService | undefined;

/** 工作空间 → 仓库解析（契约 §111.1）；PR 绑定经它认「选中的 remote」。 */
export function setWorkspaceRepository(
  service: WorkspaceRepositoryService | undefined,
): void {
  currentWorkspaces = service;
}

export function workspaceRepository(): WorkspaceRepositoryService | undefined {
  return currentWorkspaces;
}
