import { afterEach, describe, expect, it, vi } from "vitest";

import { routedFetch } from "../../mobile/testing";
import type { CloudAssertion } from "../../sources/cloud-client";
import { pendingApprovals } from "../../sources/e2e/manager";
import { plainE2e } from "../../sources/e2e/testing";
import { CloudConsoleError } from "../api/errors";
import { IDLE_MS, createBrowserEndorser } from "./browser-endorser";
import type { EndorsableRequest } from "./endorser";

/**
 * 生产背书人：经 `browser-cloud` 提供方与端到端通道（这里的通道是不握手的替身，`fetchFor` 直接
 * 答路由假网络）。核对：受信 / 非受信、forbidden、通道失败、校验码不泄露、空闲关闭与上限。
 */

const ISSUER = "https://app.example";
const SOURCE = "b".repeat(32);
const NOW = Date.now();
const SAS = "482915";

const baseOf = (sourceId: string) => `https://${sourceId}.src.relay.example`;

const assertion = (sourceId: string): CloudAssertion => ({
  assertion: "jws.assertion",
  assertionExpiresAtMs: NOW + 300_000,
  relayToken: "relay.jwt",
  relayTokenExpiresAtMs: NOW + 3_600_000,
  relayOrigin: "https://relay.example",
  relayBaseUrl: baseOf(sourceId),
  online: true,
});

const session = (access: string) => ({
  hostId: SOURCE,
  expiresAtUnixMs: NOW + 900_000,
  csrfToken: "c".repeat(43),
  native: { accessToken: access, refreshToken: `${access}-r` },
});

const request = (over: Partial<EndorsableRequest> = {}): EndorsableRequest =>
  ({
    requestId: "trq_1",
    sourceId: SOURCE,
    sourceName: "build-01",
    teamId: "t1",
    member: { accountId: "a1", email: "a@x.test", displayName: "A" },
    device: { name: "Pixel 9", platform: "android" },
    requestedAtMs: 1,
    expiresAtMs: 2,
    pendingId: "pend-1",
    ...over,
  }) as EndorsableRequest;

type Reply = { status?: number; body: unknown };

interface Options {
  /** 登录答：`pending` = 新设备（`device_pending`）。 */
  login?: "trusted" | "pending";
  approve?: (init: RequestInit) => Reply;
  idleMs?: number;
  maxOpen?: number;
  channelFailure?: unknown;
}

function setup(options: Options = {}) {
  const sources = {
    assertion: vi.fn(async (input: { sourceId: string }) =>
      assertion(input.sourceId),
    ),
  };
  const net = routedFetch({
    "POST /api/identity/cloud/login": () =>
      options.login === "pending"
        ? {
            status: 403,
            body: {
              code: "device_pending",
              message: "",
              details: { pendingId: "pend-1" },
            },
          }
        : { body: { session: session("core-a") } },
    "POST /api/identity/session/refresh": () => ({
      body: session("core-b"),
    }),
    "POST /api/devices/approve": (init) =>
      options.approve?.(init) ?? { body: { device: { deviceId: "d1" } } },
  });
  const channels = plainE2e(net.fetch);
  const awaitApproval = vi.fn(channels.awaitApproval);
  const close = vi.fn();
  Object.assign(channels, { awaitApproval, close });
  if (options.channelFailure !== undefined)
    Object.assign(channels, {
      channel: async () => {
        throw options.channelFailure;
      },
    });
  const endorser = createBrowserEndorser({
    client: { sources },
    issuer: ISSUER,
    channels,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.maxOpen === undefined ? {} : { maxOpen: options.maxOpen }),
  });
  return { sources, net, channels, awaitApproval, close, endorser };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("生产背书人 · canEndorse", () => {
  it("登录成功 = 本浏览器是这台主机的受信设备", async () => {
    const { endorser, net, sources } = setup();
    expect(await endorser.canEndorse(SOURCE)).toBe(true);
    expect(sources.assertion).toHaveBeenCalledWith({
      sourceId: SOURCE,
      device: expect.objectContaining({ platform: "browser" }),
    });
    expect(net.calls.map((call) => call.key)).toEqual([
      "POST /api/identity/cloud/login",
    ]);
  });

  it("主机答 device_pending：不是受信设备，不等主人核对、不弹待确认", async () => {
    const { endorser, awaitApproval } = setup({ login: "pending" });
    expect(await endorser.canEndorse(SOURCE)).toBe(false);
    expect(awaitApproval).not.toHaveBeenCalled();
    expect(pendingApprovals.snapshot()).toEqual([]);
  });

  it("通道开不了：抛 e2e_device_unavailable（不是确定的「否」，调用方不缓存）", async () => {
    const { endorser } = setup({
      channelFailure: Object.assign(new Error("x"), { code: "unreachable" }),
    });
    await expect(endorser.canEndorse(SOURCE)).rejects.toMatchObject({
      code: "e2e_device_unavailable",
    });
  });

  it("控制面拒绝断言（会话过期）：device_untrusted → 不可背书", async () => {
    const sources = {
      assertion: vi.fn(async () => {
        throw new CloudConsoleError("session_expired", 401);
      }),
    };
    const endorser = createBrowserEndorser({
      client: { sources },
      issuer: ISSUER,
      channels: plainE2e(routedFetch({}).fetch),
    });
    expect(await endorser.canEndorse(SOURCE)).toBe(false);
  });
});

describe("生产背书人 · approve", () => {
  it("校验码与 pendingId 经通道交给主机 devices.approve，带会话与中继令牌", async () => {
    const { endorser, net } = setup();
    await endorser.approve(request(), SAS);
    const call = net.calls.find(
      (one) => one.key === "POST /api/devices/approve",
    );
    expect(call?.url.origin).toBe(baseOf(SOURCE));
    expect(JSON.parse(String(call?.init.body))).toEqual({
      pendingId: "pend-1",
      sas: SAS,
    });
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer core-a");
    expect(headers.get("armadra-relay-token")).toBe("relay.jwt");
    // 用的是 core 的 pendingId，不是云端的 trq_ 请求号。
    expect(String(call?.init.body)).not.toContain("trq_1");
  });

  it("访问令牌被拒（401）：换一份会话再发一次", async () => {
    let first = true;
    const { endorser, net } = setup({
      approve: () => {
        const reply = first
          ? { status: 401, body: { code: "unauthenticated", message: "" } }
          : { body: { device: {} } };
        first = false;
        return reply;
      },
    });
    await endorser.approve(request(), SAS);
    const approves = net.calls.filter(
      (one) => one.key === "POST /api/devices/approve",
    );
    expect(approves).toHaveLength(2);
    expect(new Headers(approves[1]?.init.headers).get("authorization")).toBe(
      "Bearer core-b",
    );
  });

  it.each(["sas_mismatch", "sas_expired", "forbidden", "not_found"])(
    "主机答 %s：原样抛带该码的错",
    async (code) => {
      const { endorser } = setup({
        approve: () => ({
          status: code === "forbidden" ? 403 : 400,
          body: { code, message: `message with ${SAS}` },
        }),
      });
      await expect(endorser.approve(request(), SAS)).rejects.toMatchObject({
        code,
      });
    },
  );

  it("主机没有给码的 403 按 forbidden", async () => {
    const { endorser } = setup({
      approve: () => ({ status: 403, body: null }),
    });
    await expect(endorser.approve(request(), SAS)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("浏览器不是受信设备：device_untrusted，不去调 devices.approve", async () => {
    const { endorser, net } = setup({ login: "pending" });
    await expect(endorser.approve(request(), SAS)).rejects.toMatchObject({
      code: "device_untrusted",
    });
    expect(net.calls.some((one) => one.key.endsWith("devices/approve"))).toBe(
      false,
    );
  });

  it("通道失败：e2e_device_unavailable", async () => {
    const { endorser } = setup({
      channelFailure: Object.assign(new Error("x"), { code: "offline" }),
    });
    await expect(endorser.approve(request(), SAS)).rejects.toMatchObject({
      code: "e2e_device_unavailable",
    });
  });

  it("请求在通道上断了（fetch 抛）：e2e_device_unavailable", async () => {
    const { endorser, net } = setup();
    await endorser.canEndorse(SOURCE);
    (net.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new TypeError(`boom ${SAS}`);
      },
    );
    await expect(endorser.approve(request(), SAS)).rejects.toMatchObject({
      code: "e2e_device_unavailable",
    });
  });

  it("校验码不泄露：失败对象、日志、存储、控制面请求里都没有", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failures: unknown[] = [];
    for (const code of ["sas_mismatch", "forbidden"]) {
      const { endorser, sources } = setup({
        approve: () => ({
          status: 400,
          body: { code, message: `bad code ${SAS}` },
        }),
      });
      await endorser.approve(request(), SAS).catch((failure: unknown) => {
        failures.push(failure);
      });
      expect(JSON.stringify(sources.assertion.mock.calls)).not.toContain(SAS);
    }
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      const e = failure as Error;
      expect(`${e.message}${e.stack}${JSON.stringify(failure)}`).not.toContain(
        SAS,
      );
    }
    for (const spy of [log, warn, error])
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SAS);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SAS);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SAS);
  });
});

describe("生产背书人 · 通道的生命周期", () => {
  it("空闲到点关通道、忘掉访问；用着的时候不关", async () => {
    vi.useFakeTimers();
    const { endorser, close, sources } = setup();
    await endorser.canEndorse(SOURCE);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(close).not.toHaveBeenCalled();
    // 又用了一次：计时重来。
    await endorser.canEndorse(SOURCE);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(close).not.toHaveBeenCalled();
    expect(sources.assertion).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledExactlyOnceWith(ISSUER, SOURCE);
    // 关了之后再用：重新取断言（访问已忘），不是一直复用。
    await endorser.canEndorse(SOURCE);
    expect(sources.assertion).toHaveBeenCalledTimes(2);
  });

  it("同一个源重复判定复用同一份访问，不重开", async () => {
    const { endorser, sources, net } = setup();
    await Promise.all([
      endorser.canEndorse(SOURCE),
      endorser.canEndorse(SOURCE),
    ]);
    await endorser.canEndorse(SOURCE);
    expect(sources.assertion).toHaveBeenCalledTimes(1);
    expect(
      net.calls.filter((one) => one.key.endsWith("cloud/login")),
    ).toHaveLength(1);
  });

  it("同时打开不超过上限：新开一个源时关最久没用的", async () => {
    const { endorser, close } = setup({ maxOpen: 2 });
    await endorser.canEndorse("a");
    await endorser.canEndorse("b");
    expect(close).not.toHaveBeenCalled();
    await endorser.canEndorse("c");
    expect(close).toHaveBeenCalledExactlyOnceWith(ISSUER, "a");
    // b 比 c 旧：再开 d 关 b。
    await endorser.canEndorse("d");
    expect(close).toHaveBeenLastCalledWith(ISSUER, "b");
  });

  it("同时进行的操作也不超过上限（信任页一次判很多行）", async () => {
    let running = 0;
    let peak = 0;
    const sources = {
      assertion: vi.fn(async (input: { sourceId: string }) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return assertion(input.sourceId);
      }),
    };
    const net = routedFetch({
      "POST /api/identity/cloud/login": () => ({
        body: { session: session("core-a") },
      }),
    });
    const endorser = createBrowserEndorser({
      client: { sources },
      issuer: ISSUER,
      channels: plainE2e(net.fetch),
      maxOpen: 2,
    });
    const answers = await Promise.all(
      ["a", "b", "c", "d", "e"].map((id) => endorser.canEndorse(id)),
    );
    expect(answers).toEqual([true, true, true, true, true]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("dispose：关掉所有通道、忘掉访问，之后还能按需重开", async () => {
    const { endorser, close, sources } = setup();
    await endorser.canEndorse("a");
    await endorser.canEndorse("b");
    endorser.dispose();
    expect(close).toHaveBeenCalledTimes(2);
    await endorser.canEndorse("a");
    expect(sources.assertion).toHaveBeenCalledTimes(3);
  });
});
