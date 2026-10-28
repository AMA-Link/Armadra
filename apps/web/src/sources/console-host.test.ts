import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type IdentitySession,
  resetIdentityCredentials,
  restoreHostedCredentials,
  setHostedSession,
} from "../api/identity";
import { setHostedRuntimeBase } from "../api/runtime-url";
import { memoryStorage, routedFetch } from "../mobile/testing";
import {
  type ChannelLike,
  announceConsoleSession,
  hostSessionKey,
  signOutHostTabs,
} from "./cloud-session-channel";
import {
  type ConsoleHostOptions,
  createConsoleHost,
  hostTooOld,
  versionBelow,
} from "./console-host";
import type { E2eChannels } from "./e2e/manager";
import type { RemoteStreamOptions } from "./remote-stream";
import type { EnterRouteOptions } from "./route-entry";

/**
 * 控制台的 `/h/`（设计 saas-host-open §2）：Cookie 会话要断言、会话记录按账号放在
 * `sessionStorage`、登出广播与认领、授予变化去抖重登、失败态与版本门。
 */

const ISSUER = "https://app.saas.example";
const HOST = "c".repeat(32);
const BASE = `https://${HOST}.src.saas.example`;
const ACCOUNT = "acct-a";

afterEach(() => {
  setHostedSession(null);
  setHostedRuntimeBase(null);
  resetIdentityCredentials();
});

const assertion = () => ({
  assertion: "jws.assertion",
  assertionExpiresAtMs: Date.now() + 300_000,
  relayToken: "relay.jwt",
  relayTokenExpiresAtMs: Date.now() + 3_600_000,
  relayOrigin: "https://relay.saas.example",
  relayBaseUrl: BASE,
  online: true,
});

const coreSession = (refresh: string) => ({
  hostId: HOST,
  expiresAtUnixMs: Date.now() + 900_000,
  csrfToken: "c".repeat(43),
  native: { accessToken: `access-${refresh}`, refreshToken: refresh },
});

const detail = (over: Record<string, unknown> = {}) => ({
  sourceId: HOST,
  name: "host1",
  kind: "server",
  online: true,
  lastSeenAtMs: 1,
  owner: false,
  via: "team",
  relayOrigin: "https://relay.saas.example",
  coreVersion: "0.11.0",
  space: { kind: "team", teamId: "team-1" },
  trustedOrigins: [],
  capabilities: [],
  registeredAtMs: 1,
  ...over,
});

const identitySession = (
  principalId: string,
  role = "member",
  scopes: { permission: string; workspaceId: string }[] = [],
): IdentitySession =>
  ({
    hostId: HOST,
    device: {
      deviceId: "d1",
      principalId,
      displayName: "",
      role,
      createdAtUnixMs: 0,
      revision: 0,
    },
    scopes,
    expiresAtUnixMs: 0,
  }) as IdentitySession;

/** 同源的几个标签页：`postMessage` 发给别的成员（不发给自己），异步。 */
function channelBus() {
  const members = new Set<{
    listener: ((event: { data: unknown }) => void) | null;
  }>();
  return {
    open(): ChannelLike {
      const self = {
        listener: null as ((event: { data: unknown }) => void) | null,
      };
      members.add(self);
      return {
        postMessage(data) {
          for (const other of members)
            if (other !== self)
              queueMicrotask(() => other.listener?.({ data }));
        },
        addEventListener(_type, listener) {
          self.listener = listener;
        },
        close: () => members.delete(self),
      };
    },
  };
}

/** 卸下过的路由（`dispose` 调过几次，按进入的先后）。 */
const routes: { disposed: number }[] = [];

/** 不碰真本机源：取访问、装上这一路，就当装好了。 */
const fakeEnter = async (options: EnterRouteOptions) => {
  const access = await options.provider.getAccess(
    options.descriptor.sourceId,
    "relayed",
  );
  const route = { via: "relayed" as const, access };
  options.useRoute(route);
  const record = { disposed: 0 };
  routes.push(record);
  return {
    route,
    renew: async () => true,
    recover: async () => true,
    dispose: () => {
      record.disposed += 1;
    },
  };
};

function setup(
  over: {
    storage?: Storage;
    bus?: ReturnType<typeof channelBus>;
    me?: () => Promise<unknown>;
    detail?: () => Promise<unknown>;
    assertion?: () => Promise<unknown>;
    login?: () => { status?: number; body: unknown };
    principal?: string;
    timers?: (() => void)[];
    later?: (run: () => void, ms: number) => unknown;
  } = {},
) {
  const storage = over.storage ?? memoryStorage();
  let refreshed = 0;
  let logins = 0;
  const net = routedFetch({
    "POST /api/identity/cloud/login": () => {
      logins += 1;
      return (
        over.login?.() ?? { body: { session: coreSession(`login-${logins}`) } }
      );
    },
    "POST /api/identity/session/refresh": () => {
      refreshed += 1;
      return { body: coreSession(`rotated-${refreshed}`) };
    },
  });
  const awaitApproval = vi.fn(async () => true as const);
  const e2e = {
    channel: async () => ({ sas: "000000" }),
    fetchFor: () => net.fetch,
    socketFor: () => globalThis.WebSocket,
    awaitApproval,
    pinned: () => true,
    forget: () => undefined,
    close: () => undefined,
  } as unknown as E2eChannels;
  const client = {
    me: {
      get: vi.fn(
        over.me ??
          (async () => ({
            accountId: ACCOUNT,
            teams: [
              {
                teamId: "team-1",
                slug: "test-team",
                name: "T",
                role: "member",
              },
            ],
          })),
      ),
      streamTicket: vi.fn(async () => ({ ticket: "cookie-ticket" })),
    },
    sources: {
      get: vi.fn(over.detail ?? (async () => detail())),
      assertion: vi.fn(over.assertion ?? (async () => assertion())),
    },
  };
  const streams: RemoteStreamOptions[] = [];
  const identity = {
    resume: vi.fn(async () => identitySession(over.principal ?? "p-1")),
    logout: vi.fn(async () => undefined),
    restore: vi.fn((notify: boolean) => restoreHostedCredentials(notify)),
  };
  const timers = over.timers ?? [];
  let now = 0;
  const options: ConsoleHostOptions = {
    hostId: HOST,
    issuer: ISSUER,
    client: client as never,
    storage,
    channel: (over.bus ?? channelBus()).open(),
    e2e,
    identity,
    scheduler: {
      now: () => now,
      setTimeout: (run) => {
        timers.push(run);
        return timers.length;
      },
      clearTimeout: () => undefined,
    },
    setTimeout: over.later ?? ((run) => setTimeout(run, 0)),
    entry: {
      enter: fakeEnter,
      mount: (() => ({
        registry: { list: () => [], get: () => undefined },
        dispose: () => undefined,
      })) as never,
      wake: () => undefined,
      createStream: (stream) => {
        streams.push(stream);
        return { issuer: ISSUER, state: "open", close: () => undefined };
      },
      cloud: { fetch: net.fetch },
    },
  };
  const host = createConsoleHost(options);
  return {
    host,
    client,
    net,
    storage,
    identity,
    awaitApproval,
    timers,
    streams,
    logins: () => logins,
    refreshes: () => refreshed,
    advance: (ms: number) => {
      now += ms;
    },
    options,
  };
}

const key = hostSessionKey(ACCOUNT, HOST);
const record = (storage: Storage) =>
  JSON.parse(storage.getItem(key) ?? "null") as Record<string, string> | null;

describe("控制台 /h/ 进主机", () => {
  it("新设备：待确认 → 放行 → 进入；会话记录按账号存进 sessionStorage，记下主体", async () => {
    let pending = true;
    const ctx = setup({
      login: () => {
        if (pending) {
          pending = false;
          return {
            status: 403,
            body: {
              code: "device_pending",
              message: "",
              details: { pendingId: "pend-1" },
            },
          };
        }
        return { body: { session: coreSession("login-ok") } };
      },
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "entered" });
    expect(ctx.awaitApproval).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: HOST }),
      expect.anything(),
      "pend-1",
    );
    expect(ctx.client.sources.assertion).toHaveBeenCalledWith({
      sourceId: HOST,
      device: expect.objectContaining({ platform: "browser" }),
    });
    expect(record(ctx.storage)).toMatchObject({
      refreshToken: "login-ok",
      principalId: "p-1",
    });
    expect(ctx.host.info).toMatchObject({
      name: "host1",
      space: "team",
      consoleHref: `/t/test-team/hosts/${HOST}`,
    });
    // me.stream 用 Cookie 票。
    expect(await ctx.streams[0]!.ticket?.()).toBe("cookie-ticket");
    expect(ctx.streams[0]!.auth).toBeUndefined();
  });

  it("刷新页面：用记下的刷新令牌经通道轮换，不再 cloud/login", async () => {
    const first = setup();
    await first.host.open();
    expect(first.logins()).toBe(1);
    first.host.dispose();
    resetIdentityCredentials();
    const second = setup({ storage: first.storage });
    await second.host.open();
    expect(second.host.view.kind).toBe("entered");
    expect(second.logins()).toBe(0);
    expect(second.refreshes()).toBe(1);
  });

  it("同一个标签页换了账号：上一位的记录丢掉，重新 cloud/login", async () => {
    const storage = memoryStorage();
    storage.setItem(
      hostSessionKey("acct-old", HOST),
      JSON.stringify({ refreshToken: "old-r", principalId: "p-old" }),
    );
    const ctx = setup({ storage });
    await ctx.host.open();
    expect(storage.getItem(hostSessionKey("acct-old", HOST))).toBeNull();
    expect(ctx.logins()).toBe(1);
    expect(ctx.refreshes()).toBe(0);
  });

  it("续上的会话主体与记下的不同：丢弃这份，cloud/login 一次后进入", async () => {
    const storage = memoryStorage();
    storage.setItem(
      key,
      JSON.stringify({ refreshToken: "r0", principalId: "p-old" }),
    );
    const ctx = setup({ storage, principal: "p-new" });
    await ctx.host.open();
    expect(ctx.host.view.kind).toBe("entered");
    expect(ctx.refreshes()).toBe(1);
    expect(ctx.logins()).toBe(1);
    expect(record(storage)).toMatchObject({ principalId: "p-new" });
  });

  it("别的标签页里控制台登出：本页 session/logout、清记录、盖上已登出", async () => {
    const bus = channelBus();
    const ctx = setup({ bus });
    await ctx.host.open();
    expect(record(ctx.storage)).not.toBeNull();
    const console = bus.open();
    console.postMessage({ type: "signedOut" });
    await vi.waitFor(() => expect(ctx.host.view.kind).toBe("signedOut"));
    expect(ctx.identity.logout).toHaveBeenCalledTimes(1);
    expect(record(ctx.storage)).toBeNull();
  });

  it("控制台登出前先让 /h/ 经通道 session/logout，登出完才放行（之后中继会断开通道）", async () => {
    const bus = channelBus();
    const ctx = setup({ bus });
    await ctx.host.open();
    let finished = false;
    ctx.identity.logout.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    });
    await signOutHostTabs(
      bus.open(),
      (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 30))),
    );
    expect(ctx.identity.logout).toHaveBeenCalledTimes(1);
    expect(finished).toBe(true);
    expect(ctx.host.view.kind).toBe("signedOut");
    // 随后的 signedOut 收尾不再登出第二次。
    bus.open().postMessage({ type: "signedOut" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.identity.logout).toHaveBeenCalledTimes(1);
  });

  it("登出先丢本地记录、再经通道吊销；吊销卡住也按时收尾", async () => {
    const bus = channelBus();
    const ctx = setup({ bus });
    await ctx.host.open();
    let recordAtLogout: unknown = "unset";
    ctx.identity.logout.mockImplementation(() => {
      recordAtLogout = record(ctx.storage);
      return new Promise<undefined>(() => undefined);
    });
    await ctx.host.signOut();
    expect(recordAtLogout).toBeNull();
    expect(ctx.host.view.kind).toBe("signedOut");
  });

  it("进入被限流：按对端给的 Retry-After 再试，没给就从 5 秒起翻倍", async () => {
    const delays: number[] = [];
    const pending: (() => void)[] = [];
    let retryAfterMs: number | undefined = 7_000;
    const ctx = setup({
      assertion: async () => {
        throw Object.assign(new Error("429"), {
          status: 429,
          code: "rate_limited",
          ...(retryAfterMs === undefined ? {} : { details: { retryAfterMs } }),
        });
      },
      later: (run, ms) => {
        // 认领的等待照常跑；记下其余的延时。
        if (ms > 1_000) {
          delays.push(ms);
          pending.push(run);
        } else setTimeout(run, 0);
        return 0;
      },
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "connecting", rateLimited: true });
    expect(delays).toEqual([7_000]);
    retryAfterMs = undefined;
    pending.shift()!();
    await vi.waitFor(() => expect(delays).toHaveLength(2));
    pending.shift()!();
    await vi.waitFor(() => expect(delays).toHaveLength(3));
    expect(delays.slice(1)).toEqual([10_000, 20_000]);
  });

  it("重登被限流：按 Retry-After 再排一次重登", async () => {
    const delays: number[] = [];
    const pending: (() => void)[] = [];
    let limited = false;
    const ctx = setup({
      login: () =>
        limited
          ? {
              status: 429,
              body: {
                code: "rate_limited",
                message: "",
                details: { retryAfterMs: 9_000 },
              },
            }
          : { body: { session: coreSession("login-1") } },
      later: (run, ms) => {
        if (ms > 1_000) {
          delays.push(ms);
          pending.push(run);
        } else setTimeout(run, 0);
        return 0;
      },
    });
    await ctx.host.open();
    limited = true;
    ctx.streams[0]!.onEvent({ type: "grantChanged", sourceId: HOST });
    ctx.timers.shift()!();
    await vi.waitFor(() => expect(delays).toEqual([9_000]));
    limited = false;
    pending.shift()!();
    // 再排的那一次仍经去抖：排上了一个新的重登计时。
    await vi.waitFor(() => expect(ctx.timers.length).toBeGreaterThan(0));
    ctx.advance(60_000);
    ctx.timers.shift()!();
    await vi.waitFor(() => expect(ctx.logins()).toBe(3));
    expect(ctx.host.view.kind).toBe("entered");
  });

  it("换账号的广播：别的账号 → 登出；同一个账号不动", async () => {
    const bus = channelBus();
    const ctx = setup({ bus });
    await ctx.host.open();
    const console = bus.open();
    console.postMessage({ type: "accountChanged", accountId: ACCOUNT });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.host.view.kind).toBe("entered");
    console.postMessage({ type: "accountChanged", accountId: "acct-b" });
    await vi.waitFor(() => expect(ctx.host.view.kind).toBe("signedOut"));
  });

  it("控制台这一侧：登出清本标签页全部 armadra.host.*；换账号只留新账号的", () => {
    const storage = memoryStorage();
    storage.setItem(hostSessionKey("a", HOST), "{}");
    storage.setItem(hostSessionKey("b", HOST), "{}");
    storage.setItem("other", "1");
    const sent: unknown[] = [];
    const channel = {
      postMessage: (data: unknown) => void sent.push(data),
      addEventListener: () => undefined,
    };
    announceConsoleSession(
      { type: "accountChanged", accountId: "b" },
      storage,
      channel,
    );
    expect(storage.getItem(hostSessionKey("a", HOST))).toBeNull();
    expect(storage.getItem(hostSessionKey("b", HOST))).toBe("{}");
    announceConsoleSession({ type: "signedOut" }, storage, channel);
    expect(storage.getItem(hostSessionKey("b", HOST))).toBeNull();
    expect(storage.getItem("other")).toBe("1");
    expect(sent).toEqual([
      { type: "accountChanged", accountId: "b" },
      { type: "signedOut" },
    ]);
  });

  it("复制出的标签页：原标签页认领同一份记录，新标签页让出、重登一次", async () => {
    const bus = channelBus();
    const original = setup({ bus });
    await original.host.open();
    // 复制标签页连同 sessionStorage 一起复制。
    const copied = memoryStorage();
    copied.setItem(key, original.storage.getItem(key)!);
    const duplicate = setup({ bus, storage: copied });
    await duplicate.host.open();
    expect(duplicate.host.view.kind).toBe("entered");
    expect(duplicate.refreshes()).toBe(0);
    expect(duplicate.logins()).toBe(1);
  });

  it("grantChanged 与自己的 memberChanged：去抖合并，2 秒内 5 个事件只重登一次，带当前刷新令牌", async () => {
    const ctx = setup();
    await ctx.host.open();
    const stream = ctx.streams[0]!;
    for (let at = 0; at < 4; at += 1)
      stream.onEvent({ type: "grantChanged", sourceId: HOST });
    stream.onEvent({
      type: "memberChanged",
      teamId: "team-1",
      accountId: ACCOUNT,
    });
    // 别人的成员事件、别的主机的授予不算。
    stream.onEvent({ type: "memberChanged", teamId: "team-1", accountId: "x" });
    stream.onEvent({ type: "grantChanged", sourceId: "d".repeat(32) });
    expect(ctx.timers).toHaveLength(1);
    ctx.advance(2_000);
    ctx.timers[0]!();
    await vi.waitFor(() => expect(ctx.logins()).toBe(2));
    const relogin = ctx.net.calls.filter((call) =>
      call.key.endsWith("cloud/login"),
    )[1]!;
    expect(JSON.parse(String(relogin.init.body))).toMatchObject({
      refreshToken: "login-1",
    });
    expect(ctx.identity.restore).toHaveBeenCalledWith(true);
    expect(ctx.refreshes()).toBe(0);
  });

  it("source_access_denied 按版本分两种：团队主机低于门槛是版本太旧，否则没有权限", async () => {
    const denied = async () => {
      throw Object.assign(new Error("denied"), {
        status: 403,
        code: "source_access_denied",
      });
    };
    const old = setup({
      assertion: denied,
      detail: async () => detail({ coreVersion: "0.9.4" }),
    });
    await old.host.open();
    expect(old.host.view).toEqual({ kind: "failed", code: "source_too_old" });
    const current = setup({ assertion: denied });
    await current.host.open();
    expect(current.host.view).toEqual({
      kind: "failed",
      code: "source_access_denied",
    });
  });

  it("没有控制台会话：去登录；主机不存在：找不到；离线：等上线", async () => {
    const signedOut = setup({
      me: async () => {
        throw Object.assign(new Error("401"), {
          status: 401,
          code: "unauthenticated",
        });
      },
    });
    await signedOut.host.open();
    expect(signedOut.host.view).toEqual({ kind: "login" });
    const missing = setup({
      detail: async () => {
        throw Object.assign(new Error("404"), {
          status: 404,
          code: "not_found",
        });
      },
    });
    await missing.host.open();
    expect(missing.host.view).toEqual({ kind: "failed", code: "not_found" });
    let online = false;
    const offline = setup({ detail: async () => detail({ online }) });
    await offline.host.open();
    expect(offline.host.view).toMatchObject({ kind: "offline" });
    online = true;
    offline.streams[0]!.onEvent({ type: "sourceOnline", sourceId: HOST });
    await vi.waitFor(() => expect(offline.host.view.kind).toBe("entered"));
  });

  it("进去之后 Cookie 会话失效：只冻结（expired），不跳登录", async () => {
    let expired = false;
    const ctx = setup({
      assertion: async () => {
        if (expired)
          throw Object.assign(new Error("401"), {
            status: 401,
            code: "unauthenticated",
          });
        return assertion();
      },
    });
    await ctx.host.open();
    expired = true;
    ctx.streams[0]!.onEvent({ type: "grantChanged", sourceId: HOST });
    ctx.timers[0]!();
    await vi.waitFor(() => expect(ctx.host.view).toEqual({ kind: "expired" }));
  });

  it("同一个实例再次 open、中途换了账号：先经旧路由吊销上一位的会话，再卸下旧路由", async () => {
    routes.length = 0;
    let account = ACCOUNT;
    const ctx = setup({
      me: async () => ({ accountId: account, teams: [] }),
    });
    await ctx.host.open();
    expect(ctx.host.view.kind).toBe("entered");
    expect(routes).toHaveLength(1);
    const oldKey = hostSessionKey(ACCOUNT, HOST);
    expect(ctx.storage.getItem(oldKey)).not.toBeNull();
    account = "acct-b";
    await ctx.host.open();
    expect(ctx.identity.logout).toHaveBeenCalledTimes(1);
    expect(routes[0]!.disposed).toBeGreaterThan(0);
    expect(routes).toHaveLength(2);
    expect(routes[1]!.disposed).toBe(0);
    expect(ctx.storage.getItem(oldKey)).toBeNull();
    // 新账号重新 cloud/login，不拿上一位的刷新令牌续。
    expect(ctx.logins()).toBe(2);
    expect(ctx.refreshes()).toBe(0);
  });

  it("进行中的 open 遇到登出：醒来不覆盖「已登出」、不写回记录、刚装上的路由卸下", async () => {
    routes.length = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bus = channelBus();
    const ctx = setup({
      bus,
      assertion: async () => {
        await gate;
        return assertion();
      },
    });
    const opening = ctx.host.open();
    await vi.waitFor(() =>
      expect(ctx.client.sources.assertion).toHaveBeenCalled(),
    );
    bus.open().postMessage({ type: "signedOut" });
    await vi.waitFor(() => expect(ctx.host.view.kind).toBe("signedOut"));
    release();
    await opening;
    expect(ctx.host.view.kind).toBe("signedOut");
    expect(record(ctx.storage)).toBeNull();
    for (const route of routes) expect(route.disposed).toBeGreaterThan(0);
  });

  it("同一个账号再次 open：卸下旧路由，不登出", async () => {
    routes.length = 0;
    const ctx = setup();
    await ctx.host.open();
    await ctx.host.open();
    expect(ctx.identity.logout).not.toHaveBeenCalled();
    expect(routes[0]!.disposed).toBeGreaterThan(0);
    expect(ctx.host.view.kind).toBe("entered");
  });

  it("主人映射：控制台说是主人、主机侧会话没有 settings:write → ownerMismatch", async () => {
    const ctx = setup({ detail: async () => detail({ owner: true }) });
    await ctx.host.open();
    expect(ctx.host.ownerMismatch).toBe(true);
  });
});

describe("版本门", () => {
  it("比 major.minor.patch；认不出的不算旧", () => {
    expect(versionBelow("0.9.9", "0.10.0")).toBe(true);
    expect(versionBelow("0.10.0", "0.10.0")).toBe(false);
    expect(versionBelow("v0.11.2-rc.1", "0.11.0")).toBe(false);
    expect(versionBelow("dev", "0.10.0")).toBe(false);
  });

  it("团队主机按团队门槛；个人空间别人的主机按 role-only 门槛；自己的个人主机没有门", () => {
    expect(hostTooOld(detail({ coreVersion: "0.9.0" }) as never)).toBe(true);
    expect(
      hostTooOld(
        detail({
          coreVersion: "0.10.0",
          space: undefined,
          owner: false,
        }) as never,
      ),
    ).toBe(true);
    expect(
      hostTooOld(
        detail({
          coreVersion: "0.1.0",
          space: undefined,
          owner: true,
        }) as never,
      ),
    ).toBe(false);
  });
});
