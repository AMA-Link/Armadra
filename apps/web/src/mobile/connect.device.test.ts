import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRelayEnrollment,
  verificationLink,
  type RelayEnrollment,
} from "./connect";
import { loadConnections, remoteSlotOf } from "./connections";
import { serviceIdOf } from "./credentials";
import {
  SESSION_A,
  SESSION_B,
  fakeBridge,
  memoryStorage,
  routedFetch,
} from "./testing";
import { plainE2e } from "../sources/e2e/testing";

const ISSUER = "https://cloud.example.com";
const HOST = "a".repeat(32);
const ACCOUNT = "acct-1";

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

const platform =
  (mode = "saas") =>
  () => ({
    body: { mode, issuer: ISSUER, capabilities: [] },
  });

const started =
  (overrides: Record<string, unknown> = {}) =>
  () => ({
    body: {
      deviceCode: "device-secret-code",
      userCode: "BCDF-GHJK",
      verificationUrl: `${ISSUER}/device`,
      expiresAtMs: Date.now() + 600_000,
      intervalMs: 5_000,
      ...overrides,
    },
  });

const approved = () => ({
  body: {
    status: "approved",
    session: {
      accessToken: "cloud-access",
      refreshToken: "cloud-refresh",
      accessExpiresAtMs: Date.now() + 900_000,
      expiresAtMs: Date.now() + 9_000_000,
      account: {
        accountId: ACCOUNT,
        email: "a@example.com",
        displayName: "A",
        emailVerified: true,
      },
      device: { deviceId: "dev-1" },
    },
  },
});

const sources = () => ({
  body: {
    sources: [
      {
        sourceId: HOST,
        name: "MacBook",
        online: true,
        owner: true,
        via: "owner",
      },
    ],
  },
});

const assertion = () => ({
  body: {
    assertion: "jws.a",
    assertionExpiresAtMs: Date.now() + 300_000,
    relayToken: "relay.a",
    relayTokenExpiresAtMs: Date.now() + 3_600_000,
    relayOrigin: ISSUER,
    relayBaseUrl: `${ISSUER}/s/${HOST}`,
    online: true,
  },
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

function enrollment(
  routes: Parameters<typeof routedFetch>[0],
  extra: { now?: () => number; open?: (url: string) => Promise<boolean> } = {},
) {
  const net = routedFetch(routes);
  const { bridge, remotes, sessions, pins } = fakeBridge({
    peek: { fingerprint: "ab".repeat(32), trusted: true, pinned: false },
  });
  const reload = vi.fn();
  const open = extra.open ?? vi.fn(async () => true);
  const enroll: RelayEnrollment = createRelayEnrollment({
    bridge,
    cloud: { fetch: net.fetch },
    e2e: plainE2e(net.fetch),
    reload,
    open,
    ...(extra.now ? { now: extra.now } : {}),
  });
  return { enroll, net, bridge, remotes, sessions, pins, reload, open };
}

const baseRoutes = {
  "GET /.well-known/armadra-platform": platform(),
  "POST /v1/auth/device/start": started(),
};

describe("手机连接 Armadra 云 · 设备码", () => {
  it("发起：只要地址；取设备码、在系统浏览器打开带 code 的批准页；deviceCode 不外露", async () => {
    const { enroll, net, open } = enrollment(baseRoutes);
    const outcome = await enroll.beginDevice({ issuer: "cloud.example.com" });
    expect(outcome).toMatchObject({
      kind: "device",
      userCode: "BCDF-GHJK",
      intervalMs: 5_000,
    });
    expect(JSON.stringify(outcome)).not.toContain("device-secret-code");
    expect(open).toHaveBeenCalledWith(`${ISSUER}/device?code=BCDF-GHJK`);
    // 请求里没有口令表单的东西，设备登记为这台手机。
    const start = net.calls.find((call) => call.key.endsWith("/device/start"));
    expect(JSON.parse(String(start?.init.body))).toEqual({
      device: { platform: "ios", name: "Armadra iOS" },
    });
    expect(net.calls.map((call) => call.key)).not.toContain(
      "POST /v1/auth/login",
    );
  });

  it("批准页打不开不算失败（界面有「在浏览器中打开」）", async () => {
    const { enroll } = enrollment(baseRoutes, { open: async () => false });
    await expect(enroll.beginDevice({ issuer: ISSUER })).resolves.toMatchObject(
      { kind: "device" },
    );
  });

  it("对端不是 Armadra 云、批准页不同源、地址不对：各自失败，不发设备码请求或不记状态", async () => {
    const personal = enrollment({
      ...baseRoutes,
      "GET /.well-known/armadra-platform": platform("personal"),
    });
    await expect(
      personal.enroll.beginDevice({ issuer: ISSUER }),
    ).resolves.toEqual({ kind: "failure", failure: "notCloud" });
    expect(personal.net.calls.map((call) => call.key)).not.toContain(
      "POST /v1/auth/device/start",
    );

    const hostile = enrollment({
      ...baseRoutes,
      "POST /v1/auth/device/start": started({
        verificationUrl: "https://evil.example.net/device",
      }),
    });
    await expect(
      hostile.enroll.beginDevice({ issuer: ISSUER }),
    ).resolves.toEqual({ kind: "failure", failure: "failed" });
    expect(hostile.open).not.toHaveBeenCalled();
    await expect(hostile.enroll.pollDevice()).resolves.toEqual({
      kind: "failure",
      failure: "deviceExpired",
    });

    const bad = enrollment(baseRoutes);
    await expect(bad.enroll.beginDevice({ issuer: "" })).resolves.toEqual({
      kind: "failure",
      failure: "address",
    });
  });

  it("轮询：pending 继续等，请求只带 deviceCode", async () => {
    const { enroll, net } = enrollment({
      ...baseRoutes,
      "POST /v1/auth/device/poll": () => ({ body: { status: "pending" } }),
    });
    await enroll.beginDevice({ issuer: ISSUER });
    await expect(enroll.pollDevice()).resolves.toEqual({ kind: "pending" });
    const poll = net.calls.find((call) => call.key.endsWith("/device/poll"));
    expect(JSON.parse(String(poll?.init.body))).toEqual({
      deviceCode: "device-secret-code",
    });
  });

  it("批准：列出能挂的源；勾选挂载后会话与凭据进钥匙串（kind = saas、不带指纹），连接表里没有令牌", async () => {
    const { enroll, remotes, sessions, reload, bridge } = enrollment({
      ...baseRoutes,
      "POST /v1/auth/device/poll": approved,
      "GET /v1/me/sources": sources,
      [`POST /v1/sources/${HOST}/assertion`]: assertion,
      [`POST /s/${HOST}/api/identity/cloud/login`]: coreLogin,
    });
    await enroll.beginDevice({ issuer: ISSUER });
    // 批准之前什么都没存。
    expect(bridge.setRemote).not.toHaveBeenCalled();
    await expect(enroll.pollDevice()).resolves.toEqual({
      kind: "sources",
      sources: [{ sourceId: HOST, name: "MacBook", online: true }],
    });
    expect(bridge.setRemote).not.toHaveBeenCalled();
    await expect(enroll.mount([HOST])).resolves.toEqual({ kind: "done" });
    expect(reload).toHaveBeenCalledOnce();
    const slot = serviceIdOf(ISSUER, ACCOUNT);
    expect(remotes.get(slot)).toEqual({
      serviceId: slot,
      issuer: ISSUER,
      kind: "saas",
      refreshToken: "cloud-refresh",
      fingerprint: "",
    });
    expect(sessions.get(`${HOST}|relayed`)).toMatchObject({
      origin: ISSUER,
      via: "relayed",
      accessToken: SESSION_A,
    });
    expect(remoteSlotOf(HOST)).toBe(slot);
    expect(loadConnections()[0]).toMatchObject({
      sourceId: HOST,
      kind: "relayed",
      relayOrigin: ISSUER,
      cloudIssuer: ISSUER,
    });
    expect(localStorage.getItem("armadra.sources")).not.toMatch(
      /cloud-refresh|device-secret-code|cloud-access/,
    );
  });

  it("拒绝、过期：各自的原因，不存任何东西；终结后再轮询答「过期」不再发请求", async () => {
    for (const [status, failure] of [
      ["denied", "denied"],
      ["expired", "deviceExpired"],
    ] as const) {
      const { enroll, net, bridge } = enrollment({
        ...baseRoutes,
        "POST /v1/auth/device/poll": () => ({ body: { status } }),
      });
      await enroll.beginDevice({ issuer: ISSUER });
      await expect(enroll.pollDevice()).resolves.toEqual({
        kind: "failure",
        failure,
      });
      const before = net.calls.length;
      await expect(enroll.pollDevice()).resolves.toEqual({
        kind: "failure",
        failure: "deviceExpired",
      });
      expect(net.calls).toHaveLength(before);
      expect(bridge.setRemote).not.toHaveBeenCalled();
      expect(bridge.setSession).not.toHaveBeenCalled();
    }
  });

  it("本地时钟已过期限：不再问服务端直接答过期", async () => {
    let at = Date.now();
    const { enroll, net } = enrollment(
      {
        ...baseRoutes,
        "POST /v1/auth/device/poll": () => ({ body: { status: "pending" } }),
      },
      { now: () => at },
    );
    await enroll.beginDevice({ issuer: ISSUER });
    at += 601_000;
    await expect(enroll.pollDevice()).resolves.toEqual({
      kind: "failure",
      failure: "deviceExpired",
    });
    expect(net.calls.some((call) => call.key.endsWith("/device/poll"))).toBe(
      false,
    );
  });

  it("限流：答 retry（带对端给的 retryAfterMs），设备码仍有效，之后照常能批准", async () => {
    let answers = 0;
    const { enroll } = enrollment({
      ...baseRoutes,
      "POST /v1/auth/device/poll": () => {
        answers += 1;
        return answers === 1
          ? {
              status: 429,
              body: {
                code: "rate_limited",
                message: "",
                details: { retryAfterMs: 7_000 },
              },
            }
          : approved();
      },
      "GET /v1/me/sources": sources,
    });
    await enroll.beginDevice({ issuer: ISSUER });
    await expect(enroll.pollDevice()).resolves.toEqual({
      kind: "retry",
      afterMs: 7_000,
    });
    await expect(enroll.pollDevice()).resolves.toMatchObject({
      kind: "sources",
    });
  });

  it("暂时连不上：先当重试，连续多次才放弃", async () => {
    const { enroll, net } = enrollment({
      ...baseRoutes,
      "POST /v1/auth/device/poll": () => ({ body: { status: "pending" } }),
    });
    await enroll.beginDevice({ issuer: ISSUER });
    (net.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new TypeError("offline");
      },
    );
    for (let index = 0; index < 5; index += 1)
      await expect(enroll.pollDevice()).resolves.toEqual({
        kind: "retry",
        afterMs: 0,
      });
    await expect(enroll.pollDevice()).resolves.toEqual({
      kind: "failure",
      failure: "unreachable",
    });
  });

  it("取消：丢掉设备码，之后不再问服务端；等回答期间取消，批准的会话不存", async () => {
    const { enroll, net, bridge } = enrollment({
      ...baseRoutes,
      "POST /v1/auth/device/poll": approved,
      "GET /v1/me/sources": sources,
    });
    await enroll.beginDevice({ issuer: ISSUER });
    enroll.cancelDevice();
    const before = net.calls.length;
    await expect(enroll.pollDevice()).resolves.toEqual({
      kind: "failure",
      failure: "deviceExpired",
    });
    expect(net.calls).toHaveLength(before);
    await expect(enroll.mount([HOST])).resolves.toEqual({
      kind: "failure",
      failure: "failed",
    });
    expect(bridge.setRemote).not.toHaveBeenCalled();

    // 在途的轮询回来时已被取消。
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const raced = enrollment({
      ...baseRoutes,
      "POST /v1/auth/device/poll": approved,
      "GET /v1/me/sources": sources,
    });
    await raced.enroll.beginDevice({ issuer: ISSUER });
    const real = raced.net.fetch;
    (
      raced.net.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        await gate;
        return (real as unknown as typeof fetch)(input, init);
      },
    );
    const inFlight = raced.enroll.pollDevice();
    raced.enroll.cancelDevice();
    release();
    await expect(inFlight).resolves.toEqual({
      kind: "failure",
      failure: "failed",
    });
    expect(raced.bridge.setRemote).not.toHaveBeenCalled();
  });

  it("批准后账号下没有主机：给原因", async () => {
    const { enroll } = enrollment({
      ...baseRoutes,
      "POST /v1/auth/device/poll": approved,
      "GET /v1/me/sources": () => ({ body: { sources: [] } }),
    });
    await enroll.beginDevice({ issuer: ISSUER });
    await expect(enroll.pollDevice()).resolves.toEqual({
      kind: "failure",
      failure: "noSources",
    });
  });

  it("账号口令表单填了 Armadra 云的地址：改走设备码，口令不发出去", async () => {
    const { enroll, net } = enrollment({
      ...baseRoutes,
      "POST /v1/auth/login": () => {
        throw new Error("password must not be sent");
      },
    });
    const outcome = await enroll.begin({
      issuer: ISSUER,
      account: "me",
      password: "hunter2hunter2",
    });
    expect(outcome).toMatchObject({ kind: "device", userCode: "BCDF-GHJK" });
    expect(net.calls.map((call) => call.key)).not.toContain(
      "POST /v1/auth/login",
    );
  });

  it("个人中转的口令登录不变（对端不是 Armadra 云时）", async () => {
    const { enroll, remotes } = enrollment({
      "GET /.well-known/armadra-platform": platform("personal"),
      "POST /v1/auth/login": () => ({
        body: {
          session: {
            accessToken: "cloud-access",
            refreshToken: "cloud-refresh",
            accessExpiresAtMs: Date.now() + 900_000,
            expiresAtMs: Date.now() + 9_000_000,
          },
        },
      }),
      "GET /v1/me/sources": sources,
      [`POST /v1/sources/${HOST}/assertion`]: assertion,
      [`POST /s/${HOST}/api/identity/cloud/login`]: coreLogin,
    });
    await expect(
      enroll.begin({ issuer: ISSUER, account: "o", password: "pw-pw-pw-pw" }),
    ).resolves.toMatchObject({ kind: "sources" });
    await enroll.mount([HOST]);
    expect([...remotes.values()][0]).toMatchObject({ kind: "personal" });
  });

  it("再打开批准页；没有进行中的设备码是 false", async () => {
    const { enroll, open } = enrollment(baseRoutes);
    await expect(enroll.openVerification()).resolves.toBe(false);
    await enroll.beginDevice({ issuer: ISSUER });
    await expect(enroll.openVerification()).resolves.toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("verificationLink", () => {
  it("同源 https 才打开；没有 code 的补上，已有的不重复；回环允许 http", () => {
    expect(verificationLink(`${ISSUER}/device`, "BCDF-GHJK", ISSUER)).toBe(
      `${ISSUER}/device?code=BCDF-GHJK`,
    );
    expect(
      verificationLink(`${ISSUER}/device?code=ZZZZ-ZZZZ`, "BCDF-GHJK", ISSUER),
    ).toBe(`${ISSUER}/device?code=ZZZZ-ZZZZ`);
    expect(
      verificationLink(
        "http://127.0.0.1:8787/device",
        "BCDF-GHJK",
        "http://127.0.0.1:8787",
      ),
    ).toBe("http://127.0.0.1:8787/device?code=BCDF-GHJK");
    expect(
      verificationLink("http://cloud.example.com/device", "B", ISSUER),
    ).toBeNull();
    expect(
      verificationLink("https://evil.example.net/device", "B", ISSUER),
    ).toBeNull();
    expect(
      verificationLink("https://u:p@cloud.example.com/device", "B", ISSUER),
    ).toBeNull();
    expect(verificationLink("not a url", "B", ISSUER)).toBeNull();
  });
});
