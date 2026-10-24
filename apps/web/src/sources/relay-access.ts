import {
  type CloudAssertion,
  type CloudDevice,
  type CloudOptions,
  CloudError,
  cloudAssertion,
  cloudRefresh,
  coreCloudLogin,
  coreRefresh,
} from "./cloud-client";
import { ACCESS_RENEW_LEAD_MS } from "./credentials";
import {
  type ChannelTarget,
  E2eAccessError,
  type E2eChannels,
} from "./e2e/manager";
import { SOURCE_ERROR, type SourceAccess, SourceError } from "./types";

/**
 * 经中继到达一个源（客户端包 §5，平台设计 §17.6）：手机与中继托管的页面共用的
 * 那一段——
 *
 * 1. 远程服务的会话：用存着的刷新令牌换（每次旋转，写回保管处）；
 * 2. 这个源的断言与中继令牌（`POST /v1/sources/{id}/assertion`）；
 * 3. 源 core 的会话：先用存着的刷新令牌经中继轮换，被拒才用断言
 *    `cloud/login` 重新登录；写回保管处。
 *
 * 凭据放在哪由 {@link RelayVault} 决定：手机是钥匙串（`mobile/credentials.ts`），
 * 浏览器只在内存（`sources/hosted.ts`）。这里不在别处留刷新令牌，每次读保管处
 * 里最新的：身份面（`api/identity.ts`）轮换之后同样写回它。
 */

/** 源 core 的一份会话（经中继那一路）。 */
export interface RelaySession {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** 访问令牌到期的时刻（毫秒）；不知道是 0。 */
  readonly expiresAtMs: number;
  /** 刷新时要带的 CSRF 密钥；保管处存不下（钥匙串的旧形状）时没有。 */
  readonly csrfToken?: string;
}

export interface RelayVault {
  /** 这个远程服务的刷新令牌；没登录过是 `null`。 */
  cloudRefreshToken(issuer: string): Promise<string | null>;
  saveCloudRefreshToken(issuer: string, refreshToken: string): Promise<void>;
  /** 远程服务答刷新令牌失效：忘掉它。 */
  forgetCloud?(issuer: string): Promise<void>;
  session(sourceId: string): Promise<RelaySession | undefined>;
  saveSession(
    sourceId: string,
    issuer: string,
    session: RelaySession,
  ): Promise<void>;
}

export interface CloudSessions {
  /** 远程服务的访问令牌：缓存着、快到期才换；同一个签发方并发只换一次。 */
  access(issuer: string): Promise<string>;
  /** 手里那枚被拒了（me.stream 4401）：丢掉缓存，下次重换。 */
  invalidate(issuer: string): void;
  /** 刚登录拿到的一份：直接记下（免得马上又换一次）。 */
  adopt(issuer: string, accessToken: string, expiresAtMs: number): void;
}

export interface RelayAccessDeps {
  readonly vault: RelayVault;
  readonly device: () => CloudDevice;
  readonly cloud?: CloudOptions;
  readonly now?: () => number;
  /**
   * 端到端通道（契约 §78）：给了就先经中继开通道，源 core 的登录、刷新与之后的
   * 请求都走它；源不支持（过渡期）时退回明文。
   */
  readonly e2e?: E2eChannels;
  /** 待确认对话框里这台电脑的名字。 */
  readonly label?: (sourceId: string) => string;
  /**
   * 自己去要断言与中继令牌（Cookie 会话的控制台：页面没有访问令牌，经 `sources.assertion`
   * 带 Cookie 请求）。不给就用远程服务的访问令牌（`cloudSessions`）走 Bearer。失败要抛
   * {@link CloudError}，下面的 `relayFailure` 才认得。
   */
  readonly assertion?: (
    sourceId: string,
    device: CloudDevice,
  ) => Promise<CloudAssertion>;
}

function unauthorized(code: string = SOURCE_ERROR.unauthorized): SourceError {
  return new SourceError(code);
}

const wsOf = (base: string) => base.replace(/^http/, "ws");

/** 远程服务会话（按签发方各一份，只在内存里）。 */
export function createCloudSessions(
  deps: Pick<RelayAccessDeps, "vault" | "cloud" | "now">,
): CloudSessions {
  const now = deps.now ?? Date.now;
  const sessions = new Map<
    string,
    { accessToken: string; expiresAtMs: number }
  >();
  const pending = new Map<string, Promise<string>>();

  return {
    access(issuer) {
      const cached = sessions.get(issuer);
      if (
        cached !== undefined &&
        cached.expiresAtMs - now() > ACCESS_RENEW_LEAD_MS
      )
        return Promise.resolve(cached.accessToken);
      let inflight = pending.get(issuer);
      if (inflight === undefined) {
        inflight = (async () => {
          const refreshToken = await deps.vault.cloudRefreshToken(issuer);
          if (refreshToken === null) throw unauthorized();
          try {
            const session = await cloudRefresh(
              issuer,
              refreshToken,
              deps.cloud,
            );
            if (session.refreshToken !== undefined)
              await deps.vault.saveCloudRefreshToken(
                issuer,
                session.refreshToken,
              );
            sessions.set(issuer, {
              accessToken: session.accessToken,
              expiresAtMs: session.accessExpiresAtMs,
            });
            return session.accessToken;
          } catch (error) {
            if (
              error instanceof CloudError &&
              (error.code === "session_expired" ||
                error.code === "session_revoked" ||
                error.status === 401)
            ) {
              await deps.vault.forgetCloud?.(issuer);
              throw unauthorized();
            }
            throw error;
          }
        })().finally(() => {
          pending.delete(issuer);
        });
        pending.set(issuer, inflight);
      }
      return inflight;
    },
    invalidate(issuer) {
      sessions.delete(issuer);
    },
    adopt(issuer, accessToken, expiresAtMs) {
      sessions.set(issuer, { accessToken, expiresAtMs });
    },
  };
}

/** 端到端通道的拒绝 → 源层的码。 */
function e2eFailure(error: unknown): never {
  if (error instanceof E2eAccessError) {
    if (error.code === "identity_changed")
      throw unauthorized(SOURCE_ERROR.identityChanged);
    if (error.code === "device_rejected")
      throw unauthorized(SOURCE_ERROR.deviceRejected);
    if (error.code === "unsupported")
      throw unauthorized(SOURCE_ERROR.e2eUnsupported);
    if (error.code === "device_unavailable")
      throw unauthorized(SOURCE_ERROR.e2eDeviceUnavailable);
    if (error.code === "unreachable")
      throw unauthorized(SOURCE_ERROR.unreachable);
    if (error.code === "offline") throw unauthorized(SOURCE_ERROR.offline);
    throw unauthorized();
  }
  throw error;
}

/** 远程服务与源 core 的拒绝 → 源层的码（界面按码取文案）。 */
function relayFailure(error: unknown): never {
  if (error instanceof CloudError) {
    if (error.code === "source_offline")
      throw unauthorized(SOURCE_ERROR.offline);
    if (error.code === "source_revoked")
      throw unauthorized(SOURCE_ERROR.revoked);
    if (error.code === "source_access_denied")
      throw unauthorized(SOURCE_ERROR.accessRevoked);
    if (error.status === 401 || error.status === 403) throw unauthorized();
  }
  throw error;
}

/**
 * 给一个经中继的源取访问。`force` = 手里那份被拒了，源 core 的会话无论新旧都轮换
 * （或重登）一次。
 */
export function createRelayedAccess(
  deps: RelayAccessDeps & { readonly cloudSessions?: CloudSessions },
): {
  readonly cloudSessions: CloudSessions;
  access(
    issuer: string,
    sourceId: string,
    force: boolean,
  ): Promise<SourceAccess>;
} {
  const now = deps.now ?? Date.now;
  const cloudSessions = deps.cloudSessions ?? createCloudSessions(deps);
  const fresh = (session: RelaySession) =>
    session.expiresAtMs === 0 ||
    session.expiresAtMs - now() > ACCESS_RENEW_LEAD_MS;

  const access = async (
    issuer: string,
    sourceId: string,
    force: boolean,
  ): Promise<SourceAccess> => {
    if (issuer === "") throw unauthorized();
    let assertion: CloudAssertion;
    if (deps.assertion) {
      assertion = await deps
        .assertion(sourceId, deps.device())
        .catch(relayFailure);
    } else {
      const cloudToken = await cloudSessions.access(issuer);
      assertion = await cloudAssertion(
        issuer,
        cloudToken,
        sourceId,
        deps.device(),
        deps.cloud,
      ).catch(relayFailure);
    }
    if (!assertion.online) throw unauthorized(SOURCE_ERROR.offline);
    const base = assertion.relayBaseUrl.replace(/\/+$/, "");
    const target: ChannelTarget = {
      issuer,
      sourceId,
      base,
      relayToken: assertion.relayToken,
      label: deps.label?.(sourceId) ?? "",
    };
    // 经中继只走端到端通道（契约 §78）；没有通道就不连。
    const e2e = deps.e2e;
    if (e2e === undefined)
      throw unauthorized(SOURCE_ERROR.e2eDeviceUnavailable);
    const channel = await e2e.channel(target).catch(e2eFailure);
    // 源 core 的登录与刷新也走通道（会话绑这台设备的设备钥）。
    const coreOptions: CloudOptions = {
      ...deps.cloud,
      fetch: e2e.fetchFor(channel, base),
    };

    let session = await deps.vault.session(sourceId);
    if (session === undefined || force || !fresh(session)) {
      let next: RelaySession | null = null;
      if (session !== undefined) {
        try {
          const rotated = await coreRefresh(
            base,
            session.refreshToken,
            assertion.relayToken,
            coreOptions,
            session.csrfToken,
          );
          next = {
            accessToken: rotated.native.accessToken,
            refreshToken: rotated.native.refreshToken,
            expiresAtMs: rotated.expiresAtUnixMs,
            ...(rotated.csrfToken === undefined
              ? {}
              : { csrfToken: rotated.csrfToken }),
          };
        } catch (error) {
          // 连不上不是「会话被拒」：往上抛，别白白换一次登录。只有会话被拒（401 / 403，含
          // SaaS 限寿会话到期前 core 拒绝刷新，#484）才改用新断言重登；限流与 5xx 原样上抛。
          if (!(error instanceof CloudError)) throw error;
          if (error.code === "source_offline")
            throw unauthorized(SOURCE_ERROR.offline);
          if (error.status !== 401 && error.status !== 403) throw error;
        }
      }
      if (next === null) {
        try {
          const send = () =>
            coreCloudLogin(
              base,
              assertion.relayToken,
              assertion.assertion,
              undefined,
              coreOptions,
              // 带上当前刷新令牌：SaaS 来源的限寿会话在原会话上续期，长连接不断。
              session?.refreshToken,
            );
          const login = await send().catch(async (error: unknown) => {
            // 新设备：等主人在那台电脑上核对校验码，放行后再登录一次（契约 §77）。
            if (
              !(error instanceof CloudError) ||
              error.code !== "device_pending" ||
              typeof error.details.pendingId !== "string"
            )
              throw error;
            await e2e
              .awaitApproval(target, channel, error.details.pendingId)
              .catch(e2eFailure);
            return send();
          });
          next = {
            accessToken: login.native.accessToken,
            refreshToken: login.native.refreshToken,
            expiresAtMs: login.expiresAtUnixMs,
            ...(login.csrfToken === undefined
              ? {}
              : { csrfToken: login.csrfToken }),
          };
        } catch (error) {
          if (error instanceof CloudError) {
            if (error.code === "source_offline")
              throw unauthorized(SOURCE_ERROR.offline);
            throw new SourceError(
              error.code === "cloud_account_unlinked" ||
              error.code === "cloud_not_registered"
                ? error.code
                : error.code === "device_rejected"
                  ? SOURCE_ERROR.deviceRejected
                  : SOURCE_ERROR.unauthorized,
            );
          }
          throw error;
        }
      }
      session = next;
      await deps.vault.saveSession(sourceId, issuer, session);
    }
    const lifetimes = [
      session.expiresAtMs,
      assertion.relayTokenExpiresAtMs,
    ].filter((value) => value > 0);
    return {
      accessToken: session.accessToken,
      expiresAtMs: lifetimes.length === 0 ? 0 : Math.min(...lifetimes),
      httpBase: base,
      wsBase: wsOf(base),
      relayToken: assertion.relayToken,
      e2e: {
        fetch: e2e.fetchFor(channel, base),
        WebSocket: e2e.socketFor(channel, base),
        onClose: (listener) => channel.onClose(() => listener()),
      },
    };
  };

  return { cloudSessions, access };
}
