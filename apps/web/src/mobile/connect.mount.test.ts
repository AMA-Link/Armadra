import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRelayEnrollment, failureDetail } from "./connect";
import { E2eAccessError, type E2eChannels } from "../sources/e2e/manager";
import { CloudError, CloudTransportError } from "../sources/cloud-client";
import {
  SESSION_A,
  SESSION_B,
  fakeBridge,
  memoryStorage,
  routedFetch,
} from "./testing";

const ISSUER = "https://cloud.example.com";
const HOST = "a".repeat(32);
const BASE = `https://${HOST}.src.example.com`;

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

const cloudRoutes = (online = true) => ({
  "GET /.well-known/armadra-platform": () => ({
    body: { mode: "saas", issuer: ISSUER, capabilities: [] },
  }),
  "POST /v1/auth/device/start": () => ({
    body: {
      deviceCode: "device-secret-code",
      userCode: "BCDF-GHJK",
      verificationUrl: `${ISSUER}/device`,
      expiresAtMs: Date.now() + 600_000,
      intervalMs: 5_000,
    },
  }),
  "POST /v1/auth/device/poll": () => ({
    body: {
      status: "approved",
      session: {
        accessToken: "cloud-access",
        refreshToken: "cloud-refresh",
        accessExpiresAtMs: Date.now() + 900_000,
        expiresAtMs: Date.now() + 9_000_000,
        account: { accountId: "acct-1", displayName: "A" },
      },
    },
  }),
  "GET /v1/me/sources": () => ({
    body: {
      sources: [{ sourceId: HOST, name: "MacBook", online: true, owner: true }],
    },
  }),
  [`POST /v1/sources/${HOST}/assertion`]: () => ({
    body: {
      assertion: "jws.a",
      assertionExpiresAtMs: Date.now() + 300_000,
      relayToken: "relay.a",
      relayTokenExpiresAtMs: Date.now() + 3_600_000,
      relayOrigin: BASE,
      relayBaseUrl: `${BASE}/`,
      online,
    },
  }),
});

const coreLogin = () => ({
  body: {
    session: {
      hostId: HOST,
      expiresAtUnixMs: Date.now() + 900_000,
      native: { accessToken: SESSION_A, refreshToken: SESSION_B },
    },
  },
});

/** 假通道：记下开通道的目标，core 请求只从 `fetchFor` 给的那一个走。 */
function fakeE2e(channelFetch: typeof fetch) {
  const channel = vi.fn(async () => ({ sas: "000000" }));
  const awaitApproval = vi.fn(async () => true as const);
  const e2e = {
    channel,
    fetchFor: () => channelFetch,
    socketFor: () => globalThis.WebSocket,
    awaitApproval,
    pinned: () => true,
    forget: () => undefined,
    close: () => undefined,
  } as unknown as E2eChannels;
  return { e2e, channel, awaitApproval };
}

async function signedIn(e2e: E2eChannels | undefined, online = true) {
  const cloud = routedFetch(cloudRoutes(online));
  const { bridge, sessions } = fakeBridge({
    peek: { fingerprint: "ab".repeat(32), trusted: true, pinned: false },
  });
  const enroll = createRelayEnrollment({
    bridge,
    cloud: { fetch: cloud.fetch },
    ...(e2e ? { e2e } : {}),
    reload: vi.fn(),
    open: vi.fn(async () => true),
  });
  await enroll.beginDevice({ issuer: ISSUER });
  await enroll.pollDevice();
  return { enroll, cloud, sessions };
}

describe("手机挂载云主机 · 端到端通道（#680）", () => {
  it("core 登录走端到端通道，不发明文 HTTP 到源地址", async () => {
    const sealed = routedFetch({
      "POST /api/identity/cloud/login": coreLogin,
    });
    const { e2e, channel } = fakeE2e(sealed.fetch);
    const { enroll, cloud, sessions } = await signedIn(e2e);

    await expect(enroll.mount([HOST])).resolves.toEqual({ kind: "done" });
    expect(channel).toHaveBeenCalledWith({
      issuer: ISSUER,
      sourceId: HOST,
      base: BASE,
      relayToken: "relay.a",
      label: "MacBook",
    });
    expect(sealed.calls.map((call) => call.key)).toEqual([
      "POST /api/identity/cloud/login",
    ]);
    expect(cloud.calls.some((call) => call.url.host.includes(".src."))).toBe(
      false,
    );
    expect(sessions.get(`${HOST}|relayed`)).toMatchObject({
      accessToken: SESSION_A,
    });
  });

  it("新设备待确认：等主人核对后再登录一次", async () => {
    let first = true;
    const sealed = routedFetch({
      "POST /api/identity/cloud/login": () => {
        if (!first) return coreLogin();
        first = false;
        return {
          status: 403,
          body: {
            code: "device_pending",
            message: "",
            details: { pendingId: "p-1" },
          },
        };
      },
    });
    const { e2e, awaitApproval } = fakeE2e(sealed.fetch);
    const { enroll } = await signedIn(e2e);

    await expect(enroll.mount([HOST])).resolves.toEqual({ kind: "done" });
    expect(awaitApproval).toHaveBeenCalledOnce();
    expect(sealed.calls).toHaveLength(2);
  });

  it("失败带原始原因：对端的码与 HTTP 状态", async () => {
    const sealed = routedFetch({});
    const { e2e } = fakeE2e(sealed.fetch);
    const { enroll } = await signedIn(e2e);
    await expect(enroll.mount([HOST])).resolves.toEqual({
      kind: "failure",
      failure: "failed",
      detail: "not_found · HTTP 404",
    });
  });

  it("通道开不了：按通道的码落成离线 / 连不上，原因里写明", async () => {
    const { e2e, channel } = fakeE2e(routedFetch({}).fetch);
    channel.mockRejectedValueOnce(new E2eAccessError("offline"));
    const { enroll } = await signedIn(e2e);
    await expect(enroll.mount([HOST])).resolves.toEqual({
      kind: "failure",
      failure: "offline",
      detail: "e2e offline",
    });
  });

  it("没有通道（不支持端到端）：失败而不是退回明文", async () => {
    const { enroll, cloud } = await signedIn(undefined);
    await expect(enroll.mount([HOST])).resolves.toEqual({
      kind: "failure",
      failure: "failed",
      detail: "e2e device_unavailable",
    });
    expect(cloud.calls.some((call) => call.url.host.includes(".src."))).toBe(
      false,
    );
  });

  it("云说主机不在线：离线，原因 source_offline", async () => {
    const { e2e, channel } = fakeE2e(routedFetch({}).fetch);
    const { enroll } = await signedIn(e2e, false);
    await expect(enroll.mount([HOST])).resolves.toEqual({
      kind: "failure",
      failure: "offline",
      detail: "source_offline",
    });
    expect(channel).not.toHaveBeenCalled();
  });
});

describe("failureDetail", () => {
  it("远程服务、通道、网络各自的写法", () => {
    expect(failureDetail(new CloudError(403, "team_policy_denied"))).toBe(
      "team_policy_denied · HTTP 403",
    );
    expect(failureDetail(new E2eAccessError("unreachable"))).toBe(
      "e2e unreachable",
    );
    expect(
      failureDetail(new CloudTransportError(new TypeError("Load failed"))),
    ).toBe("network · Load failed");
    expect(failureDetail("x")).toBeUndefined();
  });
});
