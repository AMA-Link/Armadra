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
  type GuestRelay,
  createConsoleHost,
  hostTooOld,
  versionBelow,
} from "./console-host";
import type { E2eChannels } from "./e2e/manager";
import type { LinkResume } from "./hosted";
import { guestKey, guestLinkFor } from "./relay-vault";
import type { RelayedStatus } from "./relayed-entry";
import type { RemoteStreamOptions } from "./remote-stream";
import { SourceError } from "./types";
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
    enter?: typeof fakeEnter;
    guestStorage?: Storage;
    guestRelay?: () => GuestRelay;
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
    guestStorage: over.guestStorage ?? memoryStorage(),
    ...(over.guestRelay === undefined ? {} : { guestRelay: over.guestRelay }),
    entry: {
      enter: over.enter ?? fakeEnter,
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

  it("memberChanged 只认自己、同团队的：别人的、别的团队的、没带账号的都不重登", async () => {
    const ctx = setup();
    await ctx.host.open();
    const stream = ctx.streams[0]!;
    stream.onEvent({ type: "memberChanged", teamId: "team-1", accountId: "x" });
    stream.onEvent({
      type: "memberChanged",
      teamId: "team-2",
      accountId: ACCOUNT,
    });
    stream.onEvent({ type: "memberChanged", teamId: "team-1" });
    stream.onEvent({ type: "grantChanged", sourceId: "d".repeat(32) });
    expect(ctx.timers).toHaveLength(0);
    stream.onEvent({
      type: "memberChanged",
      teamId: "team-1",
      accountId: ACCOUNT,
    });
    expect(ctx.timers).toHaveLength(1);
  });

  it("限流后登出：排下的重试取消，到点也不把会话登回来", async () => {
    const pending: (() => void)[] = [];
    let limited = true;
    const ctx = setup({
      assertion: async () => {
        if (limited)
          throw Object.assign(new Error("429"), {
            status: 429,
            code: "rate_limited",
          });
        return assertion();
      },
      later: (run, ms) => {
        if (ms > 1_000) pending.push(run);
        else setTimeout(run, 0);
        return pending.length;
      },
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "connecting", rateLimited: true });
    await ctx.host.signOut();
    expect(ctx.host.view.kind).toBe("signedOut");
    limited = false;
    // 即使计时器照样到点（取消不了的环境），回调也认出自己过时了。
    for (const run of pending.splice(0)) run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.host.view.kind).toBe("signedOut");
    expect(ctx.logins()).toBe(0);
    expect(record(ctx.storage)).toBeNull();
  });

  it("登出之后别的入口不会自动重新进入：sourceOnline、授予与成员事件、换账号广播", async () => {
    const bus = channelBus();
    let online = false;
    const ctx = setup({ bus, detail: async () => detail({ online }) });
    await ctx.host.open();
    expect(ctx.host.view.kind).toBe("offline");
    const waiting = ctx.streams[0]!;
    await ctx.host.signOut();
    online = true;
    waiting.onEvent({ type: "sourceOnline", sourceId: HOST });
    bus.open().postMessage({ type: "accountChanged", accountId: "acct-b" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.host.view.kind).toBe("signedOut");
    expect(ctx.logins()).toBe(0);
    expect(ctx.client.sources.assertion).not.toHaveBeenCalled();
  });

  it("授予事件在登出之后到：重登不再要断言，也不登回来", async () => {
    const ctx = setup();
    await ctx.host.open();
    const stream = ctx.streams[0]!;
    await ctx.host.signOut();
    const asked = ctx.client.sources.assertion.mock.calls.length;
    stream.onEvent({ type: "grantChanged", sourceId: HOST });
    stream.onEvent({
      type: "memberChanged",
      teamId: "team-1",
      accountId: ACCOUNT,
    });
    for (const run of ctx.timers.splice(0)) run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.client.sources.assertion.mock.calls.length).toBe(asked);
    expect(ctx.logins()).toBe(1);
    expect(ctx.host.view.kind).toBe("signedOut");
  });

  it("enter 成功之后才发现已登出：刚装上的路由卸下，视图仍是已登出", async () => {
    routes.length = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let host: ReturnType<typeof setup>["host"] | null = null;
    const ctx = setup({
      enter: async (options) => {
        const entered = await fakeEnter(options);
        // 路由已经装上、enter 还没返回时登出。
        void host!.signOut();
        await gate;
        return entered;
      },
    });
    host = ctx.host;
    const opening = ctx.host.open();
    await vi.waitFor(() => expect(routes).toHaveLength(1));
    await vi.waitFor(() => expect(ctx.host.view.kind).toBe("signedOut"));
    release();
    await opening;
    expect(ctx.host.view.kind).toBe("signedOut");
    expect(routes[0]!.disposed).toBeGreaterThan(0);
    expect(record(ctx.storage)).toBeNull();
  });

  it("慢的旧 open 在新 open 之后才醒来：不改视图、不写记录", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const ctx = setup({
      me: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return { accountId: calls === 1 ? "acct-old" : ACCOUNT, teams: [] };
      },
    });
    const slow = ctx.host.open();
    await vi.waitFor(() => expect(calls).toBe(1));
    await ctx.host.open();
    expect(ctx.host.view.kind).toBe("entered");
    const before = ctx.storage.getItem(key);
    const views: string[] = [];
    ctx.host.subscribe(() => views.push(ctx.host.view.kind));
    release();
    await slow;
    expect(views).toEqual([]);
    expect(ctx.host.view.kind).toBe("entered");
    expect(ctx.storage.getItem(key)).toBe(before);
    expect(ctx.storage.getItem(hostSessionKey("acct-old", HOST))).toBeNull();
    expect(ctx.logins()).toBe(1);
  });

  it("主机身份变了：视图只带对端指纹的前 16 位", async () => {
    const full = "0123456789abcdef".repeat(4);
    const ctx = setup({
      enter: async () => {
        throw new SourceError("identity_changed", "identity changed", {
          cause: { fingerprint: full },
        });
      },
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({
      kind: "failed",
      code: "identity_changed",
      fingerprint: "0123456789abcdef",
    });
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

/* ------------------------------ 访客（§2.8） ------------------------------ */

const LINK = "link-1";
const SHARE = { role: "viewer", name: "host1", ownerName: "", expiresAtMs: 0 };

/** 托管页那份访客记录：进过 `sourceId`，链接 `linkId`；`acceptedBy` 缺省匿名，`null` = 旧记录没有这一项。 */
function guestRecord(
  storage: Storage,
  linkId: string,
  sourceId: string,
  expiresAtMs?: number,
  acceptedBy: string | null = "",
) {
  storage.setItem(
    guestKey(ISSUER, linkId),
    JSON.stringify({
      issuer: ISSUER,
      cloudRefreshToken: `guest-refresh-${linkId}`,
      sources: {},
      entered: { sourceId, name: "host1" },
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      ...(acceptedBy === null ? {} : { acceptedBy }),
    }),
  );
}

/** 假托管中继：`resumeLink` 按给的答，状态可以由测试改。 */
function fakeGuest(answer: () => LinkResume) {
  const listeners = new Set<() => void>();
  let entered = false;
  const relay = {
    status: {
      state: "ready",
      lastError: null,
      relayDown: false,
    } as RelayedStatus,
    resumeLink: vi.fn(async (_linkId: string) => {
      const resumed = answer();
      entered = resumed?.kind === "entered";
      return resumed;
    }),
    guest: () => (entered ? SHARE : null),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signOut: vi.fn(async () => undefined),
    close: vi.fn(),
    /** 测试：托管中继的状态变了（如访问被收回）。 */
    set(status: RelayedStatus) {
      relay.status = status;
      for (const listener of listeners) listener();
    },
  };
  return relay;
}

const unauthenticated = async () => {
  throw Object.assign(new Error("401"), {
    status: 401,
    code: "unauthenticated",
  });
};

describe("控制台 /h/ 以访客进入（§2.8）", () => {
  it("没有 Cookie 会话、有这台主机的访客记录：经托管中继以访客进入，不去登录、不要断言", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, "link-other", "d".repeat(32));
    guestRecord(guestStorage, LINK, HOST);
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const ctx = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => relay,
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "entered" });
    expect(relay.resumeLink).toHaveBeenCalledExactlyOnceWith(LINK, null);
    expect(ctx.host.guest()).toEqual(SHARE);
    expect(ctx.host.info).toMatchObject({ name: "host1", guest: true });
    expect(ctx.host.status).toBe(relay.status);
    expect(ctx.client.sources.get).not.toHaveBeenCalled();
    expect(ctx.client.sources.assertion).not.toHaveBeenCalled();
    expect(ctx.logins()).toBe(0);
  });

  it("没有 Cookie 会话、访客记录是别的主机的或已到期：照旧去登录", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, "link-other", "d".repeat(32));
    guestRecord(guestStorage, "link-old", HOST, Date.now() - 1);
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const ctx = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => relay,
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "login" });
    expect(relay.resumeLink).not.toHaveBeenCalled();
  });

  it("Cookie 账号看不到这台（not_found）或断言答没有权限：退回访客记录", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const hidden = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const notListed = setup({
      detail: async () => {
        throw Object.assign(new Error("404"), {
          status: 404,
          code: "not_found",
        });
      },
      guestStorage,
      guestRelay: () => hidden,
    });
    await notListed.host.open();
    expect(notListed.host.view).toEqual({ kind: "entered" });
    expect(hidden.resumeLink).toHaveBeenCalledExactlyOnceWith(LINK, ACCOUNT);
    expect(notListed.client.sources.assertion).not.toHaveBeenCalled();

    const deniedRelay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const denied = setup({
      assertion: async () => {
        throw Object.assign(new Error("denied"), {
          status: 403,
          code: "source_access_denied",
        });
      },
      guestStorage,
      guestRelay: () => deniedRelay,
    });
    await denied.host.open();
    expect(denied.host.view).toEqual({ kind: "entered" });
    expect(denied.host.guest()).toEqual(SHARE);
    expect(denied.client.sources.assertion).toHaveBeenCalledOnce();
    expect(deniedRelay.resumeLink).toHaveBeenCalledExactlyOnceWith(
      LINK,
      ACCOUNT,
    );
  });

  it("Cookie 账号能进：有访客记录也用账号，不碰托管中继", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const ctx = setup({ guestStorage, guestRelay: () => relay });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "entered" });
    expect(ctx.host.guest()).toBeNull();
    expect(relay.resumeLink).not.toHaveBeenCalled();
  });

  it("链接被撤：打开时记录作废 → 访问已被收回；进去之后被收回 → 同一失败态", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const gone = fakeGuest(() => ({ kind: "gone" }));
    const revoked = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => gone,
    });
    await revoked.host.open();
    expect(revoked.host.view).toEqual({
      kind: "failed",
      code: "access_revoked",
    });
    expect(revoked.host.guest()).toBeNull();

    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const live = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => relay,
    });
    await live.host.open();
    expect(live.host.view).toEqual({ kind: "entered" });
    relay.set({
      state: "unauthorized",
      lastError: { code: "source_access_denied", message: "" },
      relayDown: false,
    });
    expect(live.host.view).toEqual({ kind: "failed", code: "access_revoked" });
  });

  it("访客暂时进不去：5xx 是可重试的失败（不是访问已被收回），限流按 Retry-After 自动再进", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const unavailable = (status: number, code: string, retryAfterMs = 0) =>
      ({
        kind: "unavailable",
        error: Object.assign(new Error(code), { status, code, retryAfterMs }),
      }) as const;
    const down = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => fakeGuest(() => unavailable(503, "unavailable")),
    });
    await down.host.open();
    expect(down.host.view).toEqual({ kind: "failed", code: "failed" });

    const delays: number[] = [];
    let retry: (() => void) | null = null;
    let limited = true;
    const relay = fakeGuest(() =>
      limited
        ? unavailable(429, "rate_limited", 7_000)
        : { kind: "entered", sourceId: HOST },
    );
    const throttled = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => relay,
      later: (run, ms) => {
        if (ms === 7_000) {
          delays.push(ms);
          retry = run;
          return 1;
        }
        return setTimeout(run, 0);
      },
    });
    await throttled.host.open();
    expect(throttled.host.view).toEqual({
      kind: "connecting",
      rateLimited: true,
    });
    expect(delays).toEqual([7_000]);
    limited = false;
    retry!();
    await vi.waitFor(() =>
      expect(throttled.host.view).toEqual({ kind: "entered" }),
    );
  });

  it("访客进主机时被限流（signedIn + rateLimited）：显示限流中，按退避自动再进；登出取消重试", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const delays: number[] = [];
    let retry: (() => void) | null = null;
    let limited = true;
    const relay = fakeGuest(() =>
      limited
        ? { kind: "signedIn", hosts: [], failure: "rateLimited" }
        : { kind: "entered", sourceId: HOST },
    );
    const ctx = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => relay,
      later: (run, ms) => {
        if (ms >= 5_000) {
          delays.push(ms);
          retry = run;
          return 1;
        }
        return setTimeout(run, 0);
      },
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "connecting", rateLimited: true });
    expect(delays).toEqual([5_000]);
    limited = false;
    retry!();
    await vi.waitFor(() => expect(ctx.host.view).toEqual({ kind: "entered" }));
    expect(relay.resumeLink).toHaveBeenCalledTimes(2);

    // 登出后到点：不再进。
    limited = true;
    const again = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => relay,
      later: (run, ms) => {
        if (ms >= 5_000) {
          retry = run;
          return 1;
        }
        return setTimeout(run, 0);
      },
    });
    await again.host.open();
    const calls = relay.resumeLink.mock.calls.length;
    await again.host.signOut();
    retry!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relay.resumeLink).toHaveBeenCalledTimes(calls);
    expect(again.host.view).toEqual({ kind: "signedOut" });
  });

  it("访客进不去：连不上是可重试的失败，主机离线是离线态", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const unreachable = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => fakeGuest(() => null),
    });
    await unreachable.host.open();
    expect(unreachable.host.view).toEqual({ kind: "failed", code: "failed" });
    const offline = setup({
      me: unauthenticated,
      guestStorage,
      later: () => 0,
      guestRelay: () =>
        fakeGuest(() => ({
          kind: "signedIn",
          hosts: [],
          failure: "offline",
        })),
    });
    await offline.host.open();
    expect(offline.host.view).toMatchObject({ kind: "offline" });
  });

  it("访客不理控制台的登出广播；访客自己登出只经托管中继", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const bus = channelBus();
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const ctx = setup({
      me: unauthenticated,
      bus,
      guestStorage,
      guestRelay: () => relay,
    });
    await ctx.host.open();
    bus.open().postMessage({ type: "signedOut" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.host.view).toEqual({ kind: "entered" });
    await ctx.host.signOut();
    expect(relay.signOut).toHaveBeenCalledOnce();
    expect(ctx.identity.logout).not.toHaveBeenCalled();
    expect(ctx.host.view).toEqual({ kind: "signedOut" });
  });
});

describe("访客回退的各个入口", () => {
  const denied = (status: number, code: string) => async () => {
    throw Object.assign(new Error(code), { status, code });
  };

  it("sources.get 答 source_access_denied：退回访客记录", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const ctx = setup({
      detail: denied(403, "source_access_denied"),
      guestStorage,
      guestRelay: () => relay,
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "entered" });
    expect(relay.resumeLink).toHaveBeenCalledExactlyOnceWith(LINK, ACCOUNT);
    expect(ctx.client.sources.assertion).not.toHaveBeenCalled();
  });

  it("sources.get 答 401（Cookie 会话这时没了）：用匿名的访客记录", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const ctx = setup({
      detail: denied(401, "unauthenticated"),
      guestStorage,
      guestRelay: () => relay,
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "entered" });
    expect(relay.resumeLink).toHaveBeenCalledExactlyOnceWith(LINK, null);
  });

  it("访客记录进主机时答 signedIn + revoked：访问已被收回", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const ctx = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () =>
        fakeGuest(() => ({ kind: "signedIn", hosts: [], failure: "revoked" })),
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "failed", code: "access_revoked" });
  });

  it("访客离线：15 秒后自动再进", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    let offline = true;
    let retry: (() => void) | null = null;
    const delays: number[] = [];
    const relay = fakeGuest(() =>
      offline
        ? { kind: "signedIn", hosts: [], failure: "offline" }
        : { kind: "entered", sourceId: HOST },
    );
    const ctx = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => relay,
      later: (run, ms) => {
        if (ms >= 1_000) {
          delays.push(ms);
          retry = run;
          return 1;
        }
        return setTimeout(run, 0);
      },
    });
    await ctx.host.open();
    expect(ctx.host.view).toMatchObject({ kind: "offline" });
    expect(delays).toEqual([15_000]);
    offline = false;
    retry!();
    await vi.waitFor(() => expect(ctx.host.view).toEqual({ kind: "entered" }));
  });

  it("断言答没有权限、退回访客之前先卸下账号那一路（状态回到 idle，不留失败的路由）", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const ctx = setup({
      assertion: denied(403, "source_access_denied"),
      guestStorage,
      guestRelay: () => fakeGuest(() => ({ kind: "gone" })),
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "failed", code: "access_revoked" });
    expect(ctx.host.status.state).toBe("idle");
  });
});

describe("访客失败时的卡片信息", () => {
  it("从账号退回、访客没进去：info 不标访客（失败卡照样给回主机列表）；匿名没进去才标", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const gone = () => fakeGuest(() => ({ kind: "gone" }));
    const account = setup({
      assertion: async () => {
        throw Object.assign(new Error("denied"), {
          status: 403,
          code: "source_access_denied",
        });
      },
      guestStorage,
      guestRelay: gone,
    });
    await account.host.open();
    expect(account.host.view).toEqual({
      kind: "failed",
      code: "access_revoked",
    });
    expect(account.host.info?.guest).not.toBe(true);
    expect(account.host.info?.consoleHref).toBe(`/t/test-team/hosts/${HOST}`);
    const anonymous = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: gone,
    });
    await anonymous.host.open();
    expect(anonymous.host.info?.guest).toBe(true);
  });
});

describe("访客路由的卸下", () => {
  it("resumeLink 进去的这一刻已经过时：刚挂上的访客路由卸下；dispose 也卸、不清记录", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    let release: (() => void) | null = null;
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const resume = relay.resumeLink.getMockImplementation()!;
    relay.resumeLink.mockImplementationOnce(async (linkId: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return resume(linkId);
    });
    const ctx = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => relay,
    });
    const opening = ctx.host.open();
    await vi.waitFor(() => expect(release).not.toBeNull());
    ctx.host.dispose();
    release!();
    await opening;
    expect(relay.close).toHaveBeenCalled();
    expect(ctx.host.view.kind).not.toBe("entered");
    expect(relay.signOut).not.toHaveBeenCalled();

    const live = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const entered = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => live,
    });
    await entered.host.open();
    expect(live.close).not.toHaveBeenCalled();
    entered.host.dispose();
    expect(live.close).toHaveBeenCalledOnce();
    expect(live.signOut).not.toHaveBeenCalled();
    expect(guestStorage.length).toBe(1);
  });
});

describe("访客记录与控制台账号隔离（§2.8）", () => {
  const notFound = async () => {
    throw Object.assign(new Error("404"), { status: 404, code: "not_found" });
  };

  it("账号 A 接受的记录：没有 Cookie 会话时不用（去登录），换成账号 B 也不用（找不到）", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST, undefined, ACCOUNT);
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const anonymous = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => relay,
    });
    await anonymous.host.open();
    expect(anonymous.host.view).toEqual({ kind: "login" });
    const other = setup({
      me: async () => ({ accountId: "acct-b", teams: [] }),
      detail: notFound,
      guestStorage,
      guestRelay: () => relay,
    });
    await other.host.open();
    expect(other.host.view).toEqual({ kind: "failed", code: "not_found" });
    expect(relay.resumeLink).not.toHaveBeenCalled();
    // A 自己：看不到这台时退回自己接受的那条。
    const self = setup({
      detail: notFound,
      guestStorage,
      guestRelay: () => relay,
    });
    await self.host.open();
    expect(self.host.view).toEqual({ kind: "entered" });
    expect(relay.resumeLink).toHaveBeenCalledExactlyOnceWith(LINK, ACCOUNT);
  });

  it("旧记录（没有 acceptedBy）来源不明：没有会话、账号退回时都不用", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST, undefined, null);
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const anonymous = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => relay,
    });
    await anonymous.host.open();
    expect(anonymous.host.view).toEqual({ kind: "login" });
    const account = setup({
      detail: notFound,
      guestStorage,
      guestRelay: () => relay,
    });
    await account.host.open();
    expect(account.host.view).toEqual({ kind: "failed", code: "not_found" });
    expect(relay.resumeLink).not.toHaveBeenCalled();
  });

  it("从账号退回来的访客：控制台登出、换了账号都盖上「已登出」", async () => {
    for (const message of [
      { type: "signedOut" },
      { type: "accountChanged", accountId: "acct-b" },
    ]) {
      const guestStorage = memoryStorage();
      guestRecord(guestStorage, LINK, HOST, undefined, ACCOUNT);
      const bus = channelBus();
      const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
      const ctx = setup({
        detail: notFound,
        bus,
        guestStorage,
        guestRelay: () => relay,
      });
      await ctx.host.open();
      expect(ctx.host.view).toEqual({ kind: "entered" });
      bus.open().postMessage(message);
      await vi.waitFor(() =>
        expect(ctx.host.view).toEqual({ kind: "signedOut" }),
      );
      expect(relay.signOut).toHaveBeenCalledOnce();
    }
  });
});

describe("guestLinkFor", () => {
  it("按进过的主机找访客记录的链接；到期的不算；几条取到期最晚的", () => {
    const storage = memoryStorage();
    const now = 1_000;
    guestRecord(storage, "a", HOST, 2_000);
    guestRecord(storage, "b", HOST, 5_000);
    guestRecord(storage, "c", HOST, 500);
    guestRecord(storage, "d", "d".repeat(32), 9_000);
    expect(guestLinkFor(storage, ISSUER, HOST, null, now)).toBe("b");
    expect(guestLinkFor(storage, ISSUER, "e".repeat(32), null, now)).toBeNull();
    expect(
      guestLinkFor(storage, "https://other.example", HOST, null, now),
    ).toBeNull();
  });

  it("只采用匿名接受的与这位自己接受的；旧记录（没有 acceptedBy）来源不明，谁都不用", () => {
    const storage = memoryStorage();
    guestRecord(storage, "by-a", HOST, 9_000, ACCOUNT);
    guestRecord(storage, "legacy", HOST, 9_500, null);
    expect(guestLinkFor(storage, ISSUER, HOST, null, 1_000)).toBeNull();
    expect(guestLinkFor(storage, ISSUER, HOST, "acct-b", 1_000)).toBeNull();
    expect(guestLinkFor(storage, ISSUER, HOST, ACCOUNT, 1_000)).toBe("by-a");
    guestRecord(storage, "anon", HOST, 5_000, "");
    expect(guestLinkFor(storage, ISSUER, HOST, null, 1_000)).toBe("anon");
    expect(guestLinkFor(storage, ISSUER, HOST, "acct-b", 1_000)).toBe("anon");
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
