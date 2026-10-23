import type { CloudClient } from "./client";

export type InvitationPreview = Awaited<
  ReturnType<CloudClient["invitations"]["get"]>
>;

/**
 * 控制台的会话（云端控制台 §1.3）：令牌在 `__Host-armadra-cloud` Cookie 里，页面不读不存；
 * 页面只在内存里持一份 CSRF 值，每个非 GET 请求放进 `X-Armadra-CSRF`。运营会话是另一个
 * Cookie `__Host-armadra-ops`，CSRF 值也另给一份，两边互不覆盖。
 */
export const CSRF_HEADER = "X-Armadra-CSRF";

/** 内存里的 CSRF 值，可订阅（运营会话是否在，靠它有没有值）。 */
export interface CsrfStore {
  get(): string | undefined;
  set(value: string | undefined): void;
  subscribe(listener: () => void): () => void;
}

export function createCsrfStore(): CsrfStore {
  let value: string | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * 控制台用的客户端束：`client` 走控制台会话，`ops` 走运营会话（`admin.*` 与运营自己的
 * 登录 / 刷新 / 登出）。真实实现与 mock 都满足它，页面只依赖这个形状。
 */
export interface CloudApi {
  readonly client: CloudClient;
  readonly ops: CloudClient;
  /** 运营会话是否在（运营登录成功拿到了它自己的 CSRF 值）。 */
  readonly operator: Pick<CsrfStore, "subscribe"> & { active(): boolean };
  /** 写操作前保证内存里有 CSRF 值：没有就 `auth.refresh`（免 CSRF，答复带 `csrfToken`）。答 `false` = 没有会话。 */
  ensureCsrf(): Promise<boolean>;
  /**
   * 邀请摘要：`POST /v1/invitations/{id}/preview`，令牌在请求体里，不进查询（cloud-api §22）。
   * 协议包 0.10.0 还没有这个过程，这里手写；升到 0.11.0 后改用包里的 `invitations.preview`。
   */
  invitationPreview(
    invitationId: string,
    token: string,
  ): Promise<InvitationPreview>;
  /** 控制台会话失效且续不上：清缓存、回登录。 */
  onSessionLost(listener: () => void): () => void;
  /** 登出：服务端撤销（失败也继续）、清掉内存里的 CSRF 值。 */
  signOut(): Promise<void>;
}

/* ------------------------------ fetch 包装 ------------------------------ */

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);
/** 答案里带 `csrfToken` 的端点（协议 1.4 补充）。 */
const CSRF_SOURCES = new Set([
  "POST /v1/auth/login",
  "POST /v1/auth/mfa/verify",
  "POST /v1/auth/refresh",
  "GET /v1/me",
]);
const AUTH_PATH = /^\/v1\/auth\//;

export interface CloudFetchOptions {
  readonly fetch: typeof fetch;
  readonly csrf: CsrfStore;
  /**
   * 会话类 401 后续一次（Cookie 会话：`auth.refresh`）。答 `true` = 续上了，原请求重发一次。
   * 没给 = 不续，直接算失效（运营会话 1 小时到期回登录这一步）。
   */
  readonly refresh?: () => Promise<boolean>;
  /** 续不上或被撤销。 */
  readonly onSessionLost: () => void;
}

async function codeOf(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json();
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 给 `OpenAPILink` 的 `fetch`：
 * - 一律 `credentials: "include"`、`redirect: "error"`，从不带 `Authorization`（同一请求不同时带 Cookie 与 Bearer）；
 * - 非 GET 带 `X-Armadra-CSRF`；
 * - 登录类与 `me.get` 的成功答案里的 `csrfToken` 记进 `csrf`；
 * - 非 `/v1/auth/*` 的 401：`session_revoked` 直接失效；其余先 `refresh` 一次（并发共用一次），
 *   续上就重发原请求，续不上 `onSessionLost`。
 */
export function createCloudFetch(options: CloudFetchOptions): typeof fetch {
  let refreshing: Promise<boolean> | null = null;
  const refreshOnce = () => {
    refreshing ??= (options.refresh?.() ?? Promise.resolve(false))
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  const send = (request: Request, init?: RequestInit) => {
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    const csrf = options.csrf.get();
    if (!READ_ONLY.has(request.method) && csrf !== undefined)
      headers.set(CSRF_HEADER, csrf);
    return options.fetch(new Request(request, { headers }), {
      ...init,
      credentials: "include",
      redirect: "error",
    });
  };

  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input);
    const spare = request.clone();
    const path = new URL(request.url).pathname;
    let response = await send(request, init);

    if (response.status === 401 && !AUTH_PATH.test(path)) {
      const revoked = (await codeOf(response)) === "session_revoked";
      if (!revoked && (await refreshOnce())) {
        response = await send(spare, init);
        if (response.status === 401) options.onSessionLost();
      } else options.onSessionLost();
      return response;
    }

    if (response.ok && CSRF_SOURCES.has(`${request.method} ${path}`)) {
      try {
        const body: unknown = await response.clone().json();
        const csrf = (body as { csrfToken?: unknown } | null)?.csrfToken;
        if (typeof csrf === "string") options.csrf.set(csrf);
      } catch {
        /* 答案不是 JSON：不记。 */
      }
    }
    return response;
  };
}
