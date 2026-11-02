import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  nativeShell: false,
  ticket: vi.fn(async () => "shell-ticket"),
  revokeSession: vi.fn(async (_sessionId: string) => undefined),
}));

vi.mock("./security", () => ({
  revokeSession: (sessionId: string) => mocks.revokeSession(sessionId),
}));

vi.mock("../host/native-session", async (original) => {
  const actual = await original<typeof import("../host/native-session")>();
  return {
    ...actual,
    isNativeShell: () => mocks.nativeShell,
    fetchNativeTicket: () => mocks.ticket(),
  };
});

import {
  ensureCsrf,
  forgetCsrf,
  currentCsrf,
  identityHello,
  identityRequest,
  identitySessionSchema,
  IdentityRequestError,
  IdentityTransportError,
  logoutIdentity,
  onIdentitySessionChange,
  pairIdentity,
  permits,
  refreshIdentity,
  rememberCsrf,
  replaceRejectedCsrf,
  resetIdentityCredentials,
  resumeIdentity,
  shellBearer,
  takePairingTicket,
} from "./identity";

const SECRET = "a".repeat(43);

type Call = { url: string; init: RequestInit };
let calls: Call[];
let answer: (call: Call) => { status?: number; body: unknown };

function fetchStub() {
  return vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const { status = 200, body } = answer(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  });
}

const session = {
  hostId: "h1",
  device: {
    deviceId: "d1",
    principalId: "p1",
    displayName: "Laptop",
    role: "owner",
    createdAtUnixMs: 1,
    revision: 2,
  },
  scopes: [
    { permission: "identity:read", workspaceId: "", executionHostId: "" },
  ],
  expiresAtUnixMs: 10,
  csrfToken: SECRET,
};

/** 默认按路径回答，和 core 的 JSON 面一一对上。 */
function defaultAnswer(call: Call): { status?: number; body: unknown } {
  if (call.url.includes("devices/revoke"))
    return { body: { deviceId: "d2", revoked: true } };
  if (call.url.includes("/devices"))
    return { body: { devices: [], nextId: "", hasMore: false } };
  if (call.url.includes("session/logout")) return { body: { closed: true } };
  if (call.url.includes("session/csrf")) return { body: { csrfToken: SECRET } };
  return { body: session };
}

beforeEach(() => {
  calls = [];
  answer = defaultAnswer;
  mocks.nativeShell = false;
  mocks.ticket.mockReset().mockResolvedValue("shell-ticket");
  mocks.revokeSession.mockReset().mockResolvedValue(undefined);
  resetIdentityCredentials();
  vi.stubGlobal("fetch", fetchStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetIdentityCredentials();
});

describe("the identity JSON surface", () => {
  it("parses a session and keeps the secrets out of the parsed shape", () => {
    const parsed = identitySessionSchema.parse({
      hostId: "h1",
      device: { deviceId: "d1" },
      expiresAtUnixMs: 5,
    });
    expect(parsed.device.displayName).toBe("");
    expect(parsed.scopes).toEqual([]);
    expect(parsed.native).toBeUndefined();
  });

  /** 一份少了 `hostId` 的回答不是一份「大概能用」的会话，是一份解不出的回答。 */
  it("refuses an answer that is not a session", () => {
    expect(() =>
      identitySessionSchema.parse({ device: { deviceId: "d1" } }),
    ).toThrow();
  });

  it("asks hello without credentials", async () => {
    answer = () => ({
      body: { hostId: "h1", hostInstanceId: "i1", capabilities: ["a"] },
    });
    const hello = await identityHello();
    expect(hello.capabilities).toEqual(["a"]);
    expect(calls[0]?.url).toContain("/api/identity/hello");
    expect(
      (calls[0]?.init.headers as Record<string, string>).Authorization,
    ).toBe(undefined);
  });

  it("turns a refusal into a code, and a dead socket into a different failure", async () => {
    answer = () => ({
      status: 403,
      body: { code: "PERMISSION_DENIED", message: "no" },
    });
    await expect(identityHello()).rejects.toBeInstanceOf(IdentityRequestError);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection refused");
      }),
    );
    await expect(identityHello()).rejects.toBeInstanceOf(
      IdentityTransportError,
    );
  });
});

describe("the browser (server shell) transport", () => {
  it("sends cookies and the double-submit header on writes", async () => {
    await pairIdentity("ticket");
    expect(calls[0]?.init.credentials).toBe("include");
    expect(currentCsrf()).toBe(SECRET);

    // 旧路径上的写（procedure 那一面见 `security.test.ts`）。
    await identityRequest("devices/revoke", z.unknown(), {
      method: "POST",
      body: { deviceId: "d2", expectedRevision: 3 },
    });
    const headers = calls[1]?.init.headers as Record<string, string>;
    expect(headers["X-Armadra-CSRF"]).toBe(SECRET);
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({
      deviceId: "d2",
      expectedRevision: 3,
    });
  });

  /**
   * 刷新页面之后内存里什么都没有，但 refresh Cookie 还在：换一枚，而不是
   * 让此后每一次写请求都撞上 403。
   */
  it("renews a token it does not have, once", async () => {
    answer = () => ({ body: { csrfToken: SECRET } });
    const [first, second] = await Promise.all([ensureCsrf(), ensureCsrf()]);
    expect(first).toBe(SECRET);
    expect(second).toBe(SECRET);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/identity/session/csrf");
  });

  /**
   * 背后没有会话（或者不是 core，#581）：换不来时不让每个写请求都打一次
   * `session/csrf`。1 秒起翻倍、封顶 30 秒；拿到一枚（登录、注册）就归零。
   */
  it("backs off renewing after a failure, with a ceiling", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      answer = () => ({ status: 404, body: { code: "not_found" } });
      for (let i = 0; i < 50; i += 1) expect(await ensureCsrf()).toBe("");
      expect(calls).toHaveLength(1);
      vi.advanceTimersByTime(999);
      await ensureCsrf();
      expect(calls).toHaveLength(1);
      vi.advanceTimersByTime(1);
      await ensureCsrf();
      expect(calls).toHaveLength(2);
      // 一分钟里一直在要：次数有上界（1+2+4+8+16+30 秒……），不是每次都发。
      for (let second = 0; second < 60; second += 1) {
        vi.advanceTimersByTime(1_000);
        for (let i = 0; i < 20; i += 1) await ensureCsrf();
      }
      expect(calls.length).toBeLessThanOrEqual(8);
      // 拿到一枚（登录答的）就不再退避：作废后立刻能换。
      answer = defaultAnswer;
      rememberCsrf(SECRET);
      forgetCsrf();
      const before = calls.length;
      expect(await ensureCsrf()).toBe(SECRET);
      expect(calls).toHaveLength(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 网络抖动、core 正在重启（5xx）不是「没有会话」：不退避，马上再换就续得上，
   * 请求层不会把一次能续上的 401 交出去。
   */
  it("does not back off after a network error or a 5xx", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          throw new TypeError("Failed to fetch");
        }),
      );
      expect(await ensureCsrf()).toBe("");
      answer = () => ({ status: 503, body: { code: "unavailable" } });
      vi.stubGlobal("fetch", fetchStub());
      expect(await ensureCsrf()).toBe("");
      answer = defaultAnswer;
      // 同一毫秒里再要：直接换，换得上。
      expect(await ensureCsrf()).toBe(SECRET);
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 注册前页面一直在轮询 `session/csrf`（401）。会话一建好，在途的那条带着新
   * Cookie 落地，就把注册刚答出来的令牌作废。此时发出的第一批请求不能拿着
   * 注册的那一枚去赌：等换票落地，用换回来的（AMA-Link/Armadra#355）。
   */
  it("waits for a renewal in flight before handing out the token it supersedes", async () => {
    const NEWER = "n".repeat(43);
    let land!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Promise<Response>((resolve) => (land = resolve));
      }),
    );
    const inFlight = ensureCsrf();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // 注册的答复在换票落地之前到了。
    rememberCsrf(SECRET);
    let handed: string | undefined;
    const first = ensureCsrf().then((token) => (handed = token));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handed).toBeUndefined();
    land({
      ok: true,
      status: 200,
      json: async () => ({ csrfToken: NEWER }),
    } as unknown as Response);
    await inFlight;
    await first;
    expect(handed).toBe(NEWER);
    expect(currentCsrf()).toBe(NEWER);
    expect(calls).toHaveLength(1);
  });

  it("keeps the token it has when the renewal in flight is refused", async () => {
    let land!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Promise<Response>((resolve) => (land = resolve));
      }),
    );
    const inFlight = ensureCsrf();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    rememberCsrf(SECRET);
    const first = ensureCsrf();
    land({
      ok: false,
      status: 401,
      json: async () => ({ code: "UNAUTHENTICATED" }),
    } as unknown as Response);
    await inFlight;
    expect(await first).toBe(SECRET);
    expect(calls).toHaveLength(1);
  });

  it("forgets a rotated token so the next write fetches a new one", async () => {
    await pairIdentity("ticket");
    forgetCsrf();
    expect(currentCsrf()).toBe("");
  });

  it("announces a session change exactly once per change", async () => {
    const seen = vi.fn();
    const stop = onIdentitySessionChange(seen);
    await pairIdentity("ticket");
    expect(seen).toHaveBeenCalledTimes(1);
    await pairIdentity("ticket");
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    await logoutIdentity();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("reads a signed-out browser as no session rather than an error", async () => {
    answer = (call) =>
      call.url.includes("session/refresh")
        ? { status: 401, body: { code: "UNAUTHENTICATED" } }
        : { status: 401, body: { code: "UNAUTHENTICATED" } };
    expect(await resumeIdentity()).toBeNull();
  });
});

describe("the desktop shell transport", () => {
  beforeEach(() => {
    mocks.nativeShell = true;
  });

  /** 壳里没有 Cookie 可带；票换来的密钥只在内存里，经 Bearer 送出去。 */
  it("pairs with a shell ticket and then carries a bearer, never a cookie", async () => {
    answer = (call) =>
      call.url.includes("/pair")
        ? {
            body: {
              ...session,
              csrfToken: "",
              native: { accessToken: "A", refreshToken: "R" },
            },
          }
        : defaultAnswer(call);
    const resumed = await resumeIdentity();
    expect(resumed?.hostId).toBe("h1");
    expect(mocks.ticket).toHaveBeenCalledTimes(1);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      ticket: "shell-ticket",
    });
    expect(calls[0]?.init.credentials).toBe("omit");

    await identityRequest("devices", z.unknown());
    const headers = calls[1]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer A");
    expect(headers["X-Armadra-CSRF"]).toBe(undefined);
  });

  /** 访问密钥与刷新密钥都过期后，壳还能签票：重新配对，不停在「已断开」。 */
  it("re-pairs with a fresh shell ticket once both keys have expired", async () => {
    answer = (call) =>
      call.url.includes("/pair")
        ? {
            body: {
              ...session,
              csrfToken: "",
              native: { accessToken: "A2", refreshToken: "R2" },
            },
          }
        : call.url.includes("/session")
          ? { status: 401, body: { code: "UNAUTHENTICATED", message: "" } }
          : defaultAnswer(call);
    await resumeIdentity(); // first pairing
    const resumed = await resumeIdentity(); // session + refresh both 401
    expect(resumed?.hostId).toBe("h1");
    expect(mocks.ticket).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.url.split("/api/identity/")[1])).toEqual([
      "pair",
      "session",
      "session/refresh",
      "pair",
    ]);
  });
});

/**
 * 桌面壳里一份像真 core 那样的会话（#706）：配对与刷新都答 CSRF 密钥，令牌带
 * `<sessionId>.` 前缀，访问期 15 分钟。`rotation` 是第几次轮转。
 */
function shellSession(sessionId: string, rotation: number, now: number) {
  return {
    ...session,
    csrfToken: SECRET,
    expiresAtUnixMs: now + 15 * 60 * 1000,
    native: {
      accessToken: `${sessionId}.access-${rotation}`,
      refreshToken: `${sessionId}.refresh-${rotation}`,
    },
  };
}

function paths(): string[] {
  return calls.map((c) => c.url.split("/api/identity/")[1] ?? c.url);
}

describe("the desktop shell keeps one session (#706)", () => {
  let rotation = 0;
  let live = "";
  let expires = 0;

  beforeEach(() => {
    mocks.nativeShell = true;
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    rotation = 0;
    live = "";
    expires = 0;
    // 一个小 core：刷新只认手里最新的那把刷新密钥，用过的再来就是重放。
    answer = (call) => {
      const path = call.url.split("/api/identity/")[1];
      const headers = call.init.headers as Record<string, string>;
      const bearer = headers.Authorization?.slice("Bearer ".length) ?? "";
      if (path === "pair") {
        live = live === "" ? "s1" : `s${Number(live.slice(1)) + 1}`;
        rotation = 1;
        expires = Date.now() + 15 * 60 * 1000;
        return { body: shellSession(live, rotation, Date.now()) };
      }
      if (path === "session/refresh") {
        if (bearer !== `${live}.refresh-${rotation}`)
          return { status: 401, body: { code: "UNAUTHENTICATED" } };
        rotation += 1;
        expires = Date.now() + 15 * 60 * 1000;
        return { body: shellSession(live, rotation, Date.now()) };
      }
      if (path === "session") {
        return bearer === `${live}.access-${rotation}` && Date.now() < expires
          ? { body: shellSession(live, rotation, Date.now()) }
          : { status: 401, body: { code: "UNAUTHENTICATED" } };
      }
      return defaultAnswer(call);
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rotates ahead of every expiry on the session it paired, without the CSRF header", async () => {
    await resumeIdentity();
    for (let period = 0; period < 3; period += 1) {
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
    }
    expect(mocks.ticket).toHaveBeenCalledTimes(1);
    expect(paths()).toEqual([
      "pair",
      "session/refresh",
      "session/refresh",
      "session/refresh",
    ]);
    // 页面与 core 不同端口：多一个非安全名单的头就多一道预检，旧 core 不放行它。
    for (const call of calls.slice(1)) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers["X-Armadra-CSRF"]).toBeUndefined();
      expect(headers.Authorization).toMatch(/^Bearer s1\.refresh-/);
    }
    expect(live).toBe("s1");
  });

  it("refreshes rather than pairs when the timer fires after the access period (sleep)", async () => {
    await resumeIdentity();
    // 合盖睡过了访问期：计时器没跑，墙钟已经越过到期时刻。
    vi.setSystemTime(Date.now() + 40 * 60 * 1000);
    const access = await shellBearer();
    expect(access).toBe("s1.access-2");
    expect(paths()).toEqual(["pair", "session/refresh"]);
    expect(mocks.ticket).toHaveBeenCalledTimes(1);
  });

  it("shares one refresh between panels that find the access key expired at once", async () => {
    await resumeIdentity();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const [a, b, c] = await Promise.all([
      resumeIdentity(),
      resumeIdentity(),
      resumeIdentity(),
    ]);
    expect([a, b, c].every((each) => each?.hostId === "h1")).toBe(true);
    expect(paths().filter((path) => path === "session/refresh")).toHaveLength(
      1,
    );
    expect(paths().filter((path) => path === "pair")).toHaveLength(1);
    expect(mocks.ticket).toHaveBeenCalledTimes(1);
  });

  it("asks again with the new key when a rotation lands while the check was in flight", async () => {
    await resumeIdentity();
    // 先一次刷新换掉密钥；再让一次带着旧密钥的复核落地。
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    const original = answer;
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const call = { url, init };
        calls.push(call);
        if (first && url.endsWith("/api/identity/session")) {
          first = false;
          const reply = original(call);
          await gate;
          return {
            ok: false,
            status: 401,
            json: async () => ({ code: "UNAUTHENTICATED", reply }),
          } as unknown as Response;
        }
        const { status = 200, body } = original(call);
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
        } as unknown as Response;
      }),
    );
    const checking = resumeIdentity();
    await refreshIdentity();
    release();
    expect((await checking)?.hostId).toBe("h1");
    expect(paths()).toEqual(["pair", "session", "session/refresh", "session"]);
    expect(mocks.ticket).toHaveBeenCalledTimes(1);
  });

  it("keeps the session through a refresh that never reached the core", async () => {
    await resumeIdentity();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const original = answer;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.includes("session/refresh")) throw new TypeError("offline");
        const { status = 200, body } = original({ url, init });
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
        } as unknown as Response;
      }),
    );
    await expect(resumeIdentity()).rejects.toBeInstanceOf(
      IdentityTransportError,
    );
    expect(mocks.ticket).toHaveBeenCalledTimes(1);
    expect(paths().filter((path) => path === "pair")).toHaveLength(1);
  });

  it("revokes the session it abandons when it has to pair again", async () => {
    await resumeIdentity();
    // 刷新密钥被拒（别处把会话撤了，或换来的新密钥半路丢了）。
    rotation = 99;
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const resumed = await resumeIdentity();
    expect(resumed?.hostId).toBe("h1");
    expect(mocks.ticket).toHaveBeenCalledTimes(2);
    expect(live).toBe("s2");
    await vi.waitFor(() =>
      expect(mocks.revokeSession).toHaveBeenCalledWith("s1"),
    );
    expect(mocks.revokeSession).toHaveBeenCalledTimes(1);
  });
});

describe("permits", () => {
  const granted = {
    ...session,
    scopes: [
      { permission: "updates:read", workspaceId: "", executionHostId: "" },
      { permission: "canvas:write", workspaceId: "w1", executionHostId: "" },
    ],
  };

  /** 一条限定工作空间的授权不覆盖「整台机器」那一问。 */
  it("does not let a workspace grant answer a host-wide question", () => {
    expect(permits(granted, "updates:read")).toBe(true);
    expect(permits(granted, "canvas:write")).toBe(false);
    expect(permits(granted, "canvas:write", { workspaceId: "w1" })).toBe(true);
    expect(permits(granted, "canvas:write", { workspaceId: "w2" })).toBe(false);
  });
});

describe("takePairingTicket", () => {
  it("takes the fragment once and wipes it from the address bar", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("location", {
      hash: "#pair=abc-123",
      pathname: "/",
      search: "",
    });
    vi.stubGlobal("history", { replaceState });
    expect(takePairingTicket()).toBe("abc-123");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("accepts the gateway's trailing fingerprint and drops it", () => {
    vi.stubGlobal("location", {
      hash: `#pair=abc-123&fp=${"ab".repeat(32)}`,
      pathname: "/",
      search: "",
    });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    expect(takePairingTicket()).toBe("abc-123");
  });

  it("ignores anything that is not a pairing fragment", () => {
    vi.stubGlobal("location", { hash: "#settings", pathname: "/", search: "" });
    expect(takePairingTicket()).toBe("");
  });
});

/**
 * 同一浏览器的几个窗口共用一条会话、一枚 CSRF：各换各的就是互相作废，两边
 * 同时换时「403 → 换一枚 → 重发」也救不回来（server-e2e 同机第二个窗口偶发
 * 停在空白画布上）。换来的新令牌经 BroadcastChannel 告诉其它窗口。
 */
describe("windows of one browser sharing a session", () => {
  const OTHER = "b".repeat(43);
  const NEWER = "c".repeat(43);
  let other: BroadcastChannel;
  let heard: unknown[];

  beforeEach(() => {
    heard = [];
    other = new BroadcastChannel("armadra.identity.csrf");
    other.onmessage = (event) => heard.push(event.data);
  });
  afterEach(() => other.close());

  /** 消息是异步投递的：等它到。 */
  const delivered = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(check()).toBe(true);
  };

  it("tells the other windows about a token it renewed", async () => {
    await ensureCsrf();
    await delivered(() => heard.length > 0);
    expect(heard).toEqual([{ csrf: SECRET }]);
  });

  it("uses a token another window renewed instead of renewing its own", async () => {
    other.postMessage({ csrf: OTHER });
    await delivered(() => currentCsrf() === OTHER);
    expect(await ensureCsrf()).toBe(OTHER);
    expect(calls).toHaveLength(0);
    // 别人告诉的不再往外转。
    expect(heard).toEqual([]);
  });

  it("ignores a message that is not a token", async () => {
    rememberCsrf(SECRET);
    other.postMessage({ csrf: "short" });
    other.postMessage("nonsense");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(currentCsrf()).toBe(SECRET);
  });

  it("retries a rejected write with the token another window already rotated to", async () => {
    rememberCsrf(SECRET);
    other.postMessage({ csrf: NEWER });
    await delivered(() => currentCsrf() === NEWER);
    expect(await replaceRejectedCsrf(SECRET)).toBe(NEWER);
    expect(calls).toHaveLength(0);
  });

  it("renews when the rejected token is still the one it holds", async () => {
    rememberCsrf(OTHER);
    expect(await replaceRejectedCsrf(OTHER)).toBe(SECRET);
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining("/api/identity/session/csrf"),
    ]);
  });

  /**
   * 同一个窗口里几次写带着同一枚旧令牌一起被拒：只换一次。以前每一次 403 都
   * 作废手里的再换，后到的那次把先到的刚换来、正要拿去重发的那枚又作废了。
   */
  it("renews once for several writes rejected with the same token", async () => {
    rememberCsrf(OTHER);
    const [first, second] = await Promise.all([
      replaceRejectedCsrf(OTHER),
      replaceRejectedCsrf(OTHER),
    ]);
    expect(first).toBe(SECRET);
    expect(second).toBe(SECRET);
    // 来得晚的那次 403 也不再换。
    expect(await replaceRejectedCsrf(OTHER)).toBe(SECRET);
    expect(calls).toHaveLength(1);
  });

  /** ui-acp-refresh §7.3 E-2：刚因 403 丢掉一枚，再采用别的窗口换来的，是换票不是新会话。 */
  it("treats a token adopted after forgetting one as a rotation", async () => {
    const seen = vi.fn();
    rememberCsrf(SECRET);
    const stop = onIdentitySessionChange(seen);
    forgetCsrf(SECRET);
    other.postMessage({ csrf: NEWER });
    await delivered(() => currentCsrf() === NEWER);
    expect(seen.mock.calls).toEqual([["rotated"]]);
    stop();
  });

  /** Bearer 传输里每个窗口各有自己的会话：不广播，也不采用别人的。 */
  it("leaves the Bearer transport out of the sharing", async () => {
    mocks.nativeShell = true;
    rememberCsrf(SECRET);
    other.postMessage({ csrf: OTHER });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(currentCsrf()).toBe(SECRET);
    expect(heard).toEqual([]);
  });

  it("forgets only the token that was rejected", () => {
    rememberCsrf(NEWER);
    forgetCsrf(SECRET);
    expect(currentCsrf()).toBe(NEWER);
    forgetCsrf(NEWER);
    expect(currentCsrf()).toBe("");
  });

  /** 等锁的窗口拿到锁时，别的窗口已经换好了：直接用，不再换第二次。 */
  it("checks again under the renew lock before renewing", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("navigator", {
      locks: {
        request: (_name: string, task: () => Promise<unknown>) =>
          held.then(task),
      },
    });
    const pending = ensureCsrf();
    other.postMessage({ csrf: OTHER });
    await delivered(() => currentCsrf() === OTHER);
    release();
    expect(await pending).toBe(OTHER);
    expect(calls).toHaveLength(0);
  });
});

describe("identityRequest on a cookie session", () => {
  /** 令牌被别处换掉时 403：换一枚重发一次；再 403 照实报。 */
  it("retries a rotated CSRF token exactly once", async () => {
    rememberCsrf(SECRET);
    const fresh = "c".repeat(43);
    let writes = 0;
    answer = (call) => {
      if (call.url.includes("session/csrf"))
        return { body: { csrfToken: fresh } };
      writes += 1;
      return writes === 1
        ? { status: 403, body: { code: "PERMISSION_DENIED", message: "" } }
        : { body: { ok: true } };
    };
    const { z } = await import("zod");
    await expect(
      identityRequest("groups", z.object({ ok: z.boolean() }), {
        method: "POST",
        body: { name: "x" },
      }),
    ).resolves.toEqual({ ok: true });
    const sent = calls
      .filter((call) => call.url.endsWith("/groups"))
      .map(
        (call) =>
          (call.init.headers as Record<string, string>)["X-Armadra-CSRF"],
      );
    expect(sent).toEqual([SECRET, fresh]);

    writes = 0;
    answer = (call) =>
      call.url.includes("session/csrf")
        ? { body: { csrfToken: "d".repeat(43) } }
        : { status: 403, body: { code: "PERMISSION_DENIED", message: "" } };
    await expect(
      identityRequest("groups", z.object({ ok: z.boolean() }), {
        method: "POST",
        body: { name: "x" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

/** ui-acp-refresh §7.3 E-2：通知分级，只有会话出现 / 消失 / 换人才是会话变化。 */
describe("what kind of session change is announced", () => {
  it("calls a pairing an appearance and a refresh of it a rotation", async () => {
    const seen = vi.fn();
    const stop = onIdentitySessionChange(seen);
    await pairIdentity("ticket");
    // 刷新换了 CSRF：同一条会话。
    answer = (call) =>
      call.url.includes("session/refresh")
        ? { body: { ...session, csrfToken: "r".repeat(43) } }
        : defaultAnswer(call);
    await refreshIdentity();
    rememberCsrf("s".repeat(43));
    expect(seen.mock.calls).toEqual([["appeared"], ["rotated"], ["rotated"]]);
    stop();
  });

  it("calls a bearer renewal of the same device a rotation", async () => {
    mocks.nativeShell = true;
    const seen = vi.fn();
    const stop = onIdentitySessionChange(seen);
    const bearer = (access: string) => ({
      body: {
        ...session,
        csrfToken: "",
        native: { accessToken: access, refreshToken: "R" },
      },
    });
    answer = (call) =>
      call.url.includes("/pair") ? bearer("A") : bearer("A2");
    await pairIdentity("ticket");
    await refreshIdentity();
    expect(seen.mock.calls).toEqual([["appeared"], ["rotated"]]);
    stop();
  });

  it("calls another person's session a switch, and a logout gone", async () => {
    const seen = vi.fn();
    const stop = onIdentitySessionChange(seen);
    await pairIdentity("ticket");
    answer = (call) =>
      call.url.includes("/pair")
        ? {
            body: {
              ...session,
              device: { ...session.device, principalId: "p2" },
            },
          }
        : defaultAnswer(call);
    await pairIdentity("ticket");
    await logoutIdentity();
    expect(seen.mock.calls).toEqual([["appeared"], ["switched"], ["gone"]]);
    stop();
  });
});
