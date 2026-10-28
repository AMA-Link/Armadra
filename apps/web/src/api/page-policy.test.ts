import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VIOLATION_RELOAD_GAP_MS,
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

describe("connect-src 拦了源表里的来源：整页重载一次（契约 §88.1）", () => {
  const violation = (blockedURI: string, directive = "connect-src") =>
    Object.assign(new Event("securitypolicyviolation"), {
      blockedURI,
      effectiveDirective: directive,
    });

  it("只对源表里的来源、只重载一次；记号在间隔内不再重载，不循环", () => {
    const target = new EventTarget();
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    let clock = 1_000_000;
    const reload = vi.fn();
    const watch = () =>
      watchPolicyViolations({
        knownOrigins: () => [
          "https://127.0.0.1:19580",
          "https://h.src.example",
        ],
        reload,
        storage,
        now: () => clock,
        target,
      });
    let stop = watch();
    target.dispatchEvent(violation("https://evil.example/x"));
    target.dispatchEvent(violation("https://127.0.0.1:19580/x", "img-src"));
    expect(reload).not.toHaveBeenCalled();
    target.dispatchEvent(violation("https://127.0.0.1:19580/api/rpc/x"));
    target.dispatchEvent(violation("wss://h.src.example/_relay/e2e"));
    expect(reload).toHaveBeenCalledTimes(1);
    // 重载后的页面（新的监听）仍被拦：间隔内不再重载。
    stop();
    stop = watch();
    clock += 60_000;
    target.dispatchEvent(violation("https://127.0.0.1:19580/api/rpc/x"));
    expect(reload).toHaveBeenCalledTimes(1);
    // 过了间隔才可能再来一次。
    stop();
    stop = watch();
    clock += VIOLATION_RELOAD_GAP_MS;
    target.dispatchEvent(violation("https://127.0.0.1:19580/api/rpc/x"));
    expect(reload).toHaveBeenCalledTimes(2);
    stop();
  });
});
