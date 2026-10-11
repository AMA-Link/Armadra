import { z } from "zod";

import { RuntimeRequestError, json, request } from "../api/request";
import { isDesktop } from "../platform";
import { localSource } from "../api/source";
import { desktopDeviceKey } from "./e2e/device-key";
import {
  E2eAccessError,
  E2eChannels,
  dismissPendingApproval,
  markApprovalRejected,
  showPendingApproval,
} from "./e2e/manager";
import {
  type CloudAuth,
  type CredentialProvider,
  SOURCE_ERROR,
  type SourceAccess,
  SourceError,
  type Via,
} from "./types";

export { type SessionTokens, createSessionTokens } from "./session-tokens";

/**
 * 凭据的来路（客户端包 §1.2）。
 *
 * 凭据跟着源走：每个源一份，只在内存里。本机源的会话由身份面
 * （`api/identity.ts`）持有一份 `SessionTokens`（`sources/session-tokens.ts`）；远程源的访问由一个
 * {@link CredentialProvider} 按 `sourceId` 各管各的——
 *
 * - **desktop**（桌面与服务器壳的页面）：本机 core 代为换票，刷新令牌留在 core
 *   的 SecretStore 里，页面只拿到访问令牌（`POST /api/sources/{id}/session`，
 *   契约 §33）。{@link createDesktopCredentialProvider}。
 * - **mobile**（钥匙串 + 远程服务）与 **browser-cloud**（内存 + 云会话）：形状
 *   相同，实现分别在 A1-5 与 SaaS 页面落地；它们只要实现
 *   {@link CredentialProvider}，或给 {@link createCachedCredentialProvider} 一个
 *   换票函数。
 */

/** 换一份访问：给源与路（同一类里哪一条，§55），答访问。 */
export type AccessExchange = (
  sourceId: string,
  via: Via,
  origin?: string,
) => Promise<SourceAccess>;

/** 访问令牌离到期不到这么久就当它已经过期，先换一份。 */
export const ACCESS_RENEW_LEAD_MS = 30_000;

/**
 * 按源缓存访问的凭据来源：同一个源同一条路的并发请求只换一次；快到期的先换；
 * `refresh` 不看缓存。换票本身交给 `exchange`。
 */
export function createCachedCredentialProvider(
  exchange: AccessExchange,
  now: () => number = Date.now,
): CredentialProvider {
  const cache = new Map<
    string,
    { via: Via; origin: string | undefined; access: SourceAccess }
  >();
  const pending = new Map<string, Promise<SourceAccess>>();

  const fresh = (access: SourceAccess) =>
    access.expiresAtMs === 0 ||
    access.expiresAtMs - now() > ACCESS_RENEW_LEAD_MS;

  const run = (
    sourceId: string,
    via: Via,
    origin: string | undefined,
  ): Promise<SourceAccess> => {
    const key = `${sourceId}\u0000${via}\u0000${origin ?? ""}`;
    let inflight = pending.get(key);
    if (inflight === undefined) {
      inflight = (
        origin === undefined
          ? exchange(sourceId, via)
          : exchange(sourceId, via, origin)
      )
        .then((access) => {
          cache.set(sourceId, { via, origin, access });
          return access;
        })
        .finally(() => {
          pending.delete(key);
        });
      pending.set(key, inflight);
    }
    return inflight;
  };

  return {
    getAccess(sourceId, via, origin) {
      const cached = cache.get(sourceId);
      if (
        cached !== undefined &&
        cached.via === via &&
        (origin === undefined || cached.origin === origin) &&
        fresh(cached.access)
      )
        return Promise.resolve(cached.access);
      return run(sourceId, via, origin);
    },
    refresh(sourceId, via, origin) {
      cache.delete(sourceId);
      return run(sourceId, via, origin);
    },
    invalidate(sourceId) {
      cache.delete(sourceId);
    },
  };
}

const sessionAnswerSchema = z.object({
  accessToken: z.string().min(1),
  accessExpiresAtMs: z.number(),
  httpBase: z.string().min(1),
  wsBase: z.string().min(1),
  via: z.enum(["direct", "relayed"]),
  relayToken: z.string().optional(),
  relayTokenExpiresAtMs: z.number().optional(),
});

const waitAnswerSchema = z.object({
  status: z.enum(["pending", "trusted", "rejected", "revoked"]),
});

/** `device_pending` 的 `details`（契约 §77、§78.4）。 */
function pendingDetails(
  error: unknown,
): { pendingId: string; sas: string } | null {
  if (
    !(error instanceof RuntimeRequestError) ||
    error.code !== "device_pending"
  )
    return null;
  const details = (
    error.body as { details?: Record<string, unknown> } | undefined
  )?.details;
  const pendingId = details?.pendingId;
  const sas = details?.sas;
  return typeof pendingId === "string" && typeof sas === "string"
    ? { pendingId, sas }
    : null;
}

/**
 * 本机 core 代连的那台电脑要它的主人核对这台设备（契约 §78.4）：把校验码交给界面，
 * 经本机 core 等；放行答 `true`，被拒抛 `device_rejected`，人取消抛。
 */
async function awaitRemoteApproval(
  sourceId: string,
  pending: { pendingId: string; sas: string },
): Promise<void> {
  let cancelled = false;
  showPendingApproval({
    sourceId,
    label: "",
    sas: pending.sas,
    cancel: () => {
      cancelled = true;
    },
  });
  try {
    for (;;) {
      if (cancelled) throw new SourceError(SOURCE_ERROR.unauthorized);
      const { status } = await request(
        "/api/e2e/sources/wait",
        waitAnswerSchema,
        { method: "POST", ...json({ sourceId, pendingId: pending.pendingId }) },
        localSource,
      ).catch(() => ({ status: "pending" as const }));
      if (status === "trusted") return;
      if (status === "rejected" || status === "revoked") {
        markApprovalRejected(sourceId);
        throw new SourceError(SOURCE_ERROR.deviceRejected);
      }
      // 本机 core 那条通道断了（或这一轮没等到）：稍后再问。
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } finally {
    if (cancelled) dismissPendingApproval(sourceId);
  }
}

/**
 * 本机 core 代连别的电脑的一步（取会话、挂载）答 `device_pending` 时：把校验码交给
 * 界面、等对端主人核对，放行后再做一次（契约 §78.4）。
 */
export async function withRemoteApproval<T>(
  sourceId: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const pending = pendingDetails(error);
    if (pending === null) throw error;
    await awaitRemoteApproval(sourceId, pending);
    dismissPendingApproval(sourceId);
    return run();
  }
}

/** 桌面窗口自己的端到端通道（设备钥由本机 core 保管，经 `e2e.sign` 签）。 */
let desktopChannels: E2eChannels | null = null;

const E2E_SOURCE_ERROR: Partial<Record<E2eAccessError["code"], string>> = {
  identity_changed: SOURCE_ERROR.identityChanged,
  device_rejected: SOURCE_ERROR.deviceRejected,
  unsupported: SOURCE_ERROR.e2eUnsupported,
  device_unavailable: SOURCE_ERROR.e2eDeviceUnavailable,
  unreachable: SOURCE_ERROR.unreachable,
};

/**
 * 桌面与服务器壳的页面：经本机 core 换票（`POST /api/sources/{id}/session`，
 * 契约 §33）。刷新令牌与远程服务的会话都留在 core，页面只拿访问令牌；
 * 刷新失败时 core 自己经远程服务重取断言，再失败答 `source_unauthorized`。
 *
 * 经中继时（契约 §78）：core 经它自己的端到端通道登录，会话绑本机设备钥；页面再用
 * 同一把钥开自己的通道，之后的请求与流都走它。对端主人还没核对这台设备时 core 答
 * `device_pending`，这里把校验码交给界面、等主人放行再换一次。
 */
export const exchangeViaLocalCore: AccessExchange = async (
  sourceId,
  via,
  origin,
) => {
  const ask = () =>
    request(
      `/api/sources/${encodeURIComponent(sourceId)}/session`,
      sessionAnswerSchema,
      {
        method: "POST",
        ...json(
          via === "local"
            ? {}
            : origin === undefined
              ? { via }
              : { via, route: { via, origin } },
        ),
      },
      localSource,
    );
  const answer = await withRemoteApproval(sourceId, ask);
  const httpBase = answer.httpBase.replace(/\/+$/, "");
  let e2e: SourceAccess["e2e"];
  // 经中转只走端到端通道（契约 §78）。会话是本机 core 经它自己的通道签的、绑它的
  // 设备钥，所以页面（桌面窗口，或经 Gateway 打开的服务器壳页面）也用这把钥开通道：
  // 经 `e2e.sign` 请 core 签，私钥不进页面。
  if (answer.via === "relayed" && answer.relayToken !== undefined) {
    desktopChannels ??= new E2eChannels({
      deviceName: () => (isDesktop() ? "Armadra Desktop" : "Armadra Server"),
      device: async () => ({
        signer: await desktopDeviceKey(),
        platform: "desktop",
      }),
    });
    const channel = await desktopChannels
      .channel({
        issuer: new URL(httpBase).origin,
        sourceId,
        base: httpBase,
        relayToken: answer.relayToken,
      })
      .catch((error: unknown) => {
        if (error instanceof E2eAccessError) {
          const code = E2E_SOURCE_ERROR[error.code];
          if (code !== undefined) throw new SourceError(code);
        }
        throw error;
      });
    e2e = {
      fetch: desktopChannels.fetchFor(channel, httpBase),
      WebSocket: desktopChannels.socketFor(channel, httpBase),
    };
  }
  return {
    accessToken: answer.accessToken,
    expiresAtMs: answer.accessExpiresAtMs,
    httpBase,
    wsBase: answer.wsBase.replace(/\/+$/, ""),
    ...(answer.relayToken === undefined
      ? {}
      : { relayToken: answer.relayToken }),
    ...(e2e === undefined ? {} : { e2e }),
  };
};

export function createDesktopCredentialProvider(
  exchange: AccessExchange = exchangeViaLocalCore,
  now?: () => number,
): CredentialProvider {
  // 本机 core 在几条中继里并行要断言（§55），页面不必逐条试。
  return {
    ...createCachedCredentialProvider(exchange, now),
    selectsRelay: true,
  };
}

/* ------------------------------ 远程服务的会话 ------------------------------ */

const remoteListSchema = z.object({
  remotes: z
    .array(z.object({ serviceId: z.string().min(1), issuer: z.string() }))
    .default([]),
});

const remoteSessionSchema = z.object({
  accessToken: z.string().min(1),
  accessExpiresAtMs: z.number(),
});

/**
 * 桌面与服务器壳的页面：远程服务的访问令牌也由本机 core 代为换
 * （`sources.remoteSession`，契约 §33）——刷新令牌留在 core。`me.stream` 用它。
 */
export function createDesktopCloudAuth(
  now: () => number = Date.now,
): CloudAuth {
  const cache = new Map<string, { accessToken: string; expiresAtMs: number }>();
  const pending = new Map<string, Promise<string>>();
  return {
    access(issuer) {
      const cached = cache.get(issuer);
      if (cached && cached.expiresAtMs - now() > ACCESS_RENEW_LEAD_MS)
        return Promise.resolve(cached.accessToken);
      let inflight = pending.get(issuer);
      if (inflight === undefined) {
        inflight = (async () => {
          const { remotes } = await request(
            "/api/sources",
            remoteListSchema,
            undefined,
            localSource,
          );
          const remote = remotes.find((row) => row.issuer === issuer);
          if (remote === undefined)
            throw new SourceError(SOURCE_ERROR.unauthorized, "no remote");
          const answer = await request(
            `/api/sources/remotes/${encodeURIComponent(remote.serviceId)}/session`,
            remoteSessionSchema,
            { method: "POST", ...json({}) },
            localSource,
          );
          cache.set(issuer, {
            accessToken: answer.accessToken,
            expiresAtMs: answer.accessExpiresAtMs,
          });
          return answer.accessToken;
        })().finally(() => {
          pending.delete(issuer);
        });
        pending.set(issuer, inflight);
      }
      return inflight;
    },
    invalidate(issuer) {
      cache.delete(issuer);
    },
  };
}
