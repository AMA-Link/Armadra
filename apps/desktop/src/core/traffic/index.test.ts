import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TRAFFIC_CLEAR_PATH,
  TRAFFIC_LIVE_PATH,
  TRAFFIC_SERIES_PATH,
  TRAFFIC_SUMMARY_PATH,
} from "@armadra/shared";

import { installContract } from "../http/rpc";
import { routeScope } from "../http/route-scopes";
import { ROUTES } from "../http/routes";
import {
  type AuditEvent,
  installAuditSink,
  resetAuditSink,
} from "../identity/audit";
import { install as installSettings } from "../settings";
import { type Fixture, fixture } from "../workspaces/fixture";
import { bucketStart } from "./meter";
import { type TrafficService, install, trafficDomain } from "./index";

/**
 * `traffic.*`（契约 §76）装进 core：路由表与授权、旧路径与 procedure 同一份答案、
 * 保留期跟设置走、清零写审计。
 */

const NOW = bucketStart(1_791_700_000_000) + 60_000;
let core: Fixture;
let base: string;
let service: TrafficService;
const audits: AuditEvent[] = [];

beforeAll(async () => {
  core = fixture([
    installSettings,
    (context) => {
      service = install(context, {
        now: () => NOW,
        timers: false,
      }) as TrafficService;
    },
  ]);
  installAuditSink((event) => audits.push(event));
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const counter = service.meter.stream({
    route: "relay",
    issuer: "https://relay.test",
    kind: "ws",
    path: "/api/terminals/t/ws",
  });
  counter.identify({ principalId: "p", deviceId: "d" });
  counter.add(10, 20);
  service.meter.wire({ route: "relay", issuer: "https://relay.test" }, 15, 30);
});

afterAll(async () => {
  resetAuditSink();
  await core.server.close();
  core.close();
});

async function legacy(method: string, path: string) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(method === "POST"
      ? { headers: { "content-type": "application/json" }, body: "{}" }
      : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function procedure(name: string, input?: unknown) {
  const response = await fetch(`${base}/api/rpc/traffic/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  const body = (await response.json()) as { json: unknown };
  return { status: response.status, body: body.json };
}

describe("traffic 域", () => {
  it("装好后可取到；四条路径在路由表里，只有 owner", () => {
    expect(trafficDomain()).toBe(service);
    for (const [method, path] of [
      ["GET", TRAFFIC_SUMMARY_PATH],
      ["GET", TRAFFIC_SERIES_PATH],
      ["GET", TRAFFIC_LIVE_PATH],
      ["POST", TRAFFIC_CLEAR_PATH],
    ] as const) {
      expect(ROUTES.find((route) => route.path === path)).toMatchObject({
        methods: [method],
        implemented: true,
      });
      expect(routeScope(method, path)?.permission).toBe(
        method === "GET" ? "settings:read" : "settings:write",
      );
    }
  });

  it("summary：旧路径（查询串）、路由表与 procedure 同一份答案", async () => {
    const query = `fromMs=${NOW - 86_400_000}&toMs=${NOW + 3_600_000}&groupBy=category`;
    const rest = await legacy("GET", `${TRAFFIC_SUMMARY_PATH}?${query}`);
    const rpc = await procedure("summary", {
      fromMs: NOW - 86_400_000,
      toMs: NOW + 3_600_000,
      groupBy: "category",
    });
    const table = await core.call("GET", `${TRAFFIC_SUMMARY_PATH}?${query}`);
    expect(rest.status).toBe(200);
    expect(rpc).toEqual(rest);
    expect(table).toMatchObject({ status: 200, body: rest.body });
    expect(
      (await core.call("GET", `${TRAFFIC_SUMMARY_PATH}?groupBy=peer`)).status,
    ).toBe(400);
    expect(rest.body).toEqual({
      retentionDays: 180,
      rows: [
        {
          key: "transport",
          label: "",
          peerKind: "",
          principalId: "",
          linkId: "",
          streams: 0,
          bytesIn: 0,
          bytesOut: 0,
          wireBytesIn: 15,
          wireBytesOut: 30,
        },
        {
          key: "terminal",
          label: "",
          peerKind: "",
          principalId: "",
          linkId: "",
          streams: 1,
          bytesIn: 10,
          bytesOut: 20,
          wireBytesIn: 0,
          wireBytesOut: 0,
        },
      ],
    });
  });

  it("入参不对答 400", async () => {
    const bad = await legacy(
      "GET",
      `${TRAFFIC_SUMMARY_PATH}?fromMs=0&toMs=1&groupBy=ip`,
    );
    expect(bad.status).toBe(400);
  });

  it("series 与 live", async () => {
    const series = await legacy(
      "GET",
      `${TRAFFIC_SERIES_PATH}?fromMs=0&toMs=${NOW + 3_600_000}&bucket=hour`,
    );
    expect(series.body).toEqual({
      points: [
        {
          bucketStartMs: bucketStart(NOW),
          streams: 1,
          bytesIn: 10,
          bytesOut: 20,
          wireBytesIn: 15,
          wireBytesOut: 30,
        },
      ],
    });
    const live = await procedure("live");
    expect(live.body).toEqual({
      channels: [
        expect.objectContaining({
          peerId: "d",
          peerKind: "legacy",
          streams: 1,
        }),
      ],
    });
  });

  it("保留期跟 traffic.retentionDays 走，不认的值回到 180", async () => {
    await core.call("PATCH", "/api/settings", {
      traffic: { retentionDays: 30 },
    });
    expect(service.summary({ fromMs: 0, toMs: 1, groupBy: "peer" })).toEqual({
      rows: [],
      retentionDays: 30,
    });
    await core.call("PATCH", "/api/settings", {
      traffic: { retentionDays: 31 },
    });
    expect(
      service.summary({ fromMs: 0, toMs: 1, groupBy: "peer" }).retentionDays,
    ).toBe(180);
  });

  it("clear：清空并写审计 traffic.clear", async () => {
    const answer = await legacy("POST", TRAFFIC_CLEAR_PATH);
    expect(answer).toEqual({ status: 200, body: { cleared: true } });
    expect(audits.map((event) => event.action)).toContain("traffic.clear");
    const after = await procedure("summary", {
      fromMs: 0,
      toMs: NOW + 3_600_000,
      groupBy: "peer",
    });
    expect(after.body).toEqual({ rows: [], retentionDays: 180 });
  });
});
