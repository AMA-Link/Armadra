/**
 * 经中继登录别的电脑（契约 §31.3、§88.2），从 `service.ts` 拆出来的两件事：
 *
 * - {@link loginAtRelay}：用断言 `cloud/login`，带上这条路存着的刷新令牌——Armadra 云的
 *   限寿会话由对端在同一会话 id 上续，长连接不断。成功写回新令牌、纠正分享信息与归属；
 *   被明确拒绝才删存着的令牌，待确认、限流、不在线、连不上都留着。
 * - {@link pageConnectOrigins}：服务器壳页面要直接连的来源（Gateway 给 CSP 追加授权用；
 *   直连地址只给 owner）。
 */

import {
  MIN_CORE_VERSION_ROLE_ONLY_ASSERTION,
  MIN_CORE_VERSION_TEAM_ASSERTION,
} from "@armadra/platform-protocol";

import { CoreFailure, fail } from "../http/errors";
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
  return logged;
}

/**
 * 重登之后按自己的云纠正归属与团队（契约 §86.2）。要问远程服务目录，所以在换票的锁
 * **外面**、令牌写回之后做，不拖住排在后面的换票。
 */
export function attributeAfterLogin(
  deps: RelayLoginDeps,
  input: RelayLoginInput,
  logged: NativeCredentials,
): Promise<void> {
  return refreshMountedAttribution(
    deps.remote,
    deps.store,
    input.service,
    input.access,
    input.assertion,
    { endpoint: input.endpoint, sourceId: input.sourceId },
    logged.share,
  );
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
): Promise<{ credentials: NativeCredentials; login: boolean }> {
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
        return { credentials: fresh, login: false };
      } catch (error) {
        if (
          !(error instanceof CoreFailure) ||
          error.code !== "source_unauthorized"
        )
          throw error;
      }
    }
  }
  return { credentials: await loginAtRelay(deps, input), login: true };
}

/**
 * 同一条路上并发换票的合并（契约 §88.2）：排队期间别人已经换过一份、那份访问还新鲜，
 * 就直接用它——再刷新一次会旋转会话、作废刚发给前一个调用方的访问令牌，再重登一次还会
 * 多扣对端 `cloud/login` 的额度。要重登（授予变了）的只复用重登换来的那份。
 */
export class RelayExchanges {
  private readonly last = new Map<
    string,
    {
      gen: number;
      relogin: boolean;
      /** 这次换票开始（进锁）时的序号。 */
      began: number;
      credentials: NativeCredentials;
    }
  >();
  private readonly started = new Map<string, number>();

  /** 调用方到来时记下：已完成几次、已开始几次。 */
  arrival(key: string): { gen: number; began: number } {
    return {
      gen: this.last.get(key)?.gen ?? 0,
      began: this.started.get(key) ?? 0,
    };
  }

  /** 进锁、真要换票时调：答这次的开始序号。 */
  begin(key: string): number {
    const next = (this.started.get(key) ?? 0) + 1;
    this.started.set(key, next);
    return next;
  }

  /**
   * 能共用的那份：自己到来之后才完成的、访问还新鲜的。要重登的更严：只共用在自己
   * 到来**之后才开始**的重登——之前就开始的那次用的是更早的断言，授予未必是新的。
   */
  shared(
    key: string,
    since: { gen: number; began: number },
    relogin: boolean,
    freshUntil: number,
  ): NativeCredentials | undefined {
    const last = this.last.get(key);
    if (
      last === undefined ||
      last.gen === since.gen ||
      (relogin && (!last.relogin || last.began <= since.began)) ||
      last.credentials.accessExpiresAtMs <= freshUntil
    )
      return undefined;
    return last.credentials;
  }

  record(
    key: string,
    relogin: boolean,
    began: number,
    credentials: NativeCredentials,
  ): void {
    this.last.set(key, {
      gen: (this.last.get(key)?.gen ?? 0) + 1,
      relogin,
      began,
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

/** `a` 是否早于 `b`（`x.y.z`，忽略预发布后缀）；认不出答 `false`。 */
export function olderThan(a: string, b: string): boolean {
  const parse = (value: string) =>
    /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim())?.slice(1).map(Number);
  const left = parse(a);
  const right = parse(b);
  if (left === undefined || right === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]!;
  }
  return false;
}

/**
 * 要断言；答 `source_access_denied` 时分清两种（契约 §88.2）：远程服务目录里这台主机登记的
 * `coreVersion` 低于控制面签断言的门槛（团队主机看 `MIN_CORE_VERSION_TEAM_ASSERTION`，
 * 个人空间看 `MIN_CORE_VERSION_ROLE_ONLY_ASSERTION`）就是「主机版本过旧」，`details` 带
 * `{ reason: "hostOutdated", coreVersion, minVersion }`；否则是访问被收回。目录问不到按后者。
 */
export async function assertionExplained(
  remote: RemoteClient,
  endpoint: RemoteEndpoint,
  accessToken: string,
  sourceId: string,
  team: boolean,
): Promise<SourceAssertion> {
  try {
    return await remote.assertion(endpoint, accessToken, sourceId);
  } catch (error) {
    if (
      !(error instanceof CoreFailure) ||
      error.code !== "source_access_denied"
    )
      throw error;
    throw await explainAccessDenied(
      remote,
      endpoint,
      accessToken,
      sourceId,
      team,
    );
  }
}

async function explainAccessDenied(
  remote: RemoteClient,
  endpoint: RemoteEndpoint,
  accessToken: string,
  sourceId: string,
  team: boolean,
): Promise<CoreFailure> {
  const denied = fail("source_access_denied", "远程服务不再允许访问这个源");
  const listed = await remote.sources(endpoint, accessToken).catch(() => []);
  const coreVersion =
    listed.find((one) => one.sourceId === sourceId)?.coreVersion ?? "";
  const minVersion = team
    ? MIN_CORE_VERSION_TEAM_ASSERTION
    : MIN_CORE_VERSION_ROLE_ONLY_ASSERTION;
  return olderThan(coreVersion, minVersion)
    ? fail("source_access_denied", "那台主机的 Armadra 版本太旧", {
        reason: "hostOutdated",
        coreVersion,
        minVersion,
      })
    : denied;
}
