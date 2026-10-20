import type { TimelineItem } from "@armadra/shared";
import { describe, expect, it } from "vitest";

import {
  createMemoryBackend,
  createTimelineCache,
  type CachedTimeline,
} from "./cache";
import { assistant, user } from "./test-support";

const value = (
  seq: number,
  items: TimelineItem[] = [user(0), assistant(0)],
): Omit<CachedTimeline, "key" | "touchedAt" | "bytes"> => ({
  seq,
  head: {},
  headRev: 0,
  items,
  turns: [],
  oldestLoadedTurn: 0,
});

describe("timeline cache", () => {
  it("round-trips per (source, timeline) key", async () => {
    const cache = createTimelineCache(createMemoryBackend());
    await cache.save("local", "a", value(5));
    await cache.save("remote", "a", value(9));
    expect((await cache.load("local", "a"))?.seq).toBe(5);
    expect((await cache.load("remote", "a"))?.seq).toBe(9);
    expect(await cache.load("local", "b")).toBeUndefined();
  });

  it("evicts the least recently used entry past the entry limit", async () => {
    let clock = 0;
    const cache = createTimelineCache(createMemoryBackend(), {
      maxEntries: 2,
      now: () => ++clock,
    });
    await cache.save("s", "a", value(1));
    await cache.save("s", "b", value(2));
    await cache.load("s", "a");
    await cache.save("s", "c", value(3));
    expect(await cache.load("s", "b")).toBeUndefined();
    expect((await cache.load("s", "a"))?.seq).toBe(1);
    expect((await cache.load("s", "c"))?.seq).toBe(3);
  });

  it("evicts by byte budget but keeps the entry just written", async () => {
    let clock = 0;
    const cache = createTimelineCache(createMemoryBackend(), {
      maxBytes: 3_000,
      now: () => ++clock,
    });
    const big = (n: number) => value(n, [user(0, "x".repeat(700))]);
    await cache.save("s", "a", big(1));
    await cache.save("s", "b", big(2));
    await cache.save("s", "c", big(3));
    expect(await cache.load("s", "a")).toBeUndefined();
    expect((await cache.load("s", "c"))?.seq).toBe(3);
  });

  it("swallows backend failures", async () => {
    const broken = {
      get: async () => {
        throw new Error("boom");
      },
      put: async () => {
        throw new Error("boom");
      },
      delete: async () => {
        throw new Error("boom");
      },
      list: async () => {
        throw new Error("boom");
      },
    };
    const cache = createTimelineCache(broken);
    await expect(cache.save("s", "a", value(1))).resolves.toBeUndefined();
    await expect(cache.load("s", "a")).resolves.toBeUndefined();
    await expect(cache.remove("s", "a")).resolves.toBeUndefined();
  });

  it("is a no-op without a backend", async () => {
    const cache = createTimelineCache(null);
    await cache.save("s", "a", value(1));
    expect(await cache.load("s", "a")).toBeUndefined();
  });
});
