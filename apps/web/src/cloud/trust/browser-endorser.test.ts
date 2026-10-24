import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudAssertion } from "../../sources/cloud-client";
import { pendingApprovals } from "../../sources/e2e/manager";
import { plainE2e } from "../../sources/e2e/testing";
import { CloudConsoleError } from "../api/errors";
import { IDLE_MS, createBrowserEndorser } from "./browser-endorser";
import type { EndorsableRequest } from "./endorser";

/**
 * 生产背书人：经端到端通道（这里是不握手的替身，`fetchFor` 直接答假 core）和源访问断言。
 * 核对：判定只用 probe（不登录、不留会话）、approve 先确认受信再登录、受信 / 非受信 / forbidden /
 * 通道失败、校验码不泄露、空闲关闭与上限、dispose 与进行中操作的竞态、会话注销。
 */

const ISSUER = "https://app.example";
const SOURCE = "b".repeat(32);
const NOW = Date.now();
const SAS = "482915";

const baseOf = (sourceId: string) => `https://${sourceId}.src.relay.example`;

const assertion = (sourceId: string): CloudAssertion => ({
  assertion: `jws.${sourceId}`,
  assertionExpiresAtMs: NOW + 300_000,
  relayToken: "relay.jwt",
  relayTokenExpiresAtMs: NOW + 3_600_000,
  relayOrigin: "https://relay.example",
  relayBaseUrl: baseOf(sourceId),
  online: true,
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

interface Call {
  readonly path: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
}
type Reply = { status?: number; body?: unknown };

interface Options {
  /** 设备是不是受信：`false` 时 probe 答 device_untrusted，普通登录答 device_pending。 */
  trusted?: boolean;
  probe?: () => Reply | Promise<Reply>;
  login?: () => Reply | Promise<Reply>;
  approve?: (init: RequestInit) => Reply;
  idleMs?: number;
  maxOpen?: number;
  channelFailure?: unknown;
  assertionGate?: Promise<void>;
  /** core 在 hello 里报的能力名；缺省认 probe。 */
  capabilities?: string[];
  hello?: () => Reply;
  /** 通道对象固定（真实通道开着就是同一个对象）。 */
  stableChannel?: boolean;
}

function setup(options: Options = {}) {
  const calls: Call[] = [];
  let logins = 0;
  const reply = (r: Reply) =>
    ({
      ok: (r.status ?? 200) < 300,
      status: r.status ?? 200,
      headers: new Headers(),
      json: async () => r.body ?? {},
    }) as unknown as Response;
  const session = () => {
    logins += 1;
    return {
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
    };
  };
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      const body = (
        typeof init.body === "string" ? JSON.parse(init.body) : {}
      ) as Record<string, unknown>;
      calls.push({ path, init, body });
      if (path === "/api/identity/hello")
        return reply(
          options.hello?.() ?? {
            body: {
              capabilities: options.capabilities ?? [
                "identity.native-session.v1",
                "identity.cloud.probe.v1",
              ],
            },
          },
        );
      if (path === "/api/identity/cloud/login") {
        if (body.probe === true)
          return reply(
            (await options.probe?.()) ??
              (options.trusted === false
                ? {
                    status: 403,
                    body: { code: "device_untrusted", message: "" },
                  }
                : { body: { trusted: true } }),
          );
        return reply(
          (await options.login?.()) ??
            (options.trusted === false
              ? {
                  status: 403,
                  body: {
                    code: "device_pending",
                    message: "",
                    details: { pendingId: "pend-1" },
                  },
                }
              : session()),
        );
      }
      if (path === "/api/devices/approve")
        return reply(
          options.approve?.(init) ?? { body: { device: { deviceId: "d1" } } },
        );
      if (path === "/api/identity/session/logout")
        return reply({ body: { closed: true } });
      return reply({ status: 404, body: { code: "not_found", message: "" } });
    },
  );
  const channels = plainE2e(fetchImpl as unknown as typeof fetch);
  const awaitApproval = vi.fn(channels.awaitApproval);
  const close = vi.fn();
  Object.assign(channels, { awaitApproval, close });
  if (options.stableChannel === true) {
    const same = { sas: "000000" };
    Object.assign(channels, { channel: async () => same });
  }
  if (options.channelFailure !== undefined)
    Object.assign(channels, {
      channel: async () => {
        throw options.channelFailure;
      },
    });
  const sources = {
    assertion: vi.fn(async (input: { sourceId: string }) => {
      await options.assertionGate;
      return assertion(input.sourceId);
    }),
  };
  const endorser = createBrowserEndorser({
    client: { sources },
    issuer: ISSUER,
    channels,
    now: () => NOW,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.maxOpen === undefined ? {} : { maxOpen: options.maxOpen }),
  });
  const at = (path: string) => calls.filter((call) => call.path === path);
  return {
    sources,
    calls,
    at,
    channels,
    awaitApproval,
    close,
    endorser,
    probes: () =>
      at("/api/identity/cloud/login").filter((c) => c.body.probe === true),
    logins: () =>
      at("/api/identity/cloud/login").filter((c) => c.body.probe !== true),
    logouts: () => at("/api/identity/session/logout"),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("生产背书人 · canEndorse（只用 probe）", () => {
  it("受信：probe 答 trusted；不普通登录、不留会话", async () => {
    const { endorser, probes, logins, sources } = setup();
    expect(await endorser.canEndorse(SOURCE)).toBe(true);
    expect(sources.assertion).toHaveBeenCalledWith({
      sourceId: SOURCE,
      device: expect.objectContaining({ platform: "browser" }),
    });
    expect(probes()).toHaveLength(1);
    expect(probes()[0]!.body).toEqual({
      assertion: `jws.${SOURCE}`,
      probe: true,
    });
    expect(logins()).toHaveLength(0);
  });

  it("不受信：false，只发 probe，不会在主机上触发普通登录或待确认", async () => {
    const { endorser, probes, logins, awaitApproval } = setup({
      trusted: false,
    });
    expect(await endorser.canEndorse(SOURCE)).toBe(false);
    expect(probes()).toHaveLength(1);
    expect(logins()).toHaveLength(0);
    expect(awaitApproval).not.toHaveBeenCalled();
    expect(pendingApprovals.snapshot()).toEqual([]);
  });

  it("probe 被限流等非确定失败：抛 e2e_device_unavailable，不当作「否」", async () => {
    const { endorser } = setup({
      probe: () => ({
        status: 429,
        body: { code: "rate_limited", message: "" },
      }),
    });
    await expect(endorser.canEndorse(SOURCE)).rejects.toMatchObject({
      code: "e2e_device_unavailable",
    });
  });

  it("通道开不了：抛 e2e_device_unavailable", async () => {
    const { endorser } = setup({
      channelFailure: Object.assign(new Error("x"), { code: "unreachable" }),
    });
    await expect(endorser.canEndorse(SOURCE)).rejects.toMatchObject({
      code: "e2e_device_unavailable",
    });
  });

  it("控制面拒绝断言（会话过期）：不是确定的「否」，抛 e2e_device_unavailable", async () => {
    const sources = {
      assertion: vi.fn(async () => {
        throw new CloudConsoleError("session_expired", 401);
      }),
    };
    const endorser = createBrowserEndorser({
      client: { sources },
      issuer: ISSUER,
      channels: plainE2e(vi.fn() as unknown as typeof fetch),
    });
    await expect(endorser.canEndorse(SOURCE)).rejects.toMatchObject({
      code: "e2e_device_unavailable",
    });
  });
});

describe("生产背书人 · 旧 core（没有 probe 能力位）", () => {
  const old = { capabilities: ["identity.native-session.v1"] };

  it("canEndorse：直接不可背书，不发任何 cloud/login", async () => {
    const { endorser, at } = setup(old);
    expect(await endorser.canEndorse(SOURCE)).toBe(false);
    expect(at("/api/identity/cloud/login")).toHaveLength(0);
    expect(at("/api/identity/hello")).toHaveLength(1);
  });

  it("approve：device_untrusted，不 probe、不登录、不调 devices.approve", async () => {
    const { endorser, at } = setup(old);
    await expect(endorser.approve(request(), SAS)).rejects.toMatchObject({
      code: "device_untrusted",
    });
    expect(at("/api/identity/cloud/login")).toHaveLength(0);
    expect(at("/api/devices/approve")).toHaveLength(0);
  });

  it("hello 读不到（404 / 断了）：旧 core 同样不发 cloud/login", async () => {
    const { endorser, at } = setup({
      hello: () => ({ status: 404, body: { code: "not_found", message: "" } }),
    });
    await expect(endorser.canEndorse(SOURCE)).rejects.toMatchObject({
      code: "e2e_device_unavailable",
    });
    expect(at("/api/identity/cloud/login")).toHaveLength(0);
  });

  it("能力按通道读一次：同一条通道上重复判定不再读 hello；读失败不缓存", async () => {
    const { endorser, at } = setup({ stableChannel: true });
    await endorser.canEndorse(SOURCE);
    await endorser.canEndorse(SOURCE);
    await endorser.canEndorse("other");
    expect(at("/api/identity/hello")).toHaveLength(1);
    let down = true;
    const retry = setup({
      stableChannel: true,
      hello: () =>
        down
          ? { status: 503, body: { code: "source_offline", message: "" } }
          : { body: { capabilities: ["identity.cloud.probe.v1"] } },
    });
    await expect(retry.endorser.canEndorse(SOURCE)).rejects.toBeDefined();
    down = false;
    expect(await retry.endorser.canEndorse(SOURCE)).toBe(true);
  });
});

describe("生产背书人 · approve", () => {
  it("先确认受信、再登录取会话，校验码与 pendingId 经通道交给 devices.approve", async () => {
    const { endorser, calls: all } = setup();
    await endorser.approve(request(), SAS);
    const calls = all.filter((call) => call.path !== "/api/identity/hello");
    expect(calls.map((call) => call.path)).toEqual([
      "/api/identity/cloud/login",
      "/api/identity/cloud/login",
      "/api/devices/approve",
    ]);
    expect(calls[0]!.body.probe).toBe(true);
    expect(calls[1]!.body.probe).toBeUndefined();
    const call = calls[2]!;
    expect(call.body).toEqual({ pendingId: "pend-1", sas: SAS });
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer core-1");
    expect(headers.get("armadra-relay-token")).toBe("relay.jwt");
    // 用的是 core 的 pendingId，不是云端的 trq_ 请求号。
    expect(JSON.stringify(call.body)).not.toContain("trq_1");
  });

  it("浏览器不是受信设备：device_untrusted，不登录（不在主机上挂起）、不调 approve", async () => {
    const { endorser, logins, at } = setup({ trusted: false });
    await expect(endorser.approve(request(), SAS)).rejects.toMatchObject({
      code: "device_untrusted",
    });
    expect(logins()).toHaveLength(0);
    expect(at("/api/devices/approve")).toHaveLength(0);
  });

  it("探测后登录仍遇到 device_pending / device_rejected：device_untrusted", async () => {
    for (const code of ["device_pending", "device_rejected"]) {
      const { endorser, at } = setup({
        login: () => ({ status: 403, body: { code, message: "" } }),
      });
      await expect(endorser.approve(request(), SAS)).rejects.toMatchObject({
        code: "device_untrusted",
      });
      expect(at("/api/devices/approve")).toHaveLength(0);
    }
  });

  it("登录被限流：e2e_device_unavailable，不是 device_untrusted", async () => {
    const { endorser } = setup({
      login: () => ({
        status: 429,
        body: { code: "rate_limited", message: "" },
      }),
    });
    await expect(endorser.approve(request(), SAS)).rejects.toMatchObject({
      code: "e2e_device_unavailable",
    });
  });

  it("会话复用：第二次 approve 不再登录", async () => {
    const { endorser, logins, probes, at } = setup();
    await endorser.approve(request(), SAS);
    await endorser.approve(request({ pendingId: "pend-2" }), SAS);
    expect(logins()).toHaveLength(1);
    expect(probes()).toHaveLength(1);
    expect(at("/api/devices/approve")).toHaveLength(2);
  });

  it("访问令牌被拒（401）：换一份会话再发一次，旧会话注销", async () => {
    let first = true;
    const { endorser, at, logouts } = setup({
      approve: () => {
        const r = first
          ? { status: 401, body: { code: "unauthenticated", message: "" } }
          : { body: { device: {} } };
        first = false;
        return r;
      },
    });
    await endorser.approve(request(), SAS);
    const approves = at("/api/devices/approve");
    expect(approves).toHaveLength(2);
    expect(new Headers(approves[1]?.init.headers).get("authorization")).toBe(
      "Bearer core-2",
    );
    await vi.waitFor(() => expect(logouts()).toHaveLength(1));
    expect(new Headers(logouts()[0]!.init.headers).get("authorization")).toBe(
      "Bearer refresh-1",
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

  it("通道失败：e2e_device_unavailable", async () => {
    const { endorser } = setup({
      channelFailure: Object.assign(new Error("x"), { code: "offline" }),
    });
    await expect(endorser.approve(request(), SAS)).rejects.toMatchObject({
      code: "e2e_device_unavailable",
    });
  });

  it("校验码不泄露：失败对象、日志、存储、控制面请求里都没有", async () => {
    const spies = (["log", "warn", "error"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    const failures: unknown[] = [];
    for (const code of ["sas_mismatch", "forbidden"]) {
      const { endorser, sources, calls } = setup({
        approve: () => ({
          status: 400,
          body: { code, message: `bad code ${SAS}` },
        }),
      });
      await endorser.approve(request(), SAS).catch((failure: unknown) => {
        failures.push(failure);
      });
      expect(JSON.stringify(sources.assertion.mock.calls)).not.toContain(SAS);
      // 只有 devices.approve 的请求体带码。
      for (const call of calls)
        if (call.path !== "/api/devices/approve")
          expect(JSON.stringify(call.body)).not.toContain(SAS);
    }
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      const e = failure as Error;
      expect(`${e.message}${e.stack}${JSON.stringify(failure)}`).not.toContain(
        SAS,
      );
    }
    for (const spy of spies)
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SAS);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SAS);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SAS);
  });
});

describe("生产背书人 · 通道与会话的生命周期", () => {
  it("空闲到点：注销会话再关通道；用着的时候不关", async () => {
    vi.useFakeTimers();
    const { endorser, close, logouts, sources } = setup();
    await endorser.approve(request(), SAS);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(close).not.toHaveBeenCalled();
    await endorser.canEndorse(SOURCE);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(logouts()).toHaveLength(1);
    expect(new Headers(logouts()[0]!.init.headers).get("authorization")).toBe(
      "Bearer refresh-1",
    );
    expect(close).toHaveBeenCalledExactlyOnceWith(ISSUER, SOURCE);
    // 关了之后再用：重新取断言，不是一直复用。
    const before = sources.assertion.mock.calls.length;
    await endorser.canEndorse(SOURCE);
    expect(sources.assertion.mock.calls.length).toBe(before + 1);
  });

  it("只判定的通道空闲关闭时没有会话可注销", async () => {
    vi.useFakeTimers();
    const { endorser, close, logouts } = setup();
    await endorser.canEndorse(SOURCE);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(close).toHaveBeenCalledExactlyOnceWith(ISSUER, SOURCE);
    expect(logouts()).toHaveLength(0);
  });

  it("同时打开不超过上限：新开一个源时关最久没用的", async () => {
    const { endorser, close } = setup({ maxOpen: 2 });
    await endorser.canEndorse("a");
    await endorser.canEndorse("b");
    expect(close).not.toHaveBeenCalled();
    await endorser.canEndorse("c");
    expect(close).toHaveBeenCalledExactlyOnceWith(ISSUER, "a");
    await endorser.canEndorse("d");
    expect(close).toHaveBeenLastCalledWith(ISSUER, "b");
  });

  it("同时进行的操作也不超过上限（信任页一次判很多行）", async () => {
    let running = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        trusted: true,
        capabilities: ["identity.cloud.probe.v1"],
      }),
    })) as unknown as typeof fetch;
    const sources = {
      assertion: vi.fn(async (input: { sourceId: string }) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return assertion(input.sourceId);
      }),
    };
    const endorser = createBrowserEndorser({
      client: { sources },
      issuer: ISSUER,
      channels: plainE2e(fetchImpl),
      maxOpen: 2,
    });
    const answers = await Promise.all(
      ["a", "b", "c", "d", "e"].map((id) => endorser.canEndorse(id)),
    );
    expect(answers).toEqual([true, true, true, true, true]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("dispose：注销全部会话、关掉所有通道，之后还能按需重开", async () => {
    const { endorser, close, logouts, sources } = setup();
    await endorser.approve(request({ sourceId: "a" }), SAS);
    await endorser.canEndorse("b");
    endorser.dispose();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(logouts()).toHaveLength(1);
    const before = sources.assertion.mock.calls.length;
    await endorser.canEndorse("a");
    expect(sources.assertion.mock.calls.length).toBeGreaterThan(before);
  });

  it("dispose 时断言还在路上：操作失败，不开通道、不发 approve", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { endorser, at, channels, close } = setup({ assertionGate: gate });
    const channel = vi.spyOn(channels, "channel");
    const pending = endorser.approve(request(), SAS);
    const outcome = pending.then(
      () => "ok",
      (failure: unknown) => (failure as { code: string }).code,
    );
    await Promise.resolve();
    endorser.dispose();
    release();
    expect(await outcome).toBe("e2e_device_unavailable");
    expect(channel).not.toHaveBeenCalled();
    expect(at("/api/devices/approve")).toHaveLength(0);
    expect(close).toHaveBeenCalledWith(ISSUER, SOURCE);
  });

  it("dispose 时登录还在路上：刚拿到的会话马上注销，approve 失败", async () => {
    let finish!: () => void;
    const hold = new Promise<void>((resolve) => (finish = resolve));
    let waiting = false;
    const { endorser, at, logouts, close } = setup({
      login: async () => {
        waiting = true;
        await hold;
        return {
          body: {
            session: {
              hostId: SOURCE,
              expiresAtUnixMs: NOW + 900_000,
              native: { accessToken: "late", refreshToken: "late-r" },
            },
          },
        };
      },
    });
    const outcome = endorser.approve(request(), SAS).then(
      () => "ok",
      (failure: unknown) => (failure as { code: string }).code,
    );
    await vi.waitFor(() => expect(waiting).toBe(true));
    endorser.dispose();
    finish();
    expect(await outcome).toBe("e2e_device_unavailable");
    expect(at("/api/devices/approve")).toHaveLength(0);
    await vi.waitFor(() => expect(logouts()).toHaveLength(1));
    expect(new Headers(logouts()[0]!.init.headers).get("authorization")).toBe(
      "Bearer late-r",
    );
    expect(close).toHaveBeenCalled();
  });
});
