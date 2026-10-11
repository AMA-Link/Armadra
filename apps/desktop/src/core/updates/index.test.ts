import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UPDATES_RELEASES_PATH } from "@armadra/shared";

import { installContract } from "../http/rpc";
import { routeScope } from "../http/route-scopes";
import { ROUTES } from "../http/routes";
import { install as installSettings } from "../settings";
import { type Fixture, fixture } from "../workspaces/fixture";
import { fakeGithub, githubRelease } from "./github.fixture";
import { install, wantsRefresh } from "./index";
import { MIN_FETCH_INTERVAL_MS } from "./service";

/**
 * `GET /api/updates/releases`（契约 §64）装进 core：路由表里那条、旧路径经 HTTP、
 * procedure 三种答法同一份；通道跟设置走；`?refresh=1` 受一分钟节流。
 */

let core: Fixture;
let base: string;
let now = 1_791_700_000_000;
const github = fakeGithub({
  status: 200,
  body: [
    githubRelease("v0.6.1"),
    githubRelease("v0.7.0-beta.1"),
    githubRelease("v0.0.1"),
  ],
  headers: { etag: '"a"' },
});

beforeAll(async () => {
  core = fixture([
    installSettings,
    (context) => {
      install(context, {
        current: "0.6.0",
        fetch: github.fetch,
        now: () => now,
      });
    },
  ]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await core.server.close();
  core.close();
});

async function legacy(path: string) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

async function procedure(input?: unknown) {
  const response = await fetch(`${base}/api/rpc/updates/releases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  const body = (await response.json()) as { json: unknown };
  return { status: response.status, body: body.json };
}

describe(UPDATES_RELEASES_PATH, () => {
  it("在路由表里，要 updates:read", () => {
    expect(
      ROUTES.find((route) => route.path === UPDATES_RELEASES_PATH),
    ).toMatchObject({ methods: ["GET"], implemented: true });
    expect(routeScope("GET", UPDATES_RELEASES_PATH)?.permission).toBe(
      "updates:read",
    );
  });

  it("三种答法同一份；只联网一次", async () => {
    const table = await core.call("GET", UPDATES_RELEASES_PATH);
    const rest = await legacy(UPDATES_RELEASES_PATH);
    const rpc = await procedure();
    expect(table.status).toBe(200);
    expect(rest).toEqual({ status: 200, body: table.body });
    expect(rpc).toEqual({ status: 200, body: table.body });
    expect(table.body).toMatchObject({
      current: "0.6.0",
      channel: "stable",
      latest: "0.6.1",
      error: null,
    });
    expect(github.requests).toHaveLength(1);
  });

  it("通道跟 updates.channel 走", async () => {
    await core.call("PATCH", "/api/settings", { updates: { channel: "beta" } });
    const answer = await core.call("GET", UPDATES_RELEASES_PATH);
    expect(answer.body).toMatchObject({
      channel: "beta",
      latest: "0.7.0-beta.1",
    });
    await core.call("PATCH", "/api/settings", {
      updates: { channel: "stable" },
    });
  });

  it("?refresh=1 与 { refresh: true } 强制联网，每分钟至多一次", async () => {
    const before = github.requests.length;
    await legacy(`${UPDATES_RELEASES_PATH}?refresh=1`);
    expect(github.requests).toHaveLength(before);
    now += MIN_FETCH_INTERVAL_MS;
    github.answer({ status: 304 });
    await legacy(`${UPDATES_RELEASES_PATH}?refresh=1`);
    expect(github.requests).toHaveLength(before + 1);
    expect(github.requests.at(-1)?.headers["if-none-match"]).toBe('"a"');
    now += MIN_FETCH_INTERVAL_MS;
    await procedure({ refresh: true });
    expect(github.requests).toHaveLength(before + 2);
  });
});

describe("wantsRefresh", () => {
  it("只认真值", () => {
    for (const yes of [true, "1", "true", " YES "]) {
      expect(wantsRefresh(yes)).toBe(true);
    }
    for (const no of [undefined, false, "0", "", "no", 1]) {
      expect(wantsRefresh(no)).toBe(false);
    }
  });
});
