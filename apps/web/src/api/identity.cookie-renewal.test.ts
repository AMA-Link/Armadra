import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Cookie 会话（服务器壳托管的页面、手机浏览器经 Gateway）在访问 Cookie 过期
 * 之后的透明续期（契约 §3.2）：`renewCookieSession`、本机源的 `fetch` 与流的
 * 4401 续凭据。
 */

const { BASE, mocks } = vi.hoisted(() => ({
  BASE: "https://armadra.lan:8443",
  mocks: { nativeShell: false },
}));

vi.mock("../host/native-session", async (original) => {
  const actual = await original<typeof import("../host/native-session")>();
  return { ...actual, isNativeShell: () => mocks.nativeShell };
});

vi.mock("./local-runtime", () => ({
  localRuntime: () => ({
    httpBase: BASE,
    wsBase: BASE.replace(/^http/, "ws"),
    viaServerShell: true,
  }),
  resetLocalRuntime: () => undefined,
}));

import {
  currentCsrf,
  rememberCsrf,
  renewCookieSession,
  resetIdentityCredentials,
} from "./identity";
import { request } from "./request";
import { localSource } from "./source";
import { createLocalConnection } from "../sources/connection";

const OLD = "a".repeat(43);
const NEW = "b".repeat(43);
const CSRF_ONLY = "c".repeat(43);

const session = (csrfToken?: string) => ({
  hostId: "h1",
  device: { deviceId: "d1", principalId: "p1" },
  scopes: [],
  expiresAtUnixMs: Date.now() + 15 * 60_000,
  ...(csrfToken === undefined ? {} : { csrfToken }),
});

type Call = { path: string; method: string; csrf: string | null };
let calls: Call[];
/** 服务端：访问 Cookie 还有没有效、刷新要哪一枚 CSRF、刷新 Cookie 还在不在。 */
let state: {
  accessValid: boolean;
  sessionCsrf: string;
  refreshValid: boolean;
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const unauthenticated = () =>
  reply(401, { code: "unauthenticated", message: "" });

async function serve(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(String(input));
  const method = (init.method ?? "GET").toUpperCase();
  const csrf = new Headers(init.headers).get("x-armadra-csrf");
  calls.push({ path: url.pathname, method, csrf });
  // 让并发的几次请求真的同时在途。
  await new Promise((resolve) => setTimeout(resolve, 1));
  switch (`${method} ${url.pathname}`) {
    case "GET /api/identity/session":
      return state.accessValid ? reply(200, session()) : unauthenticated();
    case "POST /api/identity/session/refresh":
      if (!state.refreshValid || csrf !== state.sessionCsrf)
        return unauthenticated();
      state.accessValid = true;
      state.sessionCsrf = NEW;
      return reply(200, session(NEW));
    case "POST /api/identity/session/csrf":
      if (!state.refreshValid) return unauthenticated();
      state.sessionCsrf = CSRF_ONLY;
      return reply(200, { csrfToken: CSRF_ONLY });
    default:
      if (!state.accessValid) return unauthenticated();
      if (method !== "GET" && csrf !== state.sessionCsrf)
        return reply(403, { code: "forbidden", message: "" });
      return reply(200, { ok: true, path: url.pathname });
  }
}

beforeEach(() => {
  calls = [];
  state = { accessValid: false, sessionCsrf: OLD, refreshValid: true };
  mocks.nativeShell = false;
  resetIdentityCredentials();
  vi.stubGlobal("fetch", vi.fn(serve));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetIdentityCredentials();
});

const refreshes = () =>
  calls.filter((call) => call.path === "/api/identity/session/refresh");

describe("renewCookieSession", () => {
  it("访问 Cookie 过期：先看一眼会话，再用手里的 CSRF 刷新一次", async () => {
    rememberCsrf(OLD);
    expect(await renewCookieSession()).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/identity/session",
      "POST /api/identity/session/refresh",
    ]);
    expect(refreshes()[0]?.csrf).toBe(OLD);
    expect(currentCsrf()).toBe(NEW);
  });

  it("同一窗口里几处同时要：只刷新一次", async () => {
    rememberCsrf(OLD);
    const results = await Promise.all([
      renewCookieSession(),
      renewCookieSession(),
      renewCookieSession(),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(refreshes()).toHaveLength(1);
  });

  it("别的窗口刚续过（Cookie 共用）：不再刷新，免得作废它那枚 CSRF", async () => {
    rememberCsrf(OLD);
    state.accessValid = true;
    expect(await renewCookieSession()).toBe(true);
    expect(refreshes()).toHaveLength(0);
  });

  it("刷新页面后内存里没有 CSRF：先换一枚再刷新", async () => {
    state.sessionCsrf = CSRF_ONLY;
    expect(await renewCookieSession()).toBe(true);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/identity/session",
      "/api/identity/session/csrf",
      "/api/identity/session/refresh",
    ]);
    expect(refreshes()[0]?.csrf).toBe(CSRF_ONLY);
  });

  it("手里那枚 CSRF 已被别处换掉：换一枚再刷新一次", async () => {
    rememberCsrf(OLD);
    state.sessionCsrf = "z".repeat(43);
    const original = state;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/session/csrf")) {
          original.sessionCsrf = CSRF_ONLY;
        }
        return serve(input, init);
      }),
    );
    expect(await renewCookieSession()).toBe(true);
    expect(refreshes().map((call) => call.csrf)).toEqual([OLD, CSRF_ONLY]);
  });

  it("刷新 Cookie 也不认了：答 false", async () => {
    rememberCsrf(OLD);
    state.refreshValid = false;
    expect(await renewCookieSession()).toBe(false);
  });

  it("Bearer 传输（桌面壳）不走这条：答 false，不发请求", async () => {
    mocks.nativeShell = true;
    expect(await renewCookieSession()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("跨窗口在同一把 Web Lock 里排队", async () => {
    const names: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: (name: string, task: () => Promise<unknown>) => {
          names.push(name);
          return task();
        },
      },
    });
    rememberCsrf(OLD);
    await renewCookieSession();
    expect(names).toContain("armadra.identity.session-refresh");
  });
});

describe("本机源的 Cookie 会话请求", () => {
  const schema = z.object({ ok: z.boolean(), path: z.string() });

  it("401 → 续一次 → 重放；调用方拿到的是重放的答复", async () => {
    rememberCsrf(OLD);
    await expect(request("/api/settings", schema)).resolves.toEqual({
      ok: true,
      path: "/api/settings",
    });
    expect(refreshes()).toHaveLength(1);
  });

  it("并发的几个请求共用一次刷新，写请求重放时带新的 CSRF", async () => {
    rememberCsrf(OLD);
    const answers = await Promise.all([
      request("/api/workspaces", schema),
      request("/api/settings", schema),
      request("/api/settings", schema, { method: "PATCH", body: "{}" }),
      request("/api/rpc/system/ping", schema, { method: "POST", body: "{}" }),
    ]);
    expect(answers).toHaveLength(4);
    expect(refreshes()).toHaveLength(1);
    const writes = calls.filter(
      (call) =>
        call.method !== "GET" && !call.path.startsWith("/api/identity/"),
    );
    // 每个写各两次：带旧令牌被 401，带新令牌重放成功。
    expect(writes.map((call) => call.csrf).sort()).toEqual(
      [OLD, OLD, NEW, NEW].sort(),
    );
  });

  it("续不上：调用方照旧拿到 401", async () => {
    rememberCsrf(OLD);
    state.refreshValid = false;
    await expect(request("/api/settings", schema)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("本机源 Cookie 模式经同一个 fetch：发往别处的请求不碰", async () => {
    rememberCsrf(OLD);
    const response = await localSource.fetch(
      "https://elsewhere.example/api/settings",
    );
    expect(response.status).toBe(401);
    expect(refreshes()).toHaveLength(0);
  });
});

describe("流被 4401 关掉之后", () => {
  it("本机源的连接在 Cookie 模式下也续凭据（续上就重连）", async () => {
    rememberCsrf(OLD);
    const connection = createLocalConnection();
    await expect(connection.renew()).resolves.toBeUndefined();
    expect(refreshes()).toHaveLength(1);
  });

  it("续不上：报未授权", async () => {
    rememberCsrf(OLD);
    state.refreshValid = false;
    const connection = createLocalConnection();
    await expect(connection.renew()).rejects.toThrow();
  });
});
