import { describe, expect, it, vi } from "vitest";

import { CloudConsoleError } from "../cloud/api/errors";
import { routedFetch } from "../mobile/testing";
import type { CloudAssertion } from "./cloud-client";
import { createBrowserCloudCredentialProvider } from "./credentials";
import { plainE2e } from "./e2e/testing";
import { SOURCE_ERROR } from "./types";

/**
 * `browser-cloud`：Cookie 会话的控制台页面经 `sources.assertion` 取断言，不碰访问令牌，
 * 断言、中继令牌与源 core 的会话只在内存里（云端控制台 §1.3）。
 */

const ISSUER = "https://app.example";
const SOURCE = "b".repeat(32);
const BASE = `https://${SOURCE}.src.relay.example`;
const NOW = 1_000_000;

const assertion = (over: Partial<CloudAssertion> = {}): CloudAssertion => ({
  assertion: "jws.assertion",
  assertionExpiresAtMs: NOW + 300_000,
  relayToken: "relay.jwt",
  relayTokenExpiresAtMs: NOW + 3_600_000,
  relayOrigin: "https://relay.example",
  relayBaseUrl: BASE,
  online: true,
  ...over,
});

const coreSession = (access: string, refresh: string) => ({
  hostId: SOURCE,
  expiresAtUnixMs: NOW + 900_000,
  csrfToken: "c".repeat(43),
  native: { accessToken: access, refreshToken: refresh },
});

function setup(
  ask: (input: { sourceId: string }) => Promise<CloudAssertion> = async () =>
    assertion(),
) {
  const sources = { assertion: vi.fn(ask) };
  const net = routedFetch({
    "POST /api/identity/cloud/login": () => ({
      body: { session: coreSession("core-a", "core-r") },
    }),
    "POST /api/identity/session/refresh": () => ({
      body: coreSession("core-b", "core-r2"),
    }),
  });
  const provider = createBrowserCloudCredentialProvider({
    client: { sources },
    issuer: ISSUER,
    e2e: plainE2e(net.fetch),
    cloud: { fetch: net.fetch },
    now: () => NOW,
  });
  return { sources, net, provider };
}

describe("browser-cloud 凭据提供方", () => {
  it("Cookie 会话要断言（设备是浏览器），断言换源 core 的会话；不去刷新云令牌", async () => {
    const { sources, net, provider } = setup();
    const access = await provider.getAccess(SOURCE, "relayed");
    expect(access).toMatchObject({
      accessToken: "core-a",
      httpBase: BASE,
      wsBase: `wss://${SOURCE}.src.relay.example`,
      relayToken: "relay.jwt",
    });
    expect(sources.assertion).toHaveBeenCalledWith({
      sourceId: SOURCE,
      device: expect.objectContaining({ platform: "browser" }),
    });
    expect(net.calls.map((call) => call.key)).toEqual([
      "POST /api/identity/cloud/login",
    ]);
    const login = new Headers(net.calls[0]!.init.headers);
    expect(login.get("armadra-relay-token")).toBe("relay.jwt");
    expect(JSON.parse(String(net.calls[0]!.init.body))).toMatchObject({
      assertion: "jws.assertion",
    });
  });

  it("同一个源复用缓存；refresh 用存着的刷新令牌轮换会话，不再要断言登录", async () => {
    const { sources, net, provider } = setup();
    await provider.getAccess(SOURCE, "relayed");
    await provider.getAccess(SOURCE, "relayed");
    expect(sources.assertion).toHaveBeenCalledTimes(1);
    const renewed = await provider.refresh(SOURCE, "relayed");
    expect(renewed.accessToken).toBe("core-b");
    expect(net.calls.at(-1)!.key).toBe("POST /api/identity/session/refresh");
    expect(net.calls.filter((c) => c.key.endsWith("cloud/login"))).toHaveLength(
      1,
    );
  });

  it("只走中继：其余路答 unreachable", async () => {
    const { provider } = setup();
    await expect(provider.getAccess(SOURCE, "direct")).rejects.toMatchObject({
      code: SOURCE_ERROR.unreachable,
    });
  });

  it.each([
    [new CloudConsoleError("source_revoked", 403), SOURCE_ERROR.revoked],
    [
      new CloudConsoleError("source_access_denied", 403),
      SOURCE_ERROR.accessRevoked,
    ],
    [new CloudConsoleError("session_expired", 401), SOURCE_ERROR.unauthorized],
  ])("控制面拒绝 %s → 源层的码", async (failure, code) => {
    const { provider } = setup(async () => {
      throw failure;
    });
    await expect(provider.getAccess(SOURCE, "relayed")).rejects.toMatchObject({
      code,
    });
  });

  it("源不在线：source_offline，不去登录", async () => {
    const { net, provider } = setup(async () => assertion({ online: false }));
    await expect(provider.getAccess(SOURCE, "relayed")).rejects.toMatchObject({
      code: SOURCE_ERROR.offline,
    });
    expect(net.calls).toHaveLength(0);
  });

  it("clear()：访问与会话都丢，下一次从断言重来", async () => {
    const { sources, provider } = setup();
    await provider.getAccess(SOURCE, "relayed");
    provider.clear();
    await provider.getAccess(SOURCE, "relayed");
    expect(sources.assertion).toHaveBeenCalledTimes(2);
  });
});
