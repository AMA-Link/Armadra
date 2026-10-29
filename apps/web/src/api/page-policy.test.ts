import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VIOLATION_RELOAD_GAP_MS,
  VIOLATION_RELOAD_KEY,
  pagePolicyGrew,
  rememberPagePolicy,
  resetPagePolicy,
  watchPolicyViolations,
} from "./page-policy";

const answer = (connect: string) =>
  new Response(null, {
    headers: {
      "content-security-policy": `default-src 'self'; connect-src ${connect}; img-src 'self'`,
    },
  });

afterEach(() => resetPagePolicy());

describe("服务器壳页面的 CSP 跟着源表走（契约 §88.1）", () => {
  it("源表多出来源：要重载；没多（或少了）不重载", async () => {
    const fetcher = vi.fn(async () => answer("'self' https://app.example"));
    rememberPagePolicy(fetcher);
    expect(await pagePolicyGrew(fetcher)).toBe(false);
    fetcher.mockImplementation(async () => answer("'self'"));
    expect(await pagePolicyGrew(fetcher)).toBe(false);
    fetcher.mockImplementation(async () =>
      answer(
        "'self' https://app.example https://h.src.example wss://h.src.example",
      ),
    );
    expect(await pagePolicyGrew(fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "/",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("启动时没记下（不是服务器壳）或读不到：不重载", async () => {
    const fetcher = vi.fn(async () => answer("'self' https://x.example"));
    expect(await pagePolicyGrew(fetcher)).toBe(false);
    rememberPagePolicy(async () => {
      throw new TypeError("offline");
    });
    expect(await pagePolicyGrew(fetcher)).toBe(false);
  });
});

describe("connect-src 拦了源表里的来源：确认新授权覆盖它才整页重载一次（契约 §88.1）", () => {
  const violation = (blockedURI: string, directive = "connect-src") =>
    Object.assign(new Event("securitypolicyviolation"), {
      blockedURI,
      effectiveDirective: directive,
    });
  const memory = () => {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
  };
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const owner = vi.fn(async () =>
    answer("'self' https://127.0.0.1:19580 wss://h.src.example"),
  );

  it("只对源表里的来源、只重载一次；记号在间隔内不再重载，不循环", async () => {
    const target = new EventTarget();
    const storage = memory();
    let clock = 1_000_000;
    const reload = vi.fn();
    const watch = () =>
      watchPolicyViolations({
        knownOrigins: () => [
          "https://127.0.0.1:19580",
          "https://h.src.example",
        ],
        reload,
        notify: () => {},
        fetch: owner,
        storage,
        now: () => clock,
        target,
      });
    let stop = watch();
    target.dispatchEvent(violation("https://evil.example/x"));
    target.dispatchEvent(violation("https://127.0.0.1:19580/x", "img-src"));
    await settle();
    expect(reload).not.toHaveBeenCalled();
    target.dispatchEvent(violation("https://127.0.0.1:19580/api/rpc/x"));
    target.dispatchEvent(violation("wss://h.src.example/_relay/e2e"));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    // 重载后的页面（新的监听）仍被拦：间隔内不再重载。
    stop();
    stop = watch();
    clock += 60_000;
    target.dispatchEvent(violation("https://127.0.0.1:19580/api/rpc/x"));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    // 过了间隔才可能再来一次。
    stop();
    stop = watch();
    clock += VIOLATION_RELOAD_GAP_MS;
    target.dispatchEvent(violation("https://127.0.0.1:19580/api/rpc/x"));
    await settle();
    expect(reload).toHaveBeenCalledTimes(2);
    stop();
  });

  it("新的授权里也没有被拦的主机：只提示，不重载，不写记号", async () => {
    const target = new EventTarget();
    const storage = memory();
    const reload = vi.fn();
    const notify = vi.fn();
    const stop = watchPolicyViolations({
      knownOrigins: () => ["https://127.0.0.1:19580"],
      reload,
      notify,
      fetch: vi.fn(async () => answer("'self' https://app.example")),
      storage,
      target,
    });
    target.dispatchEvent(violation("https://127.0.0.1:19580/api/rpc/x"));
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("127.0.0.1:19580");
    expect(storage.getItem(VIOLATION_RELOAD_KEY)).toBeNull();
    stop();
  });

  it("sessionStorage 不可用（为空或读写抛错）：不重载", async () => {
    for (const storage of [
      null,
      {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {},
      },
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      },
    ]) {
      const target = new EventTarget();
      const reload = vi.fn();
      const stop = watchPolicyViolations({
        knownOrigins: () => ["https://127.0.0.1:19580"],
        reload,
        notify: () => {},
        fetch: owner,
        storage,
        target,
      });
      target.dispatchEvent(violation("https://127.0.0.1:19580/api/rpc/x"));
      await settle();
      expect(reload).not.toHaveBeenCalled();
      stop();
    }
  });
});
