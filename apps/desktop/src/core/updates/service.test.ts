import { describe, expect, it } from "vitest";

import type { UpdateChannel } from "@armadra/shared";

import { OUTBOUND } from "../net/outbound";
import { fakeGithub, githubRelease } from "./github.fixture";
import {
  CACHE_TTL_MS,
  MIN_FETCH_INTERVAL_MS,
  RELEASES_REPO,
  ReleaseService,
  releasesUrl,
} from "./service";

const PAGE = [
  githubRelease("v0.6.0"),
  githubRelease("v0.7.0-beta.1"),
  githubRelease("v0.6.1"),
];

function setup(
  options: {
    current?: string;
    channel?: UpdateChannel;
    answer?: Parameters<typeof fakeGithub>[0];
  } = {},
) {
  let now = 1_791_700_000_000;
  let channel: UpdateChannel = options.channel ?? "stable";
  const github = fakeGithub(
    options.answer ?? {
      status: 200,
      body: PAGE,
      headers: { etag: '"v1"' },
    },
  );
  const service = new ReleaseService({
    current: options.current ?? "0.6.0",
    channel: () => channel,
    fetch: github.fetch,
    now: () => now,
  });
  return {
    service,
    github,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    setChannel: (next: UpdateChannel) => {
      channel = next;
    },
  };
}

describe("releasesUrl", () => {
  it("缺省就是登记的出站地址，仓库来自常量；可换仓库与 API 根", () => {
    expect(releasesUrl()).toBe(`${OUTBOUND.githubReleases.url}?per_page=30`);
    expect(OUTBOUND.githubReleases.url).toBe(
      `${OUTBOUND.githubApi.url}/repos/${RELEASES_REPO}/releases`,
    );
    expect(releasesUrl("me/fork", "https://ghe.example.test/api/v3")).toBe(
      "https://ghe.example.test/api/v3/repos/me/fork/releases?per_page=30",
    );
  });
});

describe("ReleaseService", () => {
  it("第一次读联网，答 §64 的形状；stable 跳过预发布", async () => {
    const { service, github, now } = setup();
    const answer = await service.releases();
    expect(github.requests).toHaveLength(1);
    expect(github.requests[0]?.url).toBe(releasesUrl());
    expect(github.requests[0]?.headers.accept).toBe(
      "application/vnd.github+json",
    );
    expect(github.requests[0]?.headers["if-none-match"]).toBeUndefined();
    expect(answer).toMatchObject({
      current: "0.6.0",
      channel: "stable",
      checkedAt: now(),
      latest: "0.6.1",
      error: null,
    });
    expect(answer.releases.map((release) => release.version)).toEqual([
      "0.6.1",
      "0.6.0",
    ]);
  });

  it("通道按每次读时的设置过滤，不重新联网", async () => {
    const { service, github, setChannel } = setup();
    await service.releases();
    setChannel("beta");
    const answer = await service.releases();
    expect(github.requests).toHaveLength(1);
    expect(answer.channel).toBe("beta");
    expect(answer.latest).toBe("0.7.0-beta.1");
    expect(answer.releases.map((release) => release.version)).toEqual([
      "0.7.0-beta.1",
      "0.6.1",
      "0.6.0",
    ]);
  });

  it("没有更高的版本时 latest 是 null", async () => {
    const { service } = setup({ current: "0.6.1" });
    expect((await service.releases()).latest).toBeNull();
  });

  it("6 小时内复用缓存；过期后带 If-None-Match，304 只刷新时刻", async () => {
    const { service, github, advance, now } = setup();
    await service.releases();
    advance(CACHE_TTL_MS - 1);
    await service.releases();
    expect(github.requests).toHaveLength(1);

    advance(1);
    github.answer({ status: 304, headers: { etag: '"v1"' } });
    const answer = await service.releases();
    expect(github.requests).toHaveLength(2);
    expect(github.requests[1]?.headers["if-none-match"]).toBe('"v1"');
    expect(answer.checkedAt).toBe(now());
    expect(answer.releases).toHaveLength(2);
    expect(answer.error).toBeNull();
  });

  it("200 换掉缓存与 ETag", async () => {
    const { service, github, advance } = setup();
    await service.releases();
    advance(CACHE_TTL_MS);
    github.answer({
      status: 200,
      body: [githubRelease("v0.8.0"), ...PAGE],
      headers: { etag: '"v2"' },
    });
    expect((await service.releases()).latest).toBe("0.8.0");
    advance(CACHE_TTL_MS);
    await service.releases();
    expect(github.requests[2]?.headers["if-none-match"]).toBe('"v2"');
  });

  it("refresh 绕过缓存，但每分钟至多真的联网一次", async () => {
    const { service, github, advance } = setup();
    await service.releases();
    await service.releases(true);
    expect(github.requests).toHaveLength(1);
    advance(MIN_FETCH_INTERVAL_MS - 1);
    await service.releases(true);
    expect(github.requests).toHaveLength(1);
    advance(1);
    await service.releases(true);
    expect(github.requests).toHaveLength(2);
  });

  it("并发的读等同一趟请求", async () => {
    const { service, github } = setup();
    const answers = await Promise.all([
      service.releases(),
      service.releases(true),
      service.releases(),
    ]);
    expect(github.requests).toHaveLength(1);
    for (const answer of answers) expect(answer.latest).toBe("0.6.1");
  });

  it("联网失败答上次缓存，带 unreachable；一分钟内不再试", async () => {
    const { service, github, advance } = setup();
    const first = await service.releases();
    advance(CACHE_TTL_MS);
    github.answer(new TypeError("fetch failed"));
    const answer = await service.releases();
    expect(answer.releases).toEqual(first.releases);
    expect(answer.checkedAt).toBe(first.checkedAt);
    expect(answer.error).toEqual({
      code: "unreachable",
      message: "fetch failed",
      retryAfterMs: MIN_FETCH_INTERVAL_MS,
    });

    advance(10_000);
    const again = await service.releases(true);
    expect(github.requests).toHaveLength(2);
    expect(again.error?.retryAfterMs).toBe(MIN_FETCH_INTERVAL_MS - 10_000);

    advance(MIN_FETCH_INTERVAL_MS);
    github.answer({ status: 304 });
    const healed = await service.releases();
    expect(github.requests).toHaveLength(3);
    expect(healed.error).toBeNull();
  });

  it("从没取到过时答空列表与 error，checkedAt 是 null", async () => {
    const { service } = setup({ answer: { status: 502 } });
    const answer = await service.releases();
    expect(answer).toMatchObject({
      checkedAt: null,
      latest: null,
      releases: [],
      error: { code: "unreachable", message: "GitHub 答 502" },
    });
  });

  it("答的不是数组算 unreachable", async () => {
    const { service } = setup({
      answer: { status: 200, body: { message: "nope" } },
    });
    expect((await service.releases()).error?.code).toBe("unreachable");
  });

  it("限流：rateLimited，按 x-ratelimit-reset 退避，之前不再问", async () => {
    const { service, github, advance, now } = setup();
    await service.releases();
    advance(CACHE_TTL_MS);
    const resetAt = Math.floor(now() / 1000) + 600;
    github.answer({
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetAt),
      },
    });
    const answer = await service.releases();
    expect(answer.error?.code).toBe("rateLimited");
    expect(answer.error?.retryAfterMs).toBe(resetAt * 1000 - now());
    expect(answer.releases).toHaveLength(2);

    advance(5 * 60_000);
    await service.releases(true);
    expect(github.requests).toHaveLength(2);
    advance(5 * 60_000);
    github.answer({ status: 304 });
    expect((await service.releases(true)).error).toBeNull();
    expect(github.requests).toHaveLength(3);
  });

  it("429 带 Retry-After 也是限流", async () => {
    const { service } = setup({
      answer: { status: 429, headers: { "retry-after": "120" } },
    });
    expect((await service.releases()).error).toEqual({
      code: "rateLimited",
      message: "GitHub 限流（429）",
      retryAfterMs: 120_000,
    });
  });

  it("没写限流头的 403 是 unreachable", async () => {
    const { service } = setup({ answer: { status: 403 } });
    expect((await service.releases()).error?.code).toBe("unreachable");
  });

  it("最多答 30 条", async () => {
    const page = Array.from({ length: 40 }, (_, index) =>
      githubRelease(`v1.${index}.0`),
    );
    const { service } = setup({ answer: { status: 200, body: page } });
    const answer = await service.releases();
    expect(answer.releases).toHaveLength(30);
    expect(answer.releases[0]?.version).toBe("1.39.0");
  });
});
