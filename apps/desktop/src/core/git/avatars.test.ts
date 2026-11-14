import { afterEach, describe, expect, it, vi } from "vitest";

import { avatars, resetAvatarCache } from "./avatars";

afterEach(resetAvatarCache);

const png = (bytes = 8) =>
  new Response(new Uint8Array(bytes).fill(1), {
    status: 200,
    headers: { "content-type": "image/png" },
  });

describe("GitHub 头像代理（#927）", () => {
  it("按 id 取 64px 头像，答 data URL", async () => {
    const fetcher = vi.fn(async () => png());
    const result = await avatars([42], {
      fetch: fetcher as unknown as typeof fetch,
      enabled: () => true,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://avatars.githubusercontent.com/u/42?s=64&v=4",
      expect.anything(),
    );
    expect(result.avatars[0]!.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("开关关掉时一个请求都不发", async () => {
    const fetcher = vi.fn(async () => png());
    const result = await avatars([1, 2], {
      fetch: fetcher as unknown as typeof fetch,
      enabled: () => false,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.avatars).toEqual([
      { id: 1, dataUrl: null },
      { id: 2, dataUrl: null },
    ]);
  });

  it("同一个 id 只问一次：缓存与在飞请求都共用", async () => {
    const fetcher = vi.fn(async () => png());
    const deps = {
      fetch: fetcher as unknown as typeof fetch,
      enabled: () => true,
    };
    await Promise.all([avatars([7, 7], deps), avatars([7], deps)]);
    await avatars([7], deps);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("不是位图、太大或失败都答 null，失败也缓存", async () => {
    const svg = vi.fn(
      async () =>
        new Response("<svg/>", {
          headers: { "content-type": "image/svg+xml" },
        }),
    );
    expect(
      (
        await avatars([3], {
          fetch: svg as unknown as typeof fetch,
          enabled: () => true,
        })
      ).avatars[0]!.dataUrl,
    ).toBeNull();
    const big = vi.fn(async () => png(70 * 1024));
    expect(
      (
        await avatars([4], {
          fetch: big as unknown as typeof fetch,
          enabled: () => true,
        })
      ).avatars[0]!.dataUrl,
    ).toBeNull();
    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    const deps = {
      fetch: down as unknown as typeof fetch,
      enabled: () => true,
    };
    expect((await avatars([5], deps)).avatars[0]!.dataUrl).toBeNull();
    await avatars([5], deps);
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("丢掉不是正整数的 id", async () => {
    const fetcher = vi.fn(async () => png());
    const result = await avatars([0, -1, 1.5, 9], {
      fetch: fetcher as unknown as typeof fetch,
      enabled: () => true,
    });
    expect(result.avatars.map((entry) => entry.id)).toEqual([9]);
  });
});
