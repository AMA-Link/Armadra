import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentAccessToken,
  resetIdentityCredentials,
  setHostedSession,
} from "../api/identity";
import { setHostedRuntimeBase } from "../api/runtime-url";
import { routedFetch } from "../mobile/testing";
import {
  GUEST_KEY_PREFIX,
  HOSTED_RESUME_KEY,
  createHostedRelay,
  guestKey,
} from "./hosted";
import type { EnterRouteOptions } from "./route-entry";
import type { RemoteStreamOptions } from "./remote-stream";
import { plainE2e } from "./e2e/testing";

/**
 * 访客保管处：按分享链接加入的访客刷新令牌按 签发方 + 链接 存 localStorage，
 * 寿命 = 链接到期；到期、401、accessRevoked 即清；resume 先试它再回账号登录。
 */

const ISSUER = "https://relay.example";
const SOURCE = "a".repeat(32);
const LINK = {
  linkId: "0123456789abcdef",
  secret: "S".repeat(43),
  invitationToken: `${"c".repeat(32)}.${"D".repeat(43)}`,
};
const KEY = guestKey(ISSUER, LINK.linkId);
const START = 1_800_000_000_000;
const EXPIRES = START + 7 * 24 * 3_600_000;

afterEach(() => {
  resetIdentityCredentials();
  setHostedSession(null);
  setHostedRuntimeBase(null);
});

function storage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

const fakeEnter = async (options: EnterRouteOptions) => {
  const access = await options.provider.getAccess(
    options.descriptor.sourceId,
    "relayed",
  );
  const route = { via: "relayed" as const, access };
  options.useRoute(route);
  return {
    route,
    renew: async () => true,
    recover: async () => true,
    dispose: () => undefined,
  };
};

/** 中继与主机：访客的刷新令牌每用一次就旋转，旧的作废。 */
function guestNet() {
  let cloud = 0;
  let core = 0;
  const live = { cloud: "guest-r", core: "core-gr" };
  const state = { cloudRejected: false };
  const net = routedFetch({
    [`POST /v1/links/${LINK.linkId}/accept`]: () => ({
      body: {
        sourceId: SOURCE,
        relayOrigin: ISSUER,
        relayBaseUrl: `${ISSUER}/s/${SOURCE}`,
        assertion: "jws.guest",
        relayToken: "relay.guest",
        guestSession: {
          accessToken: "guest-a",
          refreshToken: live.cloud,
          accessExpiresAtMs: Date.now() + 900_000,
        },
      },
    }),
    [`GET /v1/links/${LINK.linkId}`]: () => ({
      body: {
        label: "",
        role: "viewer",
        sourceName: "studio",
        expiresAtMs: EXPIRES,
        exhausted: false,
      },
    }),
    "POST /v1/auth/refresh": (init) => {
      const { refreshToken } = JSON.parse(String(init.body)) as {
        refreshToken: string;
      };
      if (state.cloudRejected || refreshToken !== live.cloud)
        return { status: 401, body: { code: "session_expired", message: "" } };
      cloud += 1;
      live.cloud = `guest-r${cloud}`;
      return {
        body: {
          session: {
            accessToken: `guest-a${cloud}`,
            refreshToken: live.cloud,
            accessExpiresAtMs: Date.now() + 900_000,
            expiresAtMs: Date.now() + 9_000_000,
          },
        },
      };
    },
    "GET /v1/me/sources": () => ({
      body: { sources: [{ sourceId: SOURCE, name: "studio", online: true }] },
    }),
    [`POST /v1/sources/${SOURCE}/assertion`]: () => ({
      body: {
        assertion: "jws",
        relayToken: "relay.jwt",
        relayTokenExpiresAtMs: Date.now() + 3_600_000,
        relayOrigin: ISSUER,
        relayBaseUrl: `${ISSUER}/s/${SOURCE}`,
        online: true,
      },
    }),
    [`POST /s/${SOURCE}/api/identity/cloud/login`]: () => ({
      body: {
        session: {
          hostId: SOURCE,
          expiresAtUnixMs: Date.now() + 900_000,
          native: { accessToken: "core-guest", refreshToken: live.core },
        },
      },
    }),
    [`POST /s/${SOURCE}/api/identity/session/refresh`]: (init) => {
      const bearer = new Headers(init.headers).get("authorization");
      if (bearer !== `Bearer ${live.core}`)
        return { status: 401, body: { code: "unauthorized", message: "" } };
      core += 1;
      live.core = `core-gr${core}`;
      return {
        body: {
          hostId: SOURCE,
          expiresAtUnixMs: Date.now() + 900_000,
          native: { accessToken: `core-ga${core}`, refreshToken: live.core },
        },
      };
    },
  });
  return { net, state };
}

function page(
  net: ReturnType<typeof guestNet>["net"],
  stores: { session: Storage; guest: Storage },
  now: () => number = () => START,
) {
  let stream: RemoteStreamOptions | null = null;
  const relay = createHostedRelay({
    issuer: ISSUER,
    cloud: { fetch: net.fetch },
    e2e: plainE2e(net.fetch),
    enter: fakeEnter,
    wake: vi.fn(),
    storage: stores.session,
    guestStorage: stores.guest,
    now,
    createStream: (options) => {
      stream = options;
      return { issuer: ISSUER, state: "open", close: () => undefined };
    },
  });
  return { relay, stream: () => stream! };
}

const fresh = () => ({ session: storage(), guest: storage() });

describe("访客保管处（localStorage，按 签发方 + 链接）", () => {
  it("加入后刷新令牌落 localStorage，寿命 = 链接到期；账号那份 sessionStorage 不动", async () => {
    const { net } = guestNet();
    const stores = fresh();
    const { relay } = page(net, stores);
    await relay.join(LINK);
    expect(KEY.startsWith(GUEST_KEY_PREFIX)).toBe(true);
    const raw = stores.guest.getItem(KEY)!;
    expect(JSON.parse(raw)).toMatchObject({
      issuer: ISSUER,
      cloudRefreshToken: "guest-r",
      sources: { [SOURCE]: "core-gr" },
      entered: { sourceId: SOURCE },
      expiresAtMs: EXPIRES,
      share: { role: "viewer", name: "studio", expiresAtMs: EXPIRES },
    });
    expect(relay.guest()).toMatchObject({ role: "viewer", name: "studio" });
    // 访问令牌不落盘；账号的存储里没有它。
    expect(raw).not.toContain("guest-a");
    expect(raw).not.toContain("core-guest");
    expect(stores.session.getItem(HOSTED_RESUME_KEY)).toBeNull();
    relay.dispose();
  });

  it("刷新后 resume 先试访客记录：静默续上，不走账号登录，令牌旋转写回", async () => {
    const { net } = guestNet();
    const stores = fresh();
    const first = page(net, stores);
    await first.relay.join(LINK);
    resetIdentityCredentials();
    setHostedSession(null);
    const before = net.calls.length;

    const reloaded = page(net, stores);
    await expect(reloaded.relay.resume()).resolves.toEqual({
      kind: "entered",
    });
    expect(currentAccessToken()).toBe("core-ga1");
    const keys = net.calls.slice(before).map((call) => call.key);
    expect(keys).toContain("POST /v1/auth/refresh");
    expect(keys).not.toContain("POST /v1/auth/login");
    expect(JSON.parse(stores.guest.getItem(KEY)!)).toMatchObject({
      cloudRefreshToken: "guest-r1",
      sources: { [SOURCE]: "core-gr1" },
      expiresAtMs: EXPIRES,
    });
  });

  it("到期的记录读不出来、被清掉，resume 回登录，一个请求也不发", async () => {
    const { net } = guestNet();
    const stores = fresh();
    await page(net, stores).relay.join(LINK);
    resetIdentityCredentials();
    const before = net.calls.length;
    const late = page(net, stores, () => EXPIRES + 1);
    await expect(late.relay.resume()).resolves.toBeNull();
    expect(stores.guest.getItem(KEY)).toBeNull();
    expect(net.calls.length).toBe(before);
  });

  it("401（刷新令牌被拒）：记录清掉，刷新后不再试", async () => {
    const { net, state } = guestNet();
    const stores = fresh();
    await page(net, stores).relay.join(LINK);
    state.cloudRejected = true;
    const reloaded = page(net, stores);
    await expect(reloaded.relay.resume()).resolves.toBeNull();
    expect(stores.guest.getItem(KEY)).toBeNull();
    const before = net.calls.length;
    await expect(page(net, stores).relay.resume()).resolves.toBeNull();
    expect(net.calls.length).toBe(before);
  });

  it("accessRevoked：当场清掉记录", async () => {
    const { net } = guestNet();
    const stores = fresh();
    const { relay, stream } = page(net, stores);
    await relay.join(LINK);
    expect(stores.guest.getItem(KEY)).not.toBeNull();
    stream().onEvent({ type: "accessRevoked", sourceId: SOURCE });
    expect(relay.status.state).toBe("unauthorized");
    expect(stores.guest.getItem(KEY)).toBeNull();
  });

  it("加入失败不留记录；账号登录是明确换身份，访客记录不再续", async () => {
    const { net } = guestNet();
    const stores = fresh();
    const failing = createHostedRelay({
      issuer: ISSUER,
      cloud: { fetch: net.fetch },
      e2e: plainE2e(net.fetch),
      enter: fakeEnter,
      wake: vi.fn(),
      storage: stores.session,
      guestStorage: stores.guest,
      now: () => START,
    });
    await failing.join({ ...LINK, linkId: "ffffffffffffffff" }).catch(() => 0);
    expect(stores.guest.length).toBe(0);

    await page(net, stores).relay.join(LINK);
    expect(stores.guest.getItem(KEY)).not.toBeNull();
    const account = page(
      routedFetch({
        "POST /v1/auth/login": () => ({
          body: {
            session: {
              accessToken: "cloud-a",
              refreshToken: "cloud-r",
              accessExpiresAtMs: Date.now() + 900_000,
              expiresAtMs: Date.now() + 9_000_000,
            },
          },
        }),
        "GET /v1/me/sources": () => ({
          body: { sources: [{ sourceId: SOURCE, name: "x", online: true }] },
        }),
      }),
      stores,
    );
    await account.relay.signIn("dev", "pw");
    expect(stores.guest.getItem(KEY)).toBeNull();
  });
});
