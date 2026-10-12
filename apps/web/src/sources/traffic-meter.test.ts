import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryStorage } from "../mobile/testing";
import {
  TRAFFIC_STORAGE_KEY,
  TrafficLedger,
  type TransportMeter,
  localDay,
  meterSocket,
  meteredFetch,
  meteredWebSocket,
  pathUnder,
  payloadSize,
  utf8Length,
} from "./traffic-meter";
import { bearerFetch, ticketedWebSocket } from "./transport";

/**
 * 客户端计量（流量统计设计 §6.4）：账本的累加、落地与保留，fetch 与 WebSocket
 * 的挂法，只计经中继的，类别与 core 同一张表。
 */

const BASE = "https://relay.test/s/src1";
const NOW = new Date(2026, 9, 12, 10, 0, 0).getTime();

let clock: number;
let ledger: TrafficLedger;
let relayed: boolean;
const meter: TransportMeter = {
  sourceId: "src1",
  active: () => relayed,
  base: () => BASE,
};

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  clock = NOW;
  relayed = true;
  ledger = new TrafficLedger({ now: () => clock, timers: false });
});

afterEach(() => {
  ledger.dispose();
  vi.unstubAllGlobals();
});

describe("字节数", () => {
  it("UTF-8 长度不分配内存地算，与 TextEncoder 一致", () => {
    for (const text of ["", "abc", "流量", "😀x", "é"]) {
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
    }
  });

  it("各种请求体与消息", () => {
    expect(payloadSize("流量")).toBe(6);
    expect(payloadSize(new ArrayBuffer(10))).toBe(10);
    expect(payloadSize(new Uint8Array(7))).toBe(7);
    expect(payloadSize(new Blob(["abcd"]))).toBe(4);
    expect(payloadSize(new URLSearchParams({ a: "1" }))).toBe(3);
    expect(payloadSize(undefined)).toBe(0);
    expect(payloadSize(new ReadableStream())).toBe(0);
  });

  it("路径剥掉中继基址的 /s/<源>", () => {
    expect(pathUnder(`${BASE}/api/terminals/t/ws`, BASE)).toBe(
      "/api/terminals/t/ws",
    );
    expect(pathUnder("https://lan.test/api/ws", "https://lan.test")).toBe(
      "/api/ws",
    );
  });
});

describe("TrafficLedger", () => {
  it("按日 × 源 × 类别累加；今日 / 本月 / 全部；落地之后读得回", () => {
    ledger.record("src1", "terminal", 100, 10, 1);
    ledger.record("src1", "files", 5000, 0, 1);
    ledger.record("src2", "api", 1, 1, 1);
    clock -= 20 * 86_400_000; // 上个月
    ledger.record("src1", "api", 7, 7, 1);
    clock = NOW;
    expect(ledger.source("src1", "today").totals).toEqual({
      bytesIn: 5100,
      bytesOut: 10,
      streams: 2,
    });
    expect(ledger.source("src1", "all").totals.bytesIn).toBe(5107);
    expect(ledger.source("src1", "month").byCategory.files).toEqual({
      bytesIn: 5000,
      bytesOut: 0,
      streams: 1,
    });
    ledger.flush();
    const again = new TrafficLedger({ now: () => clock, timers: false });
    expect(again.month()).toEqual({
      src1: { bytesIn: 5100, bytesOut: 10, streams: 2 },
      src2: { bytesIn: 1, bytesOut: 1, streams: 1 },
    });
    again.dispose();
  });

  it("落地是加法：两次 flush 之间的数并进去", () => {
    ledger.record("src1", "api", 1, 0);
    ledger.flush();
    ledger.record("src1", "api", 2, 0);
    ledger.flush();
    const stored = JSON.parse(localStorage.getItem(TRAFFIC_STORAGE_KEY)!);
    expect(stored.rows[`${localDay(NOW)}|src1|api`]).toEqual([3, 0, 0]);
  });

  it("保留 90 天：更早的日子在 flush 时删掉", () => {
    clock = NOW - 91 * 86_400_000;
    ledger.record("src1", "api", 9, 9, 1);
    ledger.flush();
    clock = NOW;
    ledger.record("src1", "api", 1, 1, 1);
    ledger.flush();
    expect(ledger.source("src1", "all").totals.bytesIn).toBe(1);
  });

  it("清零只清那个源，存储与内存一起；订阅的人收到通知", () => {
    const listener = vi.fn();
    ledger.subscribe(listener);
    ledger.record("src1", "api", 1, 1, 1);
    ledger.flush();
    ledger.record("src1", "api", 2, 2, 1);
    ledger.record("src2", "api", 3, 3, 1);
    ledger.clear("src1");
    expect(ledger.source("src1", "all").totals).toEqual({
      bytesIn: 0,
      bytesOut: 0,
      streams: 0,
    });
    expect(ledger.source("src2", "all").totals.bytesIn).toBe(3);
    expect(listener).toHaveBeenCalled();
  });

  it("坏数据当作没有", () => {
    localStorage.setItem(TRAFFIC_STORAGE_KEY, "{not json");
    expect(ledger.month()).toEqual({});
    localStorage.setItem(
      TRAFFIC_STORAGE_KEY,
      JSON.stringify({ version: 1, rows: { "x|y|api": [-1, 0, 0] } }),
    );
    expect(ledger.month()).toEqual({});
  });
});

describe("挂到 fetch 与 WebSocket", () => {
  const book = () => ledger;

  it("经中继：记请求体与流过的响应体，按 core 的类别", async () => {
    const base = vi.fn(
      async () =>
        new Response(new Uint8Array(4096), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    ) as unknown as typeof fetch;
    const send = meteredFetch(base, meter, book);
    const response = await send(
      `${BASE}/api/workspaces/w/file-download?path=a`,
      { method: "POST", body: "hello" },
    );
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(4096);
    expect(ledger.source("src1", "today").byCategory.files).toEqual({
      bytesIn: 4096,
      bytesOut: 5,
      streams: 1,
    });
  });

  it("没有体的响应原样返回；不经中继时一字不记", async () => {
    const empty = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    const answer = await meteredFetch(empty, meter, book)(`${BASE}/api/x`);
    expect(answer.status).toBe(204);
    relayed = false;
    await meteredFetch(empty, meter, book)(`${BASE}/api/x`, { body: "zz" });
    expect(ledger.source("src1", "all").totals).toEqual({
      bytesIn: 0,
      bytesOut: 0,
      streams: 1,
    });
  });

  it("WebSocket：一条连接计一次，收发每条消息记载荷", () => {
    const socket = new EventTarget() as unknown as WebSocket;
    const sent: unknown[] = [];
    socket.send = (data) => void sent.push(data);
    meterSocket(socket, `${BASE}/api/terminals/t/ws`, meter, book);
    socket.send("输入");
    socket.dispatchEvent(
      new MessageEvent("message", { data: new ArrayBuffer(100) }),
    );
    expect(sent).toEqual(["输入"]);
    expect(ledger.source("src1", "today").byCategory.terminal).toEqual({
      bytesIn: 100,
      bytesOut: 6,
      streams: 1,
    });
  });

  it("构造器代理：每次构造取当时的原生实现，静态成员照读", () => {
    class Fake extends EventTarget {
      static readonly OPEN = 1;
      constructor(readonly url: string) {
        super();
      }
      send(): void {}
    }
    const Ctor = meteredWebSocket(
      () => Fake as unknown as typeof WebSocket,
      meter,
      book,
    );
    expect(Ctor.OPEN).toBe(1);
    const socket = new Ctor(`${BASE}/api/ws`);
    socket.send("abc");
    expect(ledger.source("src1", "today").byCategory.events).toEqual({
      bytesIn: 0,
      bytesOut: 3,
      streams: 1,
    });
  });
});

describe("传输层带上计量", () => {
  it("bearerFetch：发往这个源的请求经计量，别处的不经", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const base = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const shared = new TrafficLedger({ timers: false });
    const { setTrafficLedger } = await import("./traffic-meter");
    setTrafficLedger(shared);
    const send = bearerFetch(base, {
      origin: "https://relay.test",
      authorization: () => "t",
      wsTicket: async () => "x",
      refresh: async () => false,
      meter,
    });
    await (await send(`${BASE}/api/workspaces`)).text();
    await (await send("https://elsewhere.test/api/workspaces")).text();
    expect(shared.source("src1", "today").totals).toEqual({
      bytesIn: 2,
      bytesOut: 0,
      streams: 1,
    });
    setTrafficLedger(undefined);
  });

  it("ticketedWebSocket：换票之后的真连接带计量", async () => {
    const shared = new TrafficLedger({ timers: false });
    const { setTrafficLedger } = await import("./traffic-meter");
    setTrafficLedger(shared);
    const created: EventTarget[] = [];
    class Fake extends EventTarget {
      readyState = 1;
      binaryType: BinaryType = "blob";
      constructor(readonly url: string) {
        super();
        created.push(this);
      }
      send(): void {}
      close(): void {}
    }
    const Ctor = ticketedWebSocket(Fake as unknown as typeof WebSocket, {
      origin: "https://relay.test",
      wsTicket: async () => "ticket",
      meter,
    });
    const socket = new Ctor(`${BASE.replace("https", "wss")}/api/ws`);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    created[0]!.dispatchEvent(new MessageEvent("message", { data: "hey" }));
    socket.send("hi");
    expect(shared.source("src1", "today").byCategory.events).toEqual({
      bytesIn: 3,
      bytesOut: 2,
      streams: 1,
    });
    setTrafficLedger(undefined);
  });
});
