import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { cloudContract } from "@armadra/platform-protocol/cloud-api";

import { CloudConsoleError, toCloudError } from "./errors";
import { createRefreshCoordinator } from "./refresh-lock";
import { openMeStream } from "./stream";
import {
  createCloudFetch,
  createCsrfStore,
  type CloudApi,
  type CloudFetchOptions,
  type InvitationPreview,
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
 * `auth.refresh`（Cookie 会话，刷新令牌在 Cookie 里，入参为空）再重发；运营会话
 * 同样先 `auth.refresh { scope: "operator" }`，续不上就算失效，回 `/login?scope=operator` 重新登录。
 */
export function createCloudApi(options: CreateCloudApiOptions): CloudApi {
  const base = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const consoleCsrf = createCsrfStore();
  const opsCsrf = createCsrfStore();
  const lost = new Set<() => void>();
  // 跨标签串行化刷新，控制台与运营各自一把锁（#516）。
  const consoleRefresh = createRefreshCoordinator({
    name: "console",
    csrf: consoleCsrf,
  });
  const opsRefresh = createRefreshCoordinator({ name: "ops", csrf: opsCsrf });

  // 刷新请求限时 15 秒，挂住时不占着跨标签的锁。
  const timed: typeof base = (input, init) =>
    base(input, { ...init, signal: AbortSignal.timeout(15_000) });
  // 刷新自己不走 401 处理，免得递归。
  const plain = createCloudClient(
    options.origin,
    createCloudFetch({
      fetch: timed,
      csrf: consoleCsrf,
      onSessionLost: () => {},
    }),
  );
  const common = (csrf: CloudFetchOptions["csrf"]) => ({
    fetch: base,
    csrf,
  });
  const consoleFetch = createCloudFetch({
    ...common(consoleCsrf),
    refresh: (since) =>
      consoleRefresh.run(since, async () => {
        await plain.auth.refresh({});
      }),
    onSessionLost() {
      consoleCsrf.set(undefined);
      for (const listener of [...lost]) listener();
    },
  });
  const client = createCloudClient(options.origin, consoleFetch);
  const opsPlain = createCloudClient(
    options.origin,
    createCloudFetch({
      fetch: timed,
      csrf: opsCsrf,
      onSessionLost: () => undefined,
    }),
  );
  const ops = createCloudClient(
    options.origin,
    createCloudFetch({
      ...common(opsCsrf),
      refresh: (since) =>
        opsRefresh.run(since, async () => {
          await opsPlain.auth.refresh({ scope: "operator" });
        }),
      onSessionLost: () => opsCsrf.set(undefined),
    }),
  );

  return {
    client,
    ops,
    async ensureCsrf() {
      if (consoleCsrf.get() !== undefined) return true;
      try {
        await consoleRefresh.run(
          Date.now(),
          async () => {
            await plain.auth.refresh({});
          },
          () => consoleCsrf.get() !== undefined,
        );
        return consoleCsrf.get() !== undefined;
      } catch {
        return false;
      }
    },
    invitationPreview: (invitationId, token) =>
      previewInvitation(options.origin, consoleFetch, invitationId, token),
    operator: {
      active: () => opsCsrf.get() !== undefined,
      subscribe: opsCsrf.subscribe,
    },
    stream: (handlers) =>
      openMeStream(
        {
          origin: options.origin,
          ticket: () => client.me.streamTicket({}),
        },
        handlers,
      ),
    onSessionLost(listener) {
      lost.add(listener);
      return () => lost.delete(listener);
    },
    async signOut() {
      if (opsCsrf.get() !== undefined)
        await ops.auth.logout({ scope: "operator" }).catch(() => undefined);
      await client.auth.logout({}).catch(() => undefined);
      consoleCsrf.set(undefined);
      opsCsrf.set(undefined);
    },
  };
}

const previewOutput = cloudContract.invitations.get["~orpc"]
  .outputSchema as unknown as { parse(value: unknown): InvitationPreview };

/**
 * `invitations.preview` 的手写调用（cloud-api §22，协议包 0.11.0 起才有）：同一个控制台 fetch
 * （同源、Cookie、错误形状一致），答复按 `invitations.get` 的形状解析。升到 0.11.0 后删掉，
 * 改用 `client.invitations.preview`。
 */
async function previewInvitation(
  origin: string,
  send: typeof fetch,
  invitationId: string,
  token: string,
): Promise<InvitationPreview> {
  let response: Response;
  try {
    response = await send(
      new Request(
        `${origin}/v1/invitations/${encodeURIComponent(invitationId)}/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
      ),
    );
  } catch (error) {
    throw toCloudError(error);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const wire = body as { code?: unknown; message?: unknown } | null;
    throw typeof wire?.code === "string"
      ? new CloudConsoleError(
          wire.code,
          response.status,
          typeof wire.message === "string" ? wire.message : undefined,
        )
      : toCloudError({ status: response.status });
  }
  return previewOutput.parse(body);
}
