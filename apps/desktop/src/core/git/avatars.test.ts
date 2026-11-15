import { afterEach, describe, expect, it, vi } from "vitest";

import { mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { avatars, configureAvatarCache, resetAvatarCache } from "./avatars";

afterEach(() => {
  resetAvatarCache();
  configureAvatarCache(undefined);
});

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

  describe("落盘（#942）", () => {
    const fresh = () => {
      const directory = mkdtempSync(join(tmpdir(), "armadra-avatars-"));
      configureAvatarCache(directory);
      return directory;
    };

    it("重启后（内存清空）从磁盘命中，不再请求", async () => {
      const directory = fresh();
      const fetcher = vi.fn(async () => png());
      const deps = {
        fetch: fetcher as unknown as typeof fetch,
        enabled: () => true,
      };
      const first = await avatars([9], deps);
      expect(readFileSync(join(directory, "9"), "utf8")).toBe(
        first.avatars[0]!.dataUrl,
      );
      resetAvatarCache();
      const second = await avatars([9], deps);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(second.avatars[0]!.dataUrl).toBe(first.avatars[0]!.dataUrl);
      rmSync(directory, { recursive: true, force: true });
    });

    it("过期后重取；取不到就继续用旧图", async () => {
      const directory = fresh();
      const ok = vi.fn(async () => png());
      const deps = {
        fetch: ok as unknown as typeof fetch,
        enabled: () => true,
      };
      const original = (await avatars([11], deps)).avatars[0]!.dataUrl;
      // 文件改成八天前写的。
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      utimesSync(join(directory, "11"), old, old);
      resetAvatarCache();
      const offline = vi.fn(async () => {
        throw new Error("offline");
      });
      const answer = await avatars([11], {
        fetch: offline as unknown as typeof fetch,
        enabled: () => true,
      });
      expect(offline).toHaveBeenCalledTimes(1);
      expect(answer.avatars[0]!.dataUrl).toBe(original);
      rmSync(directory, { recursive: true, force: true });
    });

    it("磁盘上的文件被改坏了就当没有", async () => {
      const directory = fresh();
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(directory, "13"), "<script>");
      const fetcher = vi.fn(async () => png());
      await avatars([13], {
        fetch: fetcher as unknown as typeof fetch,
        enabled: () => true,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      rmSync(directory, { recursive: true, force: true });
    });
  });
});
