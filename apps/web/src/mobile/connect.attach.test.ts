import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRelayEnrollment } from "./connect";
import { loadConnections } from "./connections";
import type { E2eChannels } from "../sources/e2e/manager";
import {
  SESSION_A,
  SESSION_B,
  fakeBridge,
  memoryStorage,
  routedFetch,
} from "./testing";

const ISSUER = "https://cloud.example.com";
const HOST = "a".repeat(32);
const OTHER = "b".repeat(32);
const BASE = `https://${HOST}.src.example.com`;

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

const session = () => ({
  accessToken: "cloud-access-2",
  refreshToken: "cloud-refresh-2",
  accessExpiresAtMs: Date.now() + 900_000,
  expiresAtMs: Date.now() + 9_000_000,
  account: { accountId: "acct-1", displayName: "A" },
});

function setup(options: { refresh?: number; sources?: string[] } = {}) {
  const sources = options.sources ?? [HOST];
  const cloud = routedFetch({
    "POST /v1/auth/refresh": () =>
      options.refresh === undefined
        ? { body: { session: session() } }
        : {
            status: options.refresh,
            body: { code: "unauthenticated", message: "" },
          },
    "GET /v1/me/sources": () => ({
      body: {
        sources: sources.map((sourceId) => ({
          sourceId,
          name: "MacBook",
          online: true,
          owner: true,
        })),
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
        online: true,
      },
    }),
  });
  const sealed = routedFetch({
    "POST /api/identity/cloud/login": () => ({
      body: {
        session: {
          hostId: HOST,
          expiresAtUnixMs: Date.now() + 900_000,
          native: { accessToken: SESSION_A, refreshToken: SESSION_B },
        },
      },
    }),
  });
  const e2e = {
    channel: vi.fn(async () => ({ sas: "000000" })),
    fetchFor: () => sealed.fetch,
    socketFor: () => globalThis.WebSocket,
    awaitApproval: vi.fn(async () => true as const),
    pinned: () => true,
    forget: () => undefined,
    close: () => undefined,
  } as unknown as E2eChannels;
  const { bridge, remotes, sessions } = fakeBridge();
  const reload = vi.fn();
  const enroll = createRelayEnrollment({
    bridge,
    cloud: { fetch: cloud.fetch },
    e2e,
    reload,
    open: vi.fn(async () => true),
  });
  return { enroll, remotes, sessions, reload, cloud };
}

const remote = (serviceId: string, issuer = ISSUER) => ({
  serviceId,
  issuer,
  kind: "saas" as const,
  refreshToken: "cloud-refresh-1",
  fingerprint: "",
});

describe("手机挂载连接二维码里的中转半（契约 §99.5）", () => {
  it("钥匙串里已有这个签发方的登录：直接挂源，不弹列表，并存下新的刷新令牌", async () => {
    const { enroll, remotes, sessions, reload } = setup();
    remotes.set(
      "personal:cloud.example.com:acct-1",
      remote("personal:cloud.example.com:acct-1"),
    );
    await expect(
      enroll.attach({ sourceId: HOST, issuers: [ISSUER] }),
    ).resolves.toEqual({ kind: "done" });
    expect(sessions.get(`${HOST}|relayed`)).toMatchObject({
      accessToken: SESSION_A,
    });
    expect(remotes.get("personal:cloud.example.com:acct-1")?.refreshToken).toBe(
      "cloud-refresh-2",
    );
    expect(loadConnections().map((row) => row.sourceId)).toEqual([HOST]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("quiet：后台顺带挂上，不重载页面", async () => {
    const { enroll, remotes, reload } = setup();
    remotes.set(
      "personal:cloud.example.com",
      remote("personal:cloud.example.com"),
    );
    await expect(
      enroll.attach({ sourceId: HOST, issuers: [ISSUER] }, { quiet: true }),
    ).resolves.toEqual({ kind: "done" });
    expect(reload).not.toHaveBeenCalled();
    expect(loadConnections().map((row) => row.sourceId)).toEqual([HOST]);
  });

  it("没有这个签发方的登录：答 login 和第一个签发方，不发任何请求", async () => {
    const { enroll, cloud } = setup();
    await expect(
      enroll.attach({
        sourceId: HOST,
        issuers: [ISSUER, "https://b.example.com"],
      }),
    ).resolves.toEqual({ kind: "login", issuer: ISSUER });
    expect(cloud.calls).toEqual([]);
  });

  it("访客槽不拿来挂别的源", async () => {
    const { enroll, remotes } = setup();
    remotes.set(
      `personal:cloud.example.com:guest.${OTHER}`,
      remote(`personal:cloud.example.com:guest.${OTHER}`),
    );
    await expect(
      enroll.attach({ sourceId: HOST, issuers: [ISSUER] }),
    ).resolves.toEqual({ kind: "login", issuer: ISSUER });
  });

  it("刷新令牌已失效：当没登录过，走登录", async () => {
    const { enroll, remotes } = setup({ refresh: 401 });
    remotes.set(
      "personal:cloud.example.com",
      remote("personal:cloud.example.com"),
    );
    await expect(
      enroll.attach({ sourceId: HOST, issuers: [ISSUER] }),
    ).resolves.toEqual({ kind: "login", issuer: ISSUER });
  });

  it("这个账号下没有这台电脑：wrongAccount", async () => {
    const { enroll, remotes, reload } = setup({ sources: [OTHER] });
    remotes.set(
      "personal:cloud.example.com",
      remote("personal:cloud.example.com"),
    );
    await expect(
      enroll.attach({ sourceId: HOST, issuers: [ISSUER] }),
    ).resolves.toMatchObject({ kind: "failure", failure: "wrongAccount" });
    expect(reload).not.toHaveBeenCalled();
  });
});
