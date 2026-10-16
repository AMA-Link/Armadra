/**
 * 托管平台域 W-FORGE：把 GitHub 面推广到 Gitea / Forgejo 与 GitLab（外部服务
 * §10.2、G5 计划 §3 G5-14 / G5-15）。
 *
 * 边界：
 *   * `/api/forge/*` 与 `/api/github/*` 同一档权限（`http/route-scopes.ts`）。
 *   * 令牌只经 SecretStore（`armadra-forge-<id>`），不进库、设置文档与响应。
 *   * 外呼只到用户配置的地址（`net/outbound.ts` 的 `forgeApi`）。契约 §29。
 *   * `/api/github/*` 不改：GitHub 仓库经 {@link GithubForge} 用同一个客户端与凭据。
 */

import type { EventBus } from "../bus";
import type { CoreContext } from "../main";
import { githubDomain } from "../github";
import { secretsFor } from "../secrets";
import { installRoutes } from "./routes";
import { ForgeService } from "./service";
import { ForgeStore } from "./store";

export { FORGE_ROUTES, forgeFailure } from "./routes";
export {
  ForgeService,
  configKey,
  forgeRepo,
  type ForgeDetection,
  type PublicForgeConfig,
} from "./service";
export { ForgeStore } from "./store";
export { GiteaForge, giteaApiBase, giteaWebRoot, splitDiff } from "./gitea";
export {
  GITLAB_SCOPE_ERRORS,
  GitlabForge,
  gitlabApiBase,
  gitlabRefusal,
  gitlabWebRoot,
} from "./gitlab";
export { GithubForge } from "./github";
export * from "./types";

/**
 * 工作空间移除时，它的配置行随外键删掉，行指着的令牌条目要一并从密钥存储里
 * 清掉：移除前记下引用，确认移除后再删（移除失败时配置与令牌都在）。
 */
export function watchWorkspaceRemoval(
  bus: EventBus,
  service: ForgeService,
): () => void {
  const pending = new Map<string, string[]>();
  const offRemoving = bus.on("workspace.removing", ({ workspaceId }) => {
    pending.set(workspaceId, service.workspaceCredentialRefs(workspaceId));
  });
  const offGrants = bus.on(
    "workspace.grants",
    ({ workspaceId, permissions }) => {
      if (permissions !== null) return;
      const references = pending.get(workspaceId);
      pending.delete(workspaceId);
      if (references === undefined || references.length === 0) return;
      void service.dropWorkspaceSecrets(references);
    },
  );
  return () => {
    offRemoving();
    offGrants();
  };
}

export function install(context: CoreContext): ForgeService | undefined {
  // 配置在库里：没过统一库迁移的库没有 `forge_config`，路由留着答 501。
  if (!context.db.unified) {
    context.log.info("托管平台域未装配：统一库迁移尚未应用");
    return undefined;
  }
  const service = new ForgeService({
    store: new ForgeStore(context.db.database),
    secrets: () => secretsFor(context).backend,
    github: () => githubDomain()?.service,
  });
  installRoutes(context.server, service);
  watchWorkspaceRemoval(context.bus, service);
  // GitHub 域的外部连接经这里核对 Gitea / GitLab 仓库（`ExternalReference.forge`）。
  const github = githubDomain()?.service;
  if (github !== undefined) {
    github.externalRepository = (forge, ref, workspaceId) =>
      service.referenceRepository(forge, ref, workspaceId);
  }
  context.log.info("托管平台域已装配");
  return service;
}
