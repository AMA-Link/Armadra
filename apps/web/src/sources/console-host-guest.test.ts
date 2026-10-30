import { afterEach, describe, expect, it, vi } from "vitest";

import { resetIdentityCredentials, setHostedSession } from "../api/identity";
import { setHostedRuntimeBase } from "../api/runtime-url";
import { memoryStorage } from "../mobile/testing";
import type { LinkResume } from "./hosted";
import { guestKey, guestLinkFor } from "./relay-vault";
import type { RelayedStatus } from "./relayed-entry";
import {
  ACCOUNT,
  HOST,
  ISSUER,
  channelBus,
  setup,
} from "./console-host.testkit";

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

/**
 * 控制台的 `/h/` 以访客进入（设计 saas-host-open §2.8）：访客记录的回退、按接受者隔离、
 * 失败与退避、过时收尾。
 */

afterEach(() => {
  setHostedSession(null);
  setHostedRuntimeBase(null);
  resetIdentityCredentials();
});

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
    // 访客进的是访客设备，不是控制台账号的受信设备：不发受信广播。
    expect(ctx.trusted).not.toHaveBeenCalled();
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
    expect(denied.trusted).not.toHaveBeenCalled();
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
    // 收回之后卸下访客路由与事件流（#634），不在云端登出（记录已由托管中继作废）。
    expect(relay.close).toHaveBeenCalledOnce();
    expect(relay.signOut).not.toHaveBeenCalled();
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

  it("匿名访客不理控制台的登出广播；自己登出只卸路由，不清记录、不在云端登出", async () => {
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
    expect(relay.close).toHaveBeenCalled();
    expect(relay.signOut).not.toHaveBeenCalled();
    expect(ctx.identity.logout).not.toHaveBeenCalled();
    expect(guestStorage.getItem(guestKey(ISSUER, LINK))).not.toBeNull();
    expect(ctx.host.view).toEqual({ kind: "signedOut" });
  });

  it("用的是账号接受的记录：登出经托管中继登出（清记录）", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST, undefined, ACCOUNT);
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const ctx = setup({
      detail: async () => {
        throw Object.assign(new Error("404"), {
          status: 404,
          code: "not_found",
        });
      },
      guestStorage,
      guestRelay: () => relay,
    });
    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "entered" });
    await ctx.host.signOut();
    expect(relay.signOut).toHaveBeenCalledOnce();
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

describe("访客的退避与过时", () => {
  it("进主机被限流且带 Retry-After：按它退避", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const delays: number[] = [];
    const ctx = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () =>
        fakeGuest(() => ({
          kind: "signedIn",
          hosts: [],
          failure: "rateLimited",
          error: Object.assign(new Error("429"), {
            code: "rate_limited",
            retryAfterMs: 9_000,
          }),
        })),
      later: (run, ms) => {
        if (ms >= 1_000) {
          delays.push(ms);
          return 1;
        }
        return setTimeout(run, 0);
      },
    });
    await ctx.host.open();
    expect(delays).toEqual([9_000]);
  });

  it("访客一直离线：15 秒起翻倍，封顶 2 分钟", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const delays: number[] = [];
    let retry: (() => void) | null = null;
    const ctx = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () =>
        fakeGuest(() => ({ kind: "signedIn", hosts: [], failure: "offline" })),
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
    for (let round = 0; round < 4; round += 1) {
      const before = delays.length;
      retry!();
      await vi.waitFor(() => expect(delays.length).toBe(before + 1));
    }
    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 120_000]);
  });

  /** resumeLink 第一次挂住、等测试放行，之后照常答进去了；记下 close 与 resumeLink 的先后。 */
  function blockedGuest() {
    const events: string[] = [];
    let release: (() => void) | null = null;
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const resume = relay.resumeLink.getMockImplementation()!;
    let first = true;
    relay.resumeLink.mockImplementation(async (linkId: string) => {
      events.push("resume");
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return resume(linkId);
    });
    relay.close.mockImplementation(() => void events.push("close"));
    return {
      relay,
      events,
      release: () => release!(),
      started: () => release !== null,
    };
  }

  it("再次 open() 使上一次过时：上一次刚挂上的访客路由先卸下，下一次才开始挂，最后在画布", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const blocked = blockedGuest();
    const ctx = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => blocked.relay,
    });
    const first = ctx.host.open();
    await vi.waitFor(() => expect(blocked.started()).toBe(true));
    const second = ctx.host.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 第二次排在第一次后面：第一次没收尾前不开始。
    expect(blocked.events).toEqual(["resume"]);
    blocked.release();
    await Promise.all([first, second]);
    expect(blocked.events).toEqual(["resume", "close", "resume"]);
    expect(ctx.host.view).toEqual({ kind: "entered" });
  });

  it("登出使进行中的访客进入过时：醒来后卸下刚挂上的访客路由", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const blocked = blockedGuest();
    const ctx = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => blocked.relay,
    });
    const opening = ctx.host.open();
    await vi.waitFor(() => expect(blocked.started()).toBe(true));
    await ctx.host.signOut();
    blocked.release();
    await opening;
    expect(blocked.events).toEqual(["resume", "close"]);
    expect(ctx.host.view).toEqual({ kind: "signedOut" });
  });

  it("以访客进去之后再次 open()：先卸下访客路由再进", async () => {
    const guestStorage = memoryStorage();
    guestRecord(guestStorage, LINK, HOST);
    const events: string[] = [];
    const relay = fakeGuest(() => ({ kind: "entered", sourceId: HOST }));
    const resume = relay.resumeLink.getMockImplementation()!;
    relay.resumeLink.mockImplementation(async (linkId: string) => {
      events.push("resume");
      return resume(linkId);
    });
    relay.close.mockImplementation(() => void events.push("close"));
    const ctx = setup({
      me: unauthenticated,
      guestStorage,
      guestRelay: () => relay,
    });
    await ctx.host.open();
    await ctx.host.open();
    expect(events).toEqual(["resume", "close", "resume"]);
    expect(ctx.host.view).toEqual({ kind: "entered" });
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
