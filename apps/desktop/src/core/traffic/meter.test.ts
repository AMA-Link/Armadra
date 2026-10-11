import { describe, expect, it } from "vitest";

import { HOUR_MS, TrafficMeter, bucketStart } from "./meter";

/**
 * 累加器（契约 §76）：键的维度、认出对端前的字节、跨小时、drain / restore、
 * 线上字节、在线表与速率。
 */

const T0 = 1_791_700_000_000;
const ISSUER = "https://relay.test";

function meterAt(start = T0) {
  const clock = { now: start };
  const meter = new TrafficMeter({ now: () => clock.now });
  return { meter, clock };
}

function stream(meter: TrafficMeter, path = "/api/terminals/t1/ws") {
  return meter.stream({
    route: "relay",
    issuer: ISSUER,
    kind: path.endsWith("/ws") ? "ws" : "http",
    path,
  });
}

const ALICE = { principalId: "p-alice", deviceId: "d-alice" };

describe("TrafficMeter", () => {
  it("认出对端之前的字节挂在流上，认出后并进那一行；条数计一次", () => {
    const { meter } = meterAt();
    const counter = stream(meter);
    counter.add(100, 0);
    expect(meter.pendingRows).toBe(0);
    counter.identify(ALICE);
    counter.add(5, 7);
    counter.identify(ALICE);
    counter.close();
    expect(meter.drain()).toEqual([
      {
        bucketStartMs: bucketStart(T0),
        route: "relay",
        issuer: ISSUER,
        peerKind: "legacy",
        peerId: "d-alice",
        principalId: "p-alice",
        linkId: "",
        category: "terminal",
        streams: 1,
        bytesIn: 105,
        bytesOut: 7,
      },
    ]);
  });

  it("始终没认出（匿名面、被拒）的流结束时记成 anonymous", () => {
    const { meter } = meterAt();
    const login = stream(meter, "/api/identity/cloud/login");
    login.add(300, 200);
    login.identify(undefined);
    const refused = stream(meter, "/api/workspaces");
    refused.add(50, 40);
    refused.close();
    refused.close();
    login.close();
    const rows = meter.drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      peerKind: "anonymous",
      peerId: "",
      principalId: "",
      category: "api",
      streams: 2,
      bytesIn: 350,
      bytesOut: 240,
    });
  });

  it("跨过整点落进下一个桶；drain 之后缓存的行不再被写", () => {
    const { meter, clock } = meterAt(bucketStart(T0) + HOUR_MS - 1);
    const counter = stream(meter);
    counter.identify(ALICE);
    counter.add(1, 0);
    clock.now += 1;
    counter.add(2, 0);
    const first = meter.drain();
    expect(first.map((row) => [row.bucketStartMs, row.bytesIn])).toEqual([
      [bucketStart(T0), 1],
      [bucketStart(T0) + HOUR_MS, 2],
    ]);
    counter.add(4, 0);
    const second = meter.drain();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ bytesIn: 4, streams: 0 });
    // 第一次取走的行没有被后来的字节改动。
    expect(first[1]?.bytesIn).toBe(2);
  });

  it("restore 把落库失败的行加回去", () => {
    const { meter } = meterAt();
    const counter = stream(meter, "/api/media/x");
    counter.identify(ALICE);
    counter.add(10, 20);
    const taken = meter.drain();
    counter.add(1, 1);
    meter.restore(taken);
    const rows = meter.drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: "files",
      streams: 1,
      bytesIn: 11,
      bytesOut: 21,
    });
  });

  it("线上字节记在 transport / tunnel 一行，不计条数", () => {
    const { meter } = meterAt();
    meter.wire({ route: "relay", issuer: ISSUER }, 10, 0);
    meter.wire({ route: "relay", issuer: ISSUER }, 0, 30);
    meter.wire({ route: "relay", issuer: ISSUER }, 0, 0);
    meter.wire({ route: "relay", issuer: "https://other.test" }, 1, 1);
    const rows = meter.drain();
    expect(rows).toEqual([
      expect.objectContaining({
        issuer: ISSUER,
        peerKind: "tunnel",
        category: "transport",
        streams: 0,
        bytesIn: 10,
        bytesOut: 30,
      }),
      expect.objectContaining({ issuer: "https://other.test", bytesIn: 1 }),
    ]);
  });

  it("同一条连接上换了人：之后的字节记到新对端", () => {
    const { meter } = meterAt();
    const counter = stream(meter, "/api/rpc/system/hello");
    counter.identify(ALICE);
    counter.add(1, 1);
    counter.identify({ principalId: "p-bob", deviceId: "d-bob" });
    counter.add(2, 2);
    counter.close();
    const rows = meter.drain();
    expect(rows.map((row) => [row.peerId, row.streams, row.bytesIn])).toEqual([
      ["d-alice", 1, 1],
      ["d-bob", 0, 2],
    ]);
  });

  it("解析器决定访客与链接", () => {
    const meter = new TrafficMeter({
      now: () => T0,
      resolvePeer: (_issuer, who) => ({
        kind: "guest",
        peerId: who.deviceId,
        principalId: who.principalId,
        linkId: "L1",
      }),
    });
    const counter = stream(meter);
    counter.identify(ALICE);
    counter.close();
    expect(meter.drain()[0]).toMatchObject({ peerKind: "guest", linkId: "L1" });
  });

  it("在线表：只列开着流的对端，速率按最近几秒算", () => {
    const { meter, clock } = meterAt();
    const a = stream(meter);
    const b = stream(meter, "/api/ws");
    a.identify(ALICE);
    b.identify(ALICE);
    a.add(0, 1000);
    clock.now += 2000;
    b.add(0, 3000);
    const [peer] = meter.livePeers();
    expect(peer).toMatchObject({
      streams: 2,
      since: T0,
      bytesOut: 4000,
      rateOut: 1500,
      rateIn: 0,
    });
    a.close();
    expect(meter.livePeers()[0]?.streams).toBe(1);
    b.close();
    expect(meter.livePeers()).toEqual([]);
  });

  it("匿名流不进在线表；clear 清内存与在线计数", () => {
    const { meter } = meterAt();
    const anon = stream(meter, "/api/health");
    anon.identify(undefined);
    expect(meter.livePeers()).toEqual([]);
    const live = stream(meter);
    live.identify(ALICE);
    live.add(9, 9);
    meter.clear();
    expect(meter.pendingRows).toBe(0);
    expect(meter.livePeers()[0]).toMatchObject({ bytesIn: 0, bytesOut: 0 });
    live.add(1, 0);
    expect(meter.drain()[0]).toMatchObject({ streams: 0, bytesIn: 1 });
  });

  it("热路径的开销：一百万次 add 在一秒内", () => {
    const { meter } = meterAt();
    const counter = stream(meter);
    counter.identify(ALICE);
    const started = performance.now();
    for (let index = 0; index < 1_000_000; index += 1) counter.add(16_384, 0);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(meter.drain()[0]?.bytesIn).toBe(16_384_000_000);
  });
});
