import { afterEach, describe, expect, it, vi } from "vitest";

import { detectConsole } from "./entry";

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
