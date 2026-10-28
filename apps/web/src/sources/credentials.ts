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
  type CloudAssertion,
  CloudError,
  type CloudDevice,
  type CloudOptions,
  browserDevice,
  cloudAccountId,
} from "./cloud-client";
import { type RelaySession, createRelayedAccess } from "./relay-access";
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
  offline: SOURCE_ERROR.offline,
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
      onClose: (listener) => channel.onClose(() => listener()),
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
  const auth: CloudAuth = {
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
    async accountId(issuer) {
      return cloudAccountId(issuer, await auth.access(issuer));
    },
  };
  return auth;
}

/**
 * 桌面与服务器壳的页面：请本机 core 经中继重登这个源（契约 §88.2，`relogin: true`）——
 * 跳过刷新，带旧刷新令牌按新断言同步授予，主机在同一会话上续。答案不用：重登后手里的
 * 访问由连接自己续一次。对端待确认时不在这里等（授予同步不该弹待确认对话框）。
 */
export async function reloginViaLocalCore(sourceId: string): Promise<void> {
  await request(
    `/api/sources/${encodeURIComponent(sourceId)}/session`,
    sessionAnswerSchema,
    { method: "POST", ...json({ via: "relayed", relogin: true }) },
    localSource,
  );
}

/* --------------------------- 浏览器里的云会话 --------------------------- */

export interface BrowserCloudDeps {
  /** 控制台的客户端（Cookie 会话）：只用到 `sources.assertion`。 */
  readonly client: {
    readonly sources: {
      assertion(input: {
        sourceId: string;
        device: CloudDevice;
      }): Promise<CloudAssertion>;
    };
  };
  /** 断言的签发方：控制台所在来源。 */
  readonly issuer: string;
  /** 端到端通道（契约 §78）；经中继只走它。 */
  readonly e2e: E2eChannels;
  /** 源 core 的登录与刷新用（经通道的 `fetch` 由 `e2e` 补上）。 */
  readonly cloud?: CloudOptions;
  readonly now?: () => number;
  /**
   * 源 core 会话的保存处（控制台 `/h/`：身份面轮换后写回的那一份，刷新页面要续上）。
   * 缺省只在内存里，`clear()` 一并清掉。
   */
  readonly sessions?: {
    load(sourceId: string): Promise<RelaySession | undefined>;
    save(sourceId: string, session: RelaySession): void;
  };
  /** 待确认对话框里这台电脑的名字。 */
  readonly label?: (sourceId: string) => string;
}

/** 控制台客户端的失败（`status` + `code`）→ 中继登录流程认得的 {@link CloudError}。 */
function asCloudError(error: unknown): unknown {
  if (error instanceof CloudError) return error;
  const { status, code, message, details } = (error ?? {}) as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (typeof status !== "number" || typeof code !== "string") return error;
  // `details` 原样带上：限流的 `retryAfterMs`、待确认的 `pendingId` 都在里面。
  const record =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>)
      : {};
  const retryAfterMs =
    typeof record.retryAfterMs === "number" ? record.retryAfterMs : 0;
  return new CloudError(
    status,
    code,
    typeof message === "string" ? message : code,
    retryAfterMs,
    record,
  );
}

/**
 * `browser-cloud`（云端控制台 §1.3）：`app.<云>` 上的页面用 Cookie 会话向控制面要断言
 * （`sources.assertion`，不碰访问令牌），再按 §78 开端到端通道、登录源 core。断言、
 * 中继令牌与源 core 的会话只在内存里，关标签即丢；`clear()` 在登出时调。
 */
export function createBrowserCloudCredentialProvider(
  deps: BrowserCloudDeps,
): CredentialProvider & {
  clear(): void;
  /**
   * 授予变了：跳过轮换，用新断言带当前刷新令牌重登（`relay-access.ts` 的 `relogin`），
   * 主机在同一会话上续并同步授予。
   */
  relogin(sourceId: string): Promise<SourceAccess>;
} {
  const sessions = new Map<string, RelaySession>();
  const relay = createRelayedAccess({
    vault: {
      cloudRefreshToken: async () => null,
      saveCloudRefreshToken: async () => undefined,
      session: async (sourceId) =>
        deps.sessions === undefined
          ? sessions.get(sourceId)
          : deps.sessions.load(sourceId),
      async saveSession(sourceId, _issuer, session) {
        if (deps.sessions === undefined) sessions.set(sourceId, session);
        else deps.sessions.save(sourceId, session);
      },
    },
    device: () => browserDevice(),
    ...(deps.label === undefined ? {} : { label: deps.label }),
    assertion: (sourceId, device) =>
      deps.client.sources
        .assertion({ sourceId, device })
        .catch((error: unknown) => {
          throw asCloudError(error);
        }),
    e2e: deps.e2e,
    ...(deps.cloud === undefined ? {} : { cloud: deps.cloud }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const forced = new Set<string>();
  const relogins = new Set<string>();
  const used = new Set<string>();
  /** 每个源正在进行的那次换票（不论是否重登）。 */
  const running = new Map<string, Promise<unknown>>();
  const cached = createCachedCredentialProvider(async (sourceId, via) => {
    used.add(sourceId);
    if (via !== "relayed") throw new SourceError(SOURCE_ERROR.unreachable);
    const exchange: Promise<SourceAccess> = relay
      .access(
        deps.issuer,
        sourceId,
        forced.delete(sourceId),
        relogins.delete(sourceId),
      )
      .finally(() => {
        // 先于缓存的收尾：等它的人醒来时这一项已经不在了。
        if (running.get(sourceId) === exchange) running.delete(sourceId);
      });
    running.set(sourceId, exchange);
    return exchange;
  }, deps.now);
  return {
    getAccess: (sourceId, via) => cached.getAccess(sourceId, via),
    refresh(sourceId, via) {
      forced.add(sourceId);
      return cached.refresh(sourceId, via);
    },
    invalidate: (sourceId) => cached.invalidate(sourceId),
    async relogin(sourceId) {
      // 进行中的那次是在授予变化之前开始的：不能拿它的结果顶替重登。等它完，再单独开一次
      // 带重登标记的（标记与开始换票在同一拍里，别的请求插不进来消费它）。
      // 进行中时 `getAccess` 答的就是那一次（连同缓存的收尾），不会另开。
      while (running.has(sourceId))
        await cached.getAccess(sourceId, "relayed").catch(() => undefined);
      relogins.add(sourceId);
      return cached.refresh(sourceId, "relayed");
    },
    clear() {
      sessions.clear();
      forced.clear();
      relogins.clear();
      for (const sourceId of used) cached.invalidate(sourceId);
      used.clear();
    },
  };
}
