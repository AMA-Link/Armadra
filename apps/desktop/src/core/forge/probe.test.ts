/**
 * 平台探测（契约 §111.3）：已知主机不联网；未知主机按 v3/meta、v1/version、
 * v4/version 的顺序认，401 的 GitLab 也认；按主机缓存；不带凭据、不跟重定向。
 */

import { describe, expect, it } from "vitest";

import { PlatformProbe } from "./probe";

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[new URL(url).pathname];
    if (route === undefined) return new Response("nope", { status: 404 });
    return new Response(
      route.body === undefined ? "" : JSON.stringify(route.body),
      { status: route.status },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("PlatformProbe", () => {
  it("已知主机直接认，不联网", async () => {
    const { fetch, calls } = fakeFetch({});
    const probe = new PlatformProbe({ fetch });
    expect(probe.peek("gitlab.com")?.forge).toBe("gitlab");
    expect(probe.peek("codeberg.org")?.forge).toBe("gitea");
    expect(probe.peek("gitea.com")?.apiBase).toBe("https://gitea.com/api/v1");
    expect((await probe.probe("github.com"))?.forge).toBe("github");
    expect(calls).toEqual([]);
  });

  it("GitHub 企业版：/api/v3/meta 200", async () => {
    const { fetch } = fakeFetch({
      "/api/v3/meta": { status: 200, body: { installed_version: "3.12" } },
    });
    const probe = new PlatformProbe({ fetch });
    expect(await probe.probe("ghe.corp.test")).toEqual({
      forge: "github",
      apiBase: "https://ghe.corp.test/api/v3",
    });
  });

  it("Gitea / Forgejo：/api/v1/version", async () => {
    const { fetch } = fakeFetch({
      "/api/v1/version": { status: 200, body: { version: "1.22.0" } },
    });
    expect(
      (await new PlatformProbe({ fetch }).probe("git.corp.test"))?.forge,
    ).toBe("gitea");
  });

  it("GitLab：/api/v4/version 的 401 也算，200 带 version 也算", async () => {
    const unauthorised = fakeFetch({ "/api/v4/version": { status: 401 } });
    expect(
      (await new PlatformProbe({ fetch: unauthorised.fetch }).probe("a.test"))
        ?.forge,
    ).toBe("gitlab");
    const open = fakeFetch({
      "/api/v4/version": { status: 200, body: { version: "17.0" } },
    });
    expect(
      (await new PlatformProbe({ fetch: open.fetch }).probe("b.test"))?.forge,
    ).toBe("gitlab");
  });

  it("认不出是 null；结果按主机缓存，过期才再探", async () => {
    const { fetch, calls } = fakeFetch({});
    let at = 0;
    const probe = new PlatformProbe({ fetch, now: () => at });
    expect(probe.peek("nothing.test")).toBeUndefined();
    expect(await probe.probe("nothing.test")).toBeNull();
    const first = calls.length;
    expect(first).toBe(3);
    expect(probe.peek("nothing.test")).toBeNull();
    await probe.probe("nothing.test");
    expect(calls).toHaveLength(first);
    at += 3 * 60_000;
    await probe.probe("nothing.test");
    expect(calls).toHaveLength(first * 2);
  });

  it("同一主机并发只探一次；探测不带凭据、不跟重定向；网络错误不外传", async () => {
    const { fetch, calls } = fakeFetch({
      "/api/v1/version": { status: 200, body: { version: "1" } },
    });
    const probe = new PlatformProbe({ fetch });
    await Promise.all([probe.probe("c.test"), probe.probe("c.test")]);
    expect(calls.filter((c) => c.url.endsWith("/api/v3/meta"))).toHaveLength(1);
    for (const call of calls) {
      expect(call.init?.redirect).toBe("manual");
      expect(JSON.stringify(call.init?.headers)).not.toMatch(/authorization/i);
      expect(call.url.startsWith("https://")).toBe(true);
    }
    const broken = new PlatformProbe({
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof globalThis.fetch,
    });
    expect(await broken.probe("d.test")).toBeNull();
  });
});
