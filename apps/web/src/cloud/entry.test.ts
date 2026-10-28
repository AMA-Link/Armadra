import { afterEach, describe, expect, it, vi } from "vitest";

import { PLATFORM_INFO_TIMEOUT_MS, detectConsole } from "./entry";

const here = (pathname: string) => ({ origin: "https://app.test", pathname });

function platform(info: unknown) {
  const fetch = vi.fn(
    async (_url: string) => new Response(JSON.stringify(info)),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("detectConsole", () => {
  const saas = {
    mode: "saas",
    issuer: "https://app.test",
    webApp: "https://app.test",
  };

  it("mode = saas 且 webApp 是页面来源 → 控制台路径", async () => {
    const fetch = platform(saas);
    await expect(detectConsole(here("/t/rd/hosts"))).resolves.toBe(
      "/t/rd/hosts",
    );
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://app.test/.well-known/armadra-platform",
    );
  });

  it("主机画布与分享落地页、中继托管的 /app/ 不问也不算", async () => {
    const fetch = platform(saas);
    for (const path of ["/h/abc", "/j/0123456789", "/app/", "/app"])
      await expect(detectConsole(here(path))).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("个人中转、别的来源、问不到都不是控制台", async () => {
    platform({ ...saas, mode: "personal" });
    await expect(detectConsole(here("/me"))).resolves.toBeNull();
    platform({ ...saas, webApp: "https://other.test" });
    await expect(detectConsole(here("/me"))).resolves.toBeNull();
    platform({ ...saas, webApp: null });
    await expect(detectConsole(here("/me"))).resolves.toBeNull();
    vi.stubGlobal("fetch", async () => Promise.reject(new Error("offline")));
    await expect(detectConsole(here("/me"))).resolves.toBeNull();
  });
});

describe("平台信息超时（#580）", () => {
  const saas = {
    mode: "saas",
    issuer: "https://app.test",
    webApp: "https://app.test",
  };
  /** 一直不答，直到被调用方的超时中止。 */
  const hang = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      ),
    );

  afterEach(() => vi.useRealTimers());

  it("第一次超时再问一次，第二次答了 saas 就是控制台", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) =>
      (n += 1) === 1 ? hang(url, init) : new Response(JSON.stringify(saas)),
    );
    vi.stubGlobal("fetch", fetch);
    const answer = detectConsole(here("/login"));
    await vi.advanceTimersByTimeAsync(PLATFORM_INFO_TIMEOUT_MS);
    await expect(answer).resolves.toBe("/login");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("两次都超时才落服务器壳；404、HTML、连不上只问一次", async () => {
    vi.useFakeTimers();
    const slow = vi.fn(hang);
    vi.stubGlobal("fetch", slow);
    const answer = detectConsole(here("/login"));
    await vi.advanceTimersByTimeAsync(PLATFORM_INFO_TIMEOUT_MS * 2);
    await expect(answer).resolves.toBeNull();
    expect(slow).toHaveBeenCalledTimes(2);
    vi.useRealTimers();

    for (const reply of [
      async () => new Response("not found", { status: 404 }),
      async () => new Response("<!doctype html>"),
      async () => Promise.reject(new TypeError("Failed to fetch")),
    ]) {
      const fetch = vi.fn(reply);
      vi.stubGlobal("fetch", fetch);
      await expect(detectConsole(here("/login"))).resolves.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});
