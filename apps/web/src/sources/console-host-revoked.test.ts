import { afterEach, describe, expect, it, vi } from "vitest";

import { resetIdentityCredentials, setHostedSession } from "../api/identity";
import { setHostedRuntimeBase } from "../api/runtime-url";
import { memoryStorage, routedFetch } from "../mobile/testing";
import { HOST, ISSUER, setup } from "./console-host.testkit";
import { plainE2e } from "./e2e/testing";
import { createHostedRelay, guestKey } from "./hosted";
import type { RemoteStreamOptions } from "./remote-stream";
import type { EnterRouteOptions } from "./route-entry";

/**
 * `/h/` 上以访客进去之后访问被收回（#634）：真的托管中继，假的只有网络与装路由。
 * 收回之后访客路由与事件流卸下、那份访客记录作废，已撤销的令牌不再去取断言。
 */

const LINK = "link-1";
const KEY = guestKey(ISSUER, LINK);

afterEach(() => {
  resetIdentityCredentials();
  setHostedSession(null);
  setHostedRuntimeBase(null);
});

/** 云端与主机：访问被收回之后断言答 401。 */
function cloudNet() {
  const state = { revoked: false };
  const net = routedFetch({
    "POST /v1/auth/refresh": () => ({
      body: {
        session: {
          accessToken: "guest-a1",
          refreshToken: "guest-r1",
          accessExpiresAtMs: Date.now() + 900_000,
          expiresAtMs: Date.now() + 9_000_000,
        },
      },
    }),
    "GET /v1/me/sources": () => ({
      body: { sources: [{ sourceId: HOST, name: "host1", online: true }] },
    }),
    [`POST /v1/sources/${HOST}/assertion`]: () =>
      state.revoked
        ? { status: 401, body: { code: "unauthenticated", message: "" } }
        : {
            body: {
              assertion: "jws",
              relayToken: "relay.jwt",
              relayTokenExpiresAtMs: Date.now() + 3_600_000,
              relayOrigin: ISSUER,
              relayBaseUrl: `${ISSUER}/s/${HOST}`,
              online: true,
            },
          },
    [`POST /s/${HOST}/api/identity/cloud/login`]: () => ({
      body: {
        session: {
          hostId: HOST,
          expiresAtUnixMs: Date.now() + 900_000,
          native: { accessToken: "core-guest", refreshToken: "core-gr" },
        },
      },
    }),
  });
  const assertions = () =>
    net.calls.filter(
      (call) => call.key === `POST /v1/sources/${HOST}/assertion`,
    ).length;
  return { net, state, assertions };
}

/**
 * 装路由的替身：挂着时，本机源的流断了会重连、换通道（重取访问，也就是断言）——
 * `reconnect()` 模拟它们醒来一次；卸下之后什么也不做（真路由的 `dispose` 见 route-entry 的测试）。
 */
function routeModel() {
  const mounted: { disposed: boolean; options: EnterRouteOptions }[] = [];
  const enter = async (options: EnterRouteOptions) => {
    const access = await options.provider.getAccess(
      options.descriptor.sourceId,
      "relayed",
    );
    const route = { via: "relayed" as const, access };
    options.useRoute(route);
    const record = { disposed: false, options };
    mounted.push(record);
    return {
      route,
      renew: async () => true,
      recover: async () => true,
      dispose: () => {
        record.disposed = true;
      },
    };
  };
  const reconnect = async () => {
    for (const record of mounted)
      if (!record.disposed)
        await record.options.provider
          .getAccess(record.options.descriptor.sourceId, "relayed")
          .catch(() => undefined);
  };
  return { enter, mounted, reconnect };
}

describe("访客进去之后访问被收回（#634）", () => {
  it("卸下访客路由与事件流、记录作废，之后不再用已撤销的令牌取断言", async () => {
    const guestStorage = memoryStorage();
    guestStorage.setItem(
      KEY,
      JSON.stringify({
        issuer: ISSUER,
        cloudRefreshToken: "guest-r",
        sources: {},
        entered: { sourceId: HOST, name: "host1" },
        acceptedBy: "",
      }),
    );
    const { net, state, assertions } = cloudNet();
    const route = routeModel();
    let stream: RemoteStreamOptions | null = null;
    const streamClose = vi.fn();
    const relay = createHostedRelay({
      issuer: ISSUER,
      cloud: { fetch: net.fetch },
      e2e: plainE2e(net.fetch),
      enter: route.enter,
      wake: vi.fn(),
      storage: memoryStorage(),
      guestStorage,
      createStream: (options) => {
        stream = options;
        return { issuer: ISSUER, state: "open", close: streamClose };
      },
    });
    const ctx = setup({
      me: async () => {
        throw Object.assign(new Error("401"), {
          status: 401,
          code: "unauthenticated",
        });
      },
      guestStorage,
      guestRelay: () => relay,
    });

    await ctx.host.open();
    expect(ctx.host.view).toEqual({ kind: "entered" });
    expect(relay.status.state).toBe("ready");
    expect(route.mounted).toHaveLength(1);
    expect(assertions()).toBe(1);

    // 主人撤了链接：云端经访客自己的 me-stream 立即送来 accessRevoked。
    state.revoked = true;
    stream!.onEvent({ type: "accessRevoked", sourceId: HOST });

    expect(ctx.host.view).toEqual({ kind: "failed", code: "access_revoked" });
    // 访客路由与事件流已卸，托管中继回到 idle。
    expect(route.mounted[0]!.disposed).toBe(true);
    expect(streamClose).toHaveBeenCalled();
    expect(relay.status.state).toBe("idle");
    // 那份访客记录已作废（close 只卸路由，不会把它写回来）。
    expect(guestStorage.getItem(KEY)).toBeNull();

    // 本机源的流在通道关了之后照常醒来几次：一次断言也不再发。
    const before = assertions();
    for (let i = 0; i < 4; i += 1) await route.reconnect();
    expect(assertions()).toBe(before);
    expect(guestStorage.getItem(KEY)).toBeNull();
  });
});
