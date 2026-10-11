/**
 * 更新域（契约 §64）：`GET /api/updates/releases`——这台 core 看到的发布历史与
 * 最新版本。
 *
 * 只有 core 碰 GitHub；页面（桌面窗口、服务器壳网页、手机）都问这里。取数与
 * 缓存在 `service.ts`，解析、排序、通道过滤在 `releases.ts`。下载与安装是壳的事
 * （桌面壳 `shell-core/updates`、手机原生插件），不在这里。
 *
 * 授权：`updates:read`。owner 与配对的设备有全量授权；服务器壳上的成员按
 * 「无害的全局读」放行（`identity/route-access.ts` 的 `SHARED_READS`）。
 */

import { UPDATES_RELEASES_PATH, type UpdateChannel } from "@armadra/shared";

import { failureResult, CoreFailure } from "../http/errors";
import type { HandlerResult } from "../http/router";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import type { CoreServer } from "../http/server";
import type { CoreContext } from "../main";
import { settingsDomain } from "../settings";
import { ReleaseService, type ReleaseServiceOptions } from "./service";

export { ReleaseService, RELEASES_REPO, releasesUrl } from "./service";

/** `?refresh=1` / `{ refresh: true }`：真值才算。 */
export function wantsRefresh(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

/** 设置里的 `updates.channel`；没有设置域或不认识的值按 `stable`。 */
export function currentChannel(): UpdateChannel {
  return settingsDomain()?.settings.get("updates.channel") === "beta"
    ? "beta"
    : "stable";
}

/** 把一份 {@link ReleaseService} 挂到旧路径与 procedure 上。 */
export function installRoutes(server: CoreServer, service: ReleaseService) {
  registerProcedures(server, "updates", {
    releases: (input) => service.releases(wantsRefresh(input?.refresh)),
  } satisfies DomainHandlers<"updates">);

  // 路由表里的同一条路径：RPC 门面没装时的回落，调的是同一份实现。
  server.router.handle(
    "GET",
    UPDATES_RELEASES_PATH,
    async (_match, request): Promise<HandlerResult> => {
      try {
        return {
          status: 200,
          body: await service.releases(
            wantsRefresh(request.query.get("refresh") ?? undefined),
          ),
        };
      } catch (error) {
        if (error instanceof CoreFailure) return failureResult(error);
        throw error;
      }
    },
  );
}

export function install(
  context: CoreContext,
  overrides: Partial<ReleaseServiceOptions> = {},
): ReleaseService {
  const service = new ReleaseService({
    current: context.platform.appVersion,
    channel: currentChannel,
    log: context.log,
    ...overrides,
  });
  installRoutes(context.server, service);
  return service;
}
