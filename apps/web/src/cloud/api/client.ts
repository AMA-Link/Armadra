import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { cloudContract } from "@armadra/platform-protocol/cloud-api";

import { toCloudError } from "./errors";
import {
  createCloudFetch,
  createCsrfStore,
  type CloudApi,
  type CloudFetchOptions,
} from "./session";

/**
 * 控制台的类型化客户端（云端控制台 §6.3）：按协议包的契约 `cloudContract` 生成，
 * `@orpc/*` 在控制台里只许出现在这个文件。线上是 OpenAPI 形态（契约里的路径已带 `/v1`，
 * 所以 `url` 是来源本身）。失败一律抛 {@link CloudConsoleError}（`api/errors.ts`）。
 */
export type CloudClient = ContractRouterClient<typeof cloudContract>;

/** 协议的错误体 `{ code, message, … }` → 带原样错误体的 `ORPCError`，由 {@link guard} 转成 `CloudConsoleError`。 */
function decodeWireError(body: unknown, response: { status: number }) {
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === "string" && response.status >= 400
    ? new ORPCError(code, { status: response.status, data: body })
    : null;
}

/**
 * 把每次调用的失败统一成 `CloudConsoleError`（真实客户端与 mock 抛同一个类）。orpc 的
 * 客户端既可调用又有子键（`client.me` 与 `client.me.get`），所以逐层包。
 */
function guard<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      return typeof key === "string" &&
        ((typeof value === "object" && value !== null) ||
          typeof value === "function")
        ? guard(value)
        : value;
    },
    async apply(fn, self, args) {
      try {
        return await Reflect.apply(
          fn as (...rest: unknown[]) => unknown,
          self,
          args,
        );
      } catch (error) {
        throw toCloudError(error);
      }
    },
  });
}

export function createCloudClient(
  origin: string,
  fetchWith: typeof fetch,
): CloudClient {
  const link = new OpenAPILink(cloudContract, {
    url: origin,
    fetch: (request, init) => fetchWith(request, init),
    customErrorResponseBodyDecoder: decodeWireError,
  });
  return guard(createORPCClient<CloudClient>(link));
}

export interface CreateCloudApiOptions {
  /** 控制台所在来源（`location.origin`）。 */
  readonly origin: string;
  readonly fetch?: typeof fetch;
}

/**
 * 真实的客户端束：控制台与运营各一个客户端、各一份 CSRF 值。控制台会话 401 时先
 * `auth.refresh`（Cookie 会话，刷新令牌在 Cookie 里，入参留空）再重发；运营会话到期
 * 就算失效，回 `/login?scope=operator` 重新登录。
 */
export function createCloudApi(options: CreateCloudApiOptions): CloudApi {
  const base = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const consoleCsrf = createCsrfStore();
  const opsCsrf = createCsrfStore();
  const lost = new Set<() => void>();

  // 刷新自己不走 401 处理，免得递归。
  const plain = createCloudClient(
    options.origin,
    createCloudFetch({
      fetch: base,
      csrf: consoleCsrf,
      onSessionLost: () => {},
    }),
  );
  const common = (csrf: CloudFetchOptions["csrf"]) => ({
    fetch: base,
    csrf,
  });
  const client = createCloudClient(
    options.origin,
    createCloudFetch({
      ...common(consoleCsrf),
      refresh: async () => {
        // TODO(protocol cookie-session): refreshToken 改可选后发 `{}`，并带上自己的 scope。
        await plain.auth.refresh({ refreshToken: "" });
        return true;
      },
      onSessionLost() {
        consoleCsrf.set(undefined);
        for (const listener of [...lost]) listener();
      },
    }),
  );
  const ops = createCloudClient(
    options.origin,
    createCloudFetch({
      ...common(opsCsrf),
      onSessionLost: () => opsCsrf.set(undefined),
    }),
  );

  return {
    client,
    ops,
    operator: {
      active: () => opsCsrf.get() !== undefined,
      subscribe: opsCsrf.subscribe,
    },
    onSessionLost(listener) {
      lost.add(listener);
      return () => lost.delete(listener);
    },
    async signOut() {
      if (opsCsrf.get() !== undefined)
        // TODO(protocol cookie-session): logout 加 scope 后，运营与控制台各传自己的 scope。
        await ops.auth.logout({}).catch(() => undefined);
      await client.auth.logout({}).catch(() => undefined);
      consoleCsrf.set(undefined);
      opsCsrf.set(undefined);
    },
  };
}
