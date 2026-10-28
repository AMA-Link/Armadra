/**
 * 经中继登录别的电脑（契约 §31.3、§88.2），从 `service.ts` 拆出来的两件事：
 *
 * - {@link loginAtRelay}：用断言 `cloud/login`，带上这条路存着的刷新令牌——Armadra 云的
 *   限寿会话由对端在同一会话 id 上续，长连接不断。成功写回新令牌、纠正分享信息与归属；
 *   被明确拒绝才删存着的令牌，待确认、限流、不在线、连不上都留着。
 * - {@link pageConnectOrigins}：服务器壳页面要直接连的来源（Gateway 给 CSP 追加授权用；
 *   直连地址只给 owner）。
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

/**
 * 重登被这几种失败拒绝才删存着的刷新令牌（白名单）：对端或远程服务明确说这把会话不能再用。
 * 其余（待确认、限流、不在线、连不上、5xx、`forbidden`、`bad_request`……）一律按暂时性，
 * 留着它，放行或恢复后还要拿它续同一会话。
 */
export const RELOGIN_REFUSALS: ReadonlySet<string> = new Set([
  "source_unauthorized",
  "device_rejected",
  "cloud_account_unlinked",
  "cloud_not_registered",
  "source_revoked",
  "source_access_denied",
  "source_access_revoked",
]);

function refused(error: unknown): boolean {
  return error instanceof CoreFailure && RELOGIN_REFUSALS.has(error.code);
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
    // 白名单里的明确拒绝：这把刷新令牌续不上了，留着只会让下一次再撞一次。
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
 * 经中继换一份原生会话（契约 §88.2）：先用存着的刷新令牌；对端答 401（Armadra 云的限寿
 * 会话临近到期就这样答）时不删它，带着它 `cloud/login` 重登、续同一会话。`relogin`：
 * 跳过刷新直接重登。调用方负责把整段放进同一把锁里。
 */
export async function renewAtRelay(
  deps: RelayLoginDeps,
  input: RelayLoginInput,
  relogin: boolean,
): Promise<NativeCredentials> {
  if (!relogin) {
    const stored = (await deps.secrets.source(input.sourceId)).byOrigin[
      input.key
    ];
    if (stored !== undefined) {
      try {
        const fresh = await deps.peer.refresh(
          input.address,
          stored.refreshToken,
        );
        await deps.secrets.putSource(input.sourceId, input.key, {
          refreshToken: fresh.refreshToken,
          deviceId: fresh.deviceId || stored.deviceId,
        });
        return fresh;
      } catch (error) {
        if (
          !(error instanceof CoreFailure) ||
          error.code !== "source_unauthorized"
        )
          throw error;
      }
    }
  }
  return loginAtRelay(deps, input);
}

/**
 * 同一条路上并发换票的合并（契约 §88.2）：排队期间别人已经换过一份、那份访问还新鲜，
 * 就直接用它——再刷新一次会旋转会话、作废刚发给前一个调用方的访问令牌，再重登一次还会
 * 多扣对端 `cloud/login` 的额度。要重登（授予变了）的只复用重登换来的那份。
 */
export class RelayExchanges {
  private readonly last = new Map<
    string,
    { gen: number; relogin: boolean; credentials: NativeCredentials }
  >();

  generation(key: string): number {
    return this.last.get(key)?.gen ?? 0;
  }

  shared(
    key: string,
    since: number,
    relogin: boolean,
    freshUntil: number,
  ): NativeCredentials | undefined {
    const last = this.last.get(key);
    if (
      last === undefined ||
      last.gen === since ||
      (relogin && !last.relogin) ||
      last.credentials.accessExpiresAtMs <= freshUntil
    )
      return undefined;
    return last.credentials;
  }

  record(key: string, relogin: boolean, credentials: NativeCredentials): void {
    this.last.set(key, {
      gen: this.generation(key) + 1,
      relogin,
      credentials,
    });
  }
}

/**
 * 服务器壳页面要直接连的来源（契约 §88.1）：远程服务的签发方（`me.stream`）与挂上的
 * 源的中继来源是公开域名，匿名也给；直连源的地址（`baseUrl` 与直连的路）是 owner 才
 * 看得到的源表拓扑，只在 `owner` 时给。只读 SQLite。
 */
export function pageConnectOrigins(
  store: SourcesStore,
  owner: boolean,
): string[] {
  const origins = new Set<string>();
  for (const remote of store.remotes()) origins.add(remote.issuer);
  for (const row of store.list()) {
    if (row.kind === "local") continue;
    if (row.relayOrigin !== "") origins.add(row.relayOrigin);
    if (owner && row.baseUrl !== "") origins.add(row.baseUrl);
  }
  for (const routes of store.allRoutes().values())
    for (const route of routes)
      if (route.via === "relayed" || owner) origins.add(route.origin);
  return [...origins];
}

/** 经中继时，中继就是远程服务本身（个人中转）才沿用它的 CA 指纹。 */
export function relayFingerprint(
  relayBaseUrl: string,
  remote: Pick<RemoteRow, "issuer" | "fingerprint">,
): string {
  try {
    return new URL(relayBaseUrl).origin === remote.issuer
      ? remote.fingerprint
      : "";
  } catch {
    return "";
  }
}

/** 一条中继的来源：断言给的 `relayOrigin`，没有就是 `relayBaseUrl` 的来源。 */
export function relayOriginOf(assertion: {
  relayOrigin?: string;
  relayBaseUrl: string;
}): string {
  return assertion.relayOrigin || new URL(assertion.relayBaseUrl).origin;
}
