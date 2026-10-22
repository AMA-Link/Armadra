import { readJsonFixture } from "@armadra/platform-protocol/fixtures";
import { describe, expect, it, vi } from "vitest";

import { createCloudApi } from "./client";
import { CloudConsoleError } from "./errors";
import { CSRF_HEADER } from "./session";

const fixture = <T>(name: string, key = "output") =>
  (readJsonFixture<Record<string, unknown>>(`cloud-api/${name}.json`)[key] ??
    readJsonFixture<{ outputs: unknown[] }>(`cloud-api/${name}.json`)
      .outputs[1]) as T;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Seen {
  method: string;
  path: string;
  csrf: string | null;
  authorization: string | null;
  credentials: RequestCredentials | undefined;
}

/** 假的来源：按「方法 路径」答，记下每次请求的头。 */
function origin(routes: Record<string, () => Response | Promise<Response>>) {
  const seen: Seen[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input as Request;
      const path = new URL(request.url).pathname;
      seen.push({
        method: request.method,
        path,
        csrf: request.headers.get(CSRF_HEADER),
        authorization: request.headers.get("authorization"),
        credentials: init?.credentials,
      });
      const route = routes[`${request.method} ${path}`];
      return route ? route() : json({ code: "not_found", message: "x" }, 404);
    },
  ) as unknown as typeof fetch;
  return { seen, fetcher };
}

const ME = fixture<Record<string, unknown>>("me.get");
const SESSION = fixture<Record<string, unknown>>("auth.refresh");

describe("控制台客户端", () => {
  it("Cookie 会话：credentials include、不带 Authorization，GET 不带 CSRF；me.get 的 csrfToken 记进内存", async () => {
    const { seen, fetcher } = origin({
      "GET /v1/me": () => json(ME),
      "POST /v1/me/email": () => json({}),
    });
    const api = createCloudApi({
      origin: "https://app.example",
      fetch: fetcher,
    });
    await expect(api.client.me.get({})).resolves.toMatchObject({
      email: "dev@armadra.test",
    });
    expect(seen[0]).toMatchObject({
      method: "GET",
      csrf: null,
      authorization: null,
      credentials: "include",
    });
    // 刷新页面后由 me.get 取回的值，之后的写操作带上。
    await api.client.me.emailChange({ newEmail: "x@y.test", password: "p" });
    expect(seen[1]).toMatchObject({
      method: "POST",
      path: "/v1/me/email",
      csrf: "test-csrf-token",
    });
  });

  it("GET 的嵌套入参按括号编码：space[kind]=team&space[teamId]=t1", async () => {
    const { seen, fetcher } = origin({
      "GET /v1/sources": () => json({ sources: [], nextCursor: null }),
    });
    const requests: string[] = [];
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push((input as Request).url);
      return fetcher(input, init);
    }) as unknown as typeof fetch;
    const api = createCloudApi({ origin: "https://app.example", fetch: spy });
    await api.client.sources.list({ space: { kind: "team", teamId: "t1" } });
    expect(seen[0]!.path).toBe("/v1/sources");
    expect(decodeURIComponent(new URL(requests[0]!).search)).toBe(
      "?space[kind]=team&space[teamId]=t1",
    );
  });

  it("登录类答案的 csrfToken 也记下；登出后清掉", async () => {
    const { seen, fetcher } = origin({
      "POST /v1/auth/refresh": () => json({ ...SESSION, csrfToken: "c2" }),
      "POST /v1/me/email": () => json({}),
      "POST /v1/auth/logout": () => json({}),
    });
    const api = createCloudApi({
      origin: "https://app.example",
      fetch: fetcher,
    });
    await api.client.auth.refresh({ refreshToken: "" });
    await api.client.me.emailChange({ newEmail: "x@y.test", password: "p" });
    expect(seen[1]!.csrf).toBe("c2");
    await api.signOut();
    expect(seen.at(-1)).toMatchObject({ path: "/v1/auth/logout", csrf: "c2" });
    await api.client.me.emailChange({ newEmail: "x@y.test", password: "p" });
    expect(seen.at(-1)!.csrf).toBeNull();
  });

  it("线上错误体变成 CloudConsoleError，带 code、状态与 details，不丢 requestId", async () => {
    const { fetcher } = origin({
      "GET /v1/me": () =>
        json(
          {
            code: "team_suspended",
            message: "后端原话",
            requestId: "r9",
            details: { teamId: "t" },
          },
          403,
        ),
    });
    const api = createCloudApi({
      origin: "https://app.example",
      fetch: fetcher,
    });
    const error = await api.client.me.get({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudConsoleError);
    expect(error).toMatchObject({
      code: "team_suspended",
      status: 403,
      requestId: "r9",
      details: { teamId: "t" },
    });
  });

  it("网络失败是 unavailable（状态 0）", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const api = createCloudApi({
      origin: "https://app.example",
      fetch: fetcher,
    });
    await expect(api.client.me.get({})).rejects.toMatchObject({
      code: "unavailable",
      status: 0,
    });
  });

  describe("刷新", () => {
    it("会话过期：auth.refresh 一次，再重发原请求；并发共用一次刷新", async () => {
      let fresh = false;
      const { seen, fetcher } = origin({
        "GET /v1/me": () =>
          fresh
            ? json(ME)
            : json({ code: "session_expired", message: "x" }, 401),
        "GET /v1/me/spaces": () =>
          fresh
            ? json(fixture("me.spaces"))
            : json({ code: "session_expired", message: "x" }, 401),
        "POST /v1/auth/refresh": () => {
          fresh = true;
          return json({ ...SESSION, csrfToken: "c3" });
        },
      });
      const api = createCloudApi({
        origin: "https://app.example",
        fetch: fetcher,
      });
      const lost = vi.fn();
      api.onSessionLost(lost);
      const [me, spaces] = await Promise.all([
        api.client.me.get({}),
        api.client.me.spaces({}),
      ]);
      expect(me.email).toBe("dev@armadra.test");
      expect(spaces.spaces).toHaveLength(2);
      expect(
        seen.filter((row) => row.path === "/v1/auth/refresh"),
      ).toHaveLength(1);
      expect(lost).not.toHaveBeenCalled();
    });

    it("刷新失败：通知会话失效，调用方拿到 session_expired", async () => {
      const { fetcher } = origin({
        "GET /v1/me": () =>
          json({ code: "session_expired", message: "x" }, 401),
        "POST /v1/auth/refresh": () =>
          json({ code: "session_expired", message: "x" }, 401),
      });
      const api = createCloudApi({
        origin: "https://app.example",
        fetch: fetcher,
      });
      const lost = vi.fn();
      api.onSessionLost(lost);
      await expect(api.client.me.get({})).rejects.toMatchObject({
        code: "session_expired",
      });
      expect(lost).toHaveBeenCalledTimes(1);
    });

    it("session_revoked 不刷新，直接失效", async () => {
      const { seen, fetcher } = origin({
        "GET /v1/me": () =>
          json({ code: "session_revoked", message: "x" }, 401),
      });
      const api = createCloudApi({
        origin: "https://app.example",
        fetch: fetcher,
      });
      const lost = vi.fn();
      api.onSessionLost(lost);
      await expect(api.client.me.get({})).rejects.toMatchObject({
        code: "session_revoked",
      });
      expect(seen.some((row) => row.path === "/v1/auth/refresh")).toBe(false);
      expect(lost).toHaveBeenCalledTimes(1);
    });

    it("登录本身的 401 不触发刷新", async () => {
      const { seen, fetcher } = origin({
        "POST /v1/auth/login": () =>
          json({ code: "credentials_invalid", message: "x" }, 401),
      });
      const api = createCloudApi({
        origin: "https://app.example",
        fetch: fetcher,
      });
      await expect(
        api.client.auth.login({
          account: "a@b.c",
          password: "p",
          device: { platform: "browser", name: "Web" },
        }),
      ).rejects.toMatchObject({ code: "credentials_invalid" });
      expect(seen).toHaveLength(1);
    });
  });

  describe("运营会话", () => {
    it("运营登录的 CSRF 值只给运营客户端，控制台客户端不受影响；到期不刷新直接失效", async () => {
      let expired = false;
      const { seen, fetcher } = origin({
        "POST /v1/auth/mfa/verify": () =>
          json({ ...SESSION, csrfToken: "ops-csrf" }),
        "PUT /v1/admin/accounts/a1/status": () =>
          expired
            ? json({ code: "unauthenticated", message: "x" }, 401)
            : json({}),
        "POST /v1/me/email": () => json({}),
      });
      const api = createCloudApi({
        origin: "https://app.example",
        fetch: fetcher,
      });
      const changed = vi.fn();
      api.operator.subscribe(changed);
      expect(api.operator.active()).toBe(false);
      await api.ops.auth.mfaVerify({ challengeId: "c", code: "123456" });
      expect(api.operator.active()).toBe(true);
      expect(changed).toHaveBeenCalledTimes(1);
      await api.client.me.emailChange({ newEmail: "x@y.test", password: "p" });
      expect(seen.at(-1)!.csrf).toBeNull();

      expired = true;
      const lost = vi.fn();
      api.onSessionLost(lost);
      await expect(
        api.ops.admin.accountStatus({
          accountId: "a1",
          status: "disabled",
          reason: "x",
        } as never),
      ).rejects.toMatchObject({ code: "unauthenticated" });
      expect(seen.some((row) => row.path === "/v1/auth/refresh")).toBe(false);
      expect(api.operator.active()).toBe(false);
      // 控制台会话不受影响。
      expect(lost).not.toHaveBeenCalled();
    });
  });
});
