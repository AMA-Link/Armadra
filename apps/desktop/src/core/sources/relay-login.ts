/**
 * 经中继登录别的电脑（契约 §31.3、§88.2），从 `service.ts` 拆出来的两件事：
 *
 * - {@link loginAtRelay}：用断言 `cloud/login`，带上这条路存着的刷新令牌——Armadra 云的
 *   限寿会话由对端在同一会话 id 上续，长连接不断。成功写回新令牌、纠正分享信息与归属；
 *   被明确拒绝才删存着的令牌，待确认、限流、不在线、连不上都留着。
 * - {@link pageConnectOrigins}：服务器壳页面要直接连的来源（Gateway 给 CSP 追加授权用）。
 */

import { CoreFailure } from "../http/errors";
import type {
  RemoteClient,
  RemoteEndpoint,
  SourceAssertion,
} from "./remote-client";
import { shareColumns } from "./rows";
import { refreshMountedAttribution } from "./saas-mount";
import type { SourceSecrets } from "./secrets";
import type {
  NativeCredentials,
  SourceAddress,
  SourceClient,
} from "./source-client";
import type { RemoteRow, SourcesStore } from "./store";

/** 重登时这几种失败不删存着的刷新令牌：放行、恢复或稍后还要拿它续同一会话。 */
const TRANSIENT = new Set([
  "device_pending",
  "rate_limited",
  "source_offline",
  "source_unreachable",
]);

function refused(error: unknown): boolean {
  return error instanceof CoreFailure && !TRANSIENT.has(error.code);
}

export interface RelayLoginDeps {
  readonly store: SourcesStore;
  readonly secrets: SourceSecrets;
  readonly peer: SourceClient;
  readonly remote: RemoteClient;
}

export interface RelayLoginInput {
  readonly sourceId: string;
  /** 凭据键：这条路的来源（契约 §55）。 */
  readonly key: string;
  readonly address: SourceAddress;
  readonly assertion: SourceAssertion;
  /** 签发断言的远程服务。 */
  readonly service: RemoteRow;
  readonly endpoint: RemoteEndpoint;
  /** 远程服务缓存着的访问令牌（纠正归属时问目录用）。 */
  readonly access: { accessToken: string } | undefined;
}

/** 调用方负责串行（同一把刷新令牌一次只用一次）。 */
export async function loginAtRelay(
  deps: RelayLoginDeps,
  input: RelayLoginInput,
): Promise<NativeCredentials> {
  const { sourceId, key } = input;
  const stored = (await deps.secrets.source(sourceId)).byOrigin[key];
  let logged: NativeCredentials;
  try {
    logged = await deps.peer.cloudLogin(
      input.address,
      input.assertion.assertion,
      undefined,
      stored?.refreshToken,
    );
  } catch (error) {
    // 明确的拒绝：这把刷新令牌续不上了，留着只会让下一次再撞一次。
    if (stored !== undefined && refused(error)) {
      await deps.secrets.putSource(sourceId, key, undefined);
    }
    throw error;
  }
  await deps.secrets.putSource(sourceId, key, {
    refreshToken: logged.refreshToken,
    deviceId: logged.deviceId,
  });
  // 分享方可能改了角色或到期（契约 §68）；只改 shared 的行。
  if (logged.share !== undefined) {
    deps.store.setShare(sourceId, shareColumns(logged.share));
  }
  // 归属与团队随断言变：Armadra 云的主机按自己的云纠正。
  await refreshMountedAttribution(
    deps.remote,
    deps.store,
    input.service,
    input.access,
    input.assertion,
    { endpoint: input.endpoint, sourceId },
    logged.share,
  );
  return logged;
}

/**
 * 服务器壳页面要直接连的来源（契约 §88.1）：远程服务的签发方（`me.stream`）与挂上的
 * 源的每条路（中继或直连）。只读 SQLite。
 */
export function pageConnectOrigins(store: SourcesStore): string[] {
  const origins = new Set<string>();
  for (const remote of store.remotes()) origins.add(remote.issuer);
  for (const row of store.list()) {
    if (row.kind === "local") continue;
    if (row.baseUrl !== "") origins.add(row.baseUrl);
    if (row.relayOrigin !== "") origins.add(row.relayOrigin);
  }
  for (const routes of store.allRoutes().values())
    for (const route of routes) origins.add(route.origin);
  return [...origins];
}
