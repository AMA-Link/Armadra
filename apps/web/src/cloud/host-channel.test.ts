import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudAssertion } from "../sources/cloud-client";
import { plainE2e } from "../sources/e2e/testing";
import { createHostChannel } from "./host-channel";

/**
 * 通道池的 `request`（「新建链接」用它，背书器的 approve 也经它）：白名单之外一个字节都不发、
 * GET 不带体、不受信不登录、401 换会话重发一次。池的生命周期由 `browser-endorser.test.ts` 守。
 */

const ISSUER = "https://app.example";
const SOURCE = "b".repeat(32);
const NOW = Date.now();
const BASE = `https://${SOURCE}.src.relay.example`;

const assertion: CloudAssertion = {
  assertion: "jws",
  assertionExpiresAtMs: NOW + 300_000,
  relayToken: "relay.jwt",
  relayTokenExpiresAtMs: NOW + 3_600_000,
  relayOrigin: "https://relay.example",
  relayBaseUrl: BASE,
  online: true,
};

type Reply = { status?: number; body?: unknown };

function setup(options: { trusted?: boolean; sources?: () => Reply } = {}): {
  channel: ReturnType<typeof createHostChannel>;
  calls: { path: string; init: RequestInit }[];
  sources: { assertion: ReturnType<typeof vi.fn> };
} {
  const calls: { path: string; init: RequestInit }[] = [];
  let logins = 0;
  const reply = (r: Reply) =>
    ({
      ok: (r.status ?? 200) < 300,
      status: r.status ?? 200,
      headers: new Headers(),
      json: async () => r.body ?? {},
    }) as unknown as Response;
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, init });
      const body = (
        typeof init.body === "string" ? JSON.parse(init.body) : {}
      ) as Record<string, unknown>;
      if (path === "/api/identity/hello")
        return reply({ body: { capabilities: ["identity.cloud.probe.v1"] } });
      if (path === "/api/identity/cloud/login") {
        if (body.probe === true)
          return reply(
            options.trusted === false
              ? { status: 403, body: { code: "device_untrusted" } }
              : { body: { trusted: true } },
          );
        logins += 1;
        return reply({
          body: {
            session: {
              hostId: SOURCE,
              expiresAtUnixMs: NOW + 900_000,
              csrfToken: "c".repeat(43),
              native: {
                accessToken: `core-${logins}`,
                refreshToken: `refresh-${logins}`,
              },
            },
          },
        });
      }
      if (path === "/api/sources")
        return reply(options.sources?.() ?? { body: { remotes: [] } });
      return reply({ body: {} });
    },
  );
  const sources = { assertion: vi.fn(async () => assertion) };
  const channel = createHostChannel({
    client: { sources },
    issuer: ISSUER,
    channels: plainE2e(fetchImpl as unknown as typeof fetch),
    now: () => NOW,
  });
  return { channel, calls, sources };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("通道池 · request", () => {
  it.each([
    ["POST", "/api/e2e/pairing-secret"],
    ["POST", "/api/rpc/e2e/pairingSecret"],
    ["GET", "/api/devices/approve"],
    ["POST", "/api/sources"],
    ["POST", "/api/sources/remotes/svc/links/x/url"],
    ["POST", "/api/identity/cloud/bind"],
    // 点段、编码的点段、反斜杠：按前缀匹配会放过，解析后落到别的地址。
    ["POST", "/api/sources/remotes/../../e2e/pairing-secret/links"],
    ["POST", "/api/sources/remotes/..%2f..%2fe2e%2fpairing-secret/links"],
    ["POST", "/api/sources/remotes/%2e%2e/links"],
    ["POST", "/api/sources/remotes/a\\..\\x/links"],
    ["GET", "/api/sources/./"],
    ["GET", "/api/sources?x=1"],
  ] as const)(
    "白名单之外（%s %s）答 forbidden，不取断言、不发请求",
    async (method, path) => {
      const { channel, calls, sources } = setup();
      await expect(
        channel.request(SOURCE, path, { method }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(sources.assertion).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    },
  );

  it("GET 不带体与 content-type，带会话与中继令牌", async () => {
    const { channel, calls } = setup();
    const response = await channel.request(SOURCE, "/api/sources", {
      method: "GET",
    });
    expect(response.ok).toBe(true);
    const get = calls.find((call) => call.path === "/api/sources")!;
    expect(get.init.method).toBe("GET");
    expect(get.init.body).toBeUndefined();
    const headers = get.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer core-1");
    expect(get.init.credentials).toBe("omit");
  });

  it("不受信：抛 device_untrusted，不普通登录、不发请求", async () => {
    const { channel, calls } = setup({ trusted: false });
    await expect(
      channel.request(SOURCE, "/api/sources", { method: "GET" }),
    ).rejects.toMatchObject({ code: "device_untrusted" });
    expect(
      calls.filter(
        (call) =>
          call.path === "/api/identity/cloud/login" &&
          !String(call.init.body).includes('"probe":true'),
      ),
    ).toHaveLength(0);
    expect(calls.some((call) => call.path === "/api/sources")).toBe(false);
  });

  it("401：换一份会话重发一次，答第二次的响应", async () => {
    let first = true;
    const { channel, calls } = setup({
      sources: () => {
        if (first) {
          first = false;
          return { status: 401, body: { code: "unauthenticated" } };
        }
        return { body: { remotes: [] } };
      },
    });
    const response = await channel.request(SOURCE, "/api/sources", {
      method: "GET",
    });
    expect(response.status).toBe(200);
    const gets = calls.filter((call) => call.path === "/api/sources");
    expect(
      gets.map(
        (call) => (call.init.headers as Record<string, string>).authorization,
      ),
    ).toEqual(["Bearer core-1", "Bearer core-2"]);
  });

  it("同一个源的第二次请求复用会话，不再登录", async () => {
    const { channel, calls } = setup();
    await channel.request(SOURCE, "/api/sources", { method: "GET" });
    await channel.request(SOURCE, "/api/sources", { method: "GET" });
    const logins = calls.filter(
      (call) =>
        call.path === "/api/identity/cloud/login" &&
        !String(call.init.body).includes('"probe":true'),
    );
    expect(logins).toHaveLength(1);
    channel.dispose();
  });

  it.each(["source_unauthorized", "cloud_not_registered"])(
    "401 %s 是主机替远程服务答的：不换会话、不再登录，原码交回",
    async (code) => {
      const { channel, calls } = setup({
        sources: () => ({ status: 401, body: { code } }),
      });
      const response = await channel.request(SOURCE, "/api/sources", {
        method: "GET",
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code });
      expect(calls.filter((call) => call.path === "/api/sources")).toHaveLength(
        1,
      );
      expect(
        calls.filter(
          (call) =>
            call.path === "/api/identity/cloud/login" &&
            !String(call.init.body).includes('"probe":true'),
        ),
      ).toHaveLength(1);
    },
  );
});
