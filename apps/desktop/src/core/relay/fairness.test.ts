import { describe, expect, it } from "vitest";

import {
  type Frame,
  LIMITS,
  RST,
  decodeFrame,
} from "@armadra/platform-protocol/tunnel";

import { LOW_WATER, TunnelWriter, type WriterSocket } from "./writer";
import { WRITE_BUDGET } from "./sched";
import {
  CreditPool,
  type StreamHost,
  type StreamTrafficCounter,
  TunnelDuplex,
} from "./streams";

/**
 * 写端公平调度（#564，移植自中继 `fairness_test.go`）：假 ws 里 `bufferedAmount` 与「链路
 * 每回合写出多少」都由测试控制。延迟按「探测帧入队之后、它的帧之前又写出了多少 DATA
 * 字节」度量，与就绪流的数量无关，也不依赖时钟快慢。
 */

const CHUNK = LIMITS.maxDataChunk;

interface Item {
  readonly data: Uint8Array;
  readonly callback: (error?: Error) => void;
}

/** 假 ws：`send` 进缓冲，`link(n)` 模拟链路这一回合写出至多 n 字节（整帧为单位，至少一帧）。 */
class FakeSocket implements WriterSocket {
  private readonly queue: Item[] = [];
  private buffered = 0;
  /** 已经上线的帧，按写出顺序。 */
  readonly written: Frame[] = [];
  /** 已经上线的 DATA 载荷字节。 */
  dataBytes = 0;
  /** 在 ws 缓冲里、还没上线的 DATA 载荷字节。 */
  bufferedData = 0;

  get bufferedAmount(): number {
    return this.buffered;
  }

  send(
    data: Uint8Array,
    _options: { binary: true },
    callback: (error?: Error) => void,
  ): void {
    this.queue.push({ data, callback });
    this.buffered += data.length;
    const frame = decodeFrame(data);
    if (frame.type === "data") this.bufferedData += frame.bytes.length;
  }

  link(bytes: number): void {
    let left = bytes;
    while (this.queue.length > 0 && left > 0) {
      const item = this.queue.shift() as Item;
      left -= item.data.length;
      this.buffered -= item.data.length;
      const frame = decodeFrame(item.data);
      this.written.push(frame);
      if (frame.type === "data") {
        this.dataBytes += frame.bytes.length;
        this.bufferedData -= frame.bytes.length;
      }
      item.callback();
    }
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class Rig {
  readonly socket = new FakeSocket();
  readonly writer: TunnelWriter;
  readonly pool: CreditPool;
  readonly host: StreamHost;
  /** 宿主收到 `closed`（从流表摘掉）的流，按顺序。 */
  readonly closed: number[] = [];
  private nextId = 1;

  constructor(
    readonly streamWindow = 4 << 20,
    tunnelWindow = 1 << 30,
    options: { lowWater?: number; fifo?: boolean } = {},
  ) {
    this.writer = new TunnelWriter({
      socket: () => this.socket,
      ...(options.lowWater === undefined ? {} : { lowWater: options.lowWater }),
    });
    this.pool = new CreditPool(tunnelWindow);
    this.host = {
      sendFrame: (frame) => this.writer.control(frame),
      // fifo：不给 schedule，流直接 sendFrame，等于改前「谁先写谁先走」的写法。
      ...(options.fifo === true
        ? {}
        : { schedule: (stream: TunnelDuplex) => this.writer.schedule(stream) }),
      sendCredit: this.pool,
      consumed: () => undefined,
      closed: (stream) => this.closed.push(stream.streamId),
    };
  }

  open(counter?: StreamTrafficCounter): TunnelDuplex {
    const stream = new TunnelDuplex(
      this.nextId,
      this.host,
      { streamWindow: this.streamWindow, maxDataChunk: CHUNK },
      undefined,
      counter,
    );
    this.nextId += 1;
    stream.on("error", () => undefined);
    return stream;
  }

  /** 链路跑 `rounds` 回合，每回合写出 `perRound` 字节，回合之间让出事件循环。 */
  async run(rounds: number, perRound: number = CHUNK): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await settle();
      this.socket.link(perRound);
    }
    await settle();
  }

  /** 把探测之后到 `match` 帧之前写出的 DATA 字节数；还没写出答 `undefined`。 */
  ahead(from: number, match: (frame: Frame) => boolean): number | undefined {
    let n = 0;
    for (let i = from; i < this.socket.written.length; i += 1) {
      const frame = this.socket.written[i] as Frame;
      if (match(frame)) return n;
      if (frame.type === "data") n += frame.bytes.length;
    }
    return undefined;
  }

  async until(done: () => boolean, rounds = 4000): Promise<void> {
    for (let i = 0; i < rounds && !done(); i += 1) await this.run(1);
    expect(done()).toBe(true);
  }
}

/** 起 `bulk` 条各排 4 MiB 积压的大流量流，链路跑到稳态。 */
async function bulkRig(
  bulk: number,
): Promise<{ rig: Rig; bulk: TunnelDuplex[] }> {
  const rig = new Rig();
  const streams: TunnelDuplex[] = [];
  const payload = Buffer.alloc(4 << 20, 1);
  for (let i = 0; i < bulk; i += 1) {
    const stream = rig.open();
    stream.write(payload);
    streams.push(stream);
  }
  await rig.run(3 * bulk + 8);
  return { rig, bulk: streams };
}

const BOUND = WRITE_BUDGET + LOW_WATER + 2 * CHUNK;

describe("写端公平调度", () => {
  it("大流量流在跑时，交互流探测帧前写出的字节有上界，且与大流量流数量无关", async () => {
    for (const count of [4, 16, 64]) {
      const { rig } = await bulkRig(count);
      const probe = rig.open();
      let worst = 0;
      for (let i = 0; i < 5; i += 1) {
        const from = rig.socket.written.length;
        probe.write(Buffer.alloc(1024, i + 1));
        let ahead: number | undefined;
        await rig.until(() => {
          ahead = rig.ahead(
            from,
            (f) => f.type === "data" && f.streamId === probe.streamId,
          );
          return ahead !== undefined;
        });
        worst = Math.max(worst, ahead as number);
        // 停几回合再发：每次都是「刚醒来的稀疏流」。
        await rig.run(3);
      }
      expect(worst).toBeLessThanOrEqual(BOUND);
    }
  });

  it("慢链路：按键赶在一批写完之前到达，上一帧已写出就仍先于大流量流（cloud#133）", async () => {
    const { rig } = await bulkRig(16);
    const probe = rig.open();
    const mine = (f: Frame): boolean =>
      f.type === "data" && f.streamId === probe.streamId;
    let worst = 0;
    let from = rig.socket.written.length;
    probe.write(Buffer.alloc(16, 1));
    for (let key = 0; key < 6; key += 1) {
      // 链路每回合只写出一帧：一批要好几回合才写完。
      let ahead: number | undefined;
      for (let i = 0; i < 400 && ahead === undefined; i += 1) {
        await rig.run(1, 1);
        ahead = rig.ahead(from, mine);
      }
      expect(ahead).toBeDefined();
      worst = Math.max(worst, ahead as number);
      // 上一帧刚写出、这一批还排在 ws 里没写完，下一个按键就来了。
      expect(rig.socket.bufferedAmount).toBeGreaterThan(LOW_WATER);
      from = rig.socket.written.length;
      probe.write(Buffer.alloc(16, key + 2));
    }
    expect(worst).toBeLessThanOrEqual(BOUND);
  });

  it("对照：不走调度（先进先出）时探测帧前的字节远超上界", async () => {
    const rig = new Rig(1 << 20, 1 << 30, { fifo: true });
    for (let i = 0; i < 16; i += 1) rig.open().write(Buffer.alloc(1 << 20, 1));
    await rig.run(8);
    const probe = rig.open();
    const from = rig.socket.written.length;
    probe.write(Buffer.alloc(1024, 1));
    let ahead: number | undefined;
    await rig.until(() => {
      ahead = rig.ahead(
        from,
        (f) => f.type === "data" && f.streamId === probe.streamId,
      );
      return ahead !== undefined;
    });
    expect(ahead as number).toBeGreaterThan(4 * BOUND);
  });

  it("控制帧不被 DATA 挡住", async () => {
    const { rig } = await bulkRig(32);
    let worst = 0;
    for (let i = 0; i < 5; i += 1) {
      const from = rig.socket.written.length;
      rig.writer.control({ type: "pong", ts: i });
      let ahead: number | undefined;
      await rig.until(() => {
        ahead = rig.ahead(from, (f) => f.type === "pong");
        return ahead !== undefined;
      });
      worst = Math.max(worst, ahead as number);
      await rig.run(2);
    }
    expect(worst).toBeLessThanOrEqual(BOUND);
  });

  it("取下一批之前看 bufferedAmount：链路堵住时 ws 里的缓冲不超过低水位加一批", async () => {
    const { rig } = await bulkRig(8);
    // 不再放行：缓冲稳定下来，不论又有多少流排队。
    await settle();
    await settle();
    expect(rig.socket.bufferedAmount).toBeLessThanOrEqual(
      LOW_WATER + WRITE_BUDGET + CHUNK,
    );
    const before = rig.socket.written.length;
    for (let i = 0; i < 4; i += 1) rig.open().write(Buffer.alloc(100, 1));
    await settle();
    await settle();
    expect(rig.socket.written.length).toBe(before);
    expect(rig.socket.bufferedAmount).toBeLessThanOrEqual(
      LOW_WATER + WRITE_BUDGET + CHUNK,
    );
  });

  it("大流量流之间仍然轮转，稀疏流再多也饿不死老流", async () => {
    const { rig, bulk } = await bulkRig(4);
    const sparse = Array.from({ length: 32 }, () => rig.open());
    const from = rig.socket.written.length;
    for (let round = 0; round < 150; round += 1) {
      for (const stream of sparse) stream.write("k");
      await rig.run(2);
    }
    const counts = new Map<number, number>();
    for (const frame of rig.socket.written.slice(from)) {
      if (frame.type === "data") {
        counts.set(frame.streamId, (counts.get(frame.streamId) ?? 0) + 1);
      }
    }
    const shares = bulk
      .map((stream) => counts.get(stream.streamId) ?? 0)
      .sort((a, b) => a - b);
    expect(shares[0]).toBeGreaterThan(0);
    expect(shares.at(-1) as number).toBeLessThanOrEqual(
      2 * (shares[0] as number) + 4,
    );
  });

  it("流内 DATA 有序，END 在最后一块之后", async () => {
    const { rig } = await bulkRig(8);
    const stream = rig.open();
    const want: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const piece = Buffer.alloc(700, i);
      want.push(...piece);
      stream.write(piece);
      if (i % 7 === 0) await rig.run(1);
    }
    stream.end();
    await rig.until(() =>
      rig.socket.written.some(
        (f) => f.type === "end" && f.streamId === stream.streamId,
      ),
    );
    const got: number[] = [];
    let ended = false;
    for (const frame of rig.socket.written) {
      if (!("streamId" in frame) || frame.streamId !== stream.streamId)
        continue;
      if (frame.type === "data") {
        expect(ended).toBe(false);
        got.push(...frame.bytes);
      } else if (frame.type === "end") ended = true;
    }
    expect(got).toEqual(want);
  });

  it("收到 RST：排着的 DATA 丢弃，隧道信用归还，不再有该流的 DATA 上线", async () => {
    const rig = new Rig(4 << 20, 8 << 20);
    const stream = rig.open();
    stream.write(Buffer.alloc(2 << 20, 1));
    await rig.run(3);
    const sent = rig.socket.dataBytes + rig.socket.bufferedData;
    expect(sent).toBeLessThan(2 << 20);
    stream.receiveRst(RST.clientGone);
    // 扣掉的信用只剩已经交给 ws 的那部分。
    expect(rig.pool.available).toBe(8 * 2 ** 20 - sent);
    // 已经交给 ws 的照常上线，之后一个字节也不再多。
    const frames = rig.socket.written.length;
    await rig.run(100);
    expect(rig.socket.dataBytes).toBe(sent);
    const after = rig.socket.written.slice(frames);
    expect(after.some((f) => f.type === "rst")).toBe(false);
  });

  it("本端出错中止：RST 先行，排着的 DATA 丢弃并归还信用", async () => {
    const rig = new Rig(4 << 20, 8 << 20);
    const stream = rig.open();
    stream.write(Buffer.alloc(2 << 20, 1));
    await rig.run(3);
    const sent = rig.socket.dataBytes + rig.socket.bufferedData;
    stream.destroy(new Error("boom"));
    expect(rig.pool.available).toBe(8 * 2 ** 20 - sent);
    const frames = rig.socket.written.length;
    await rig.until(() =>
      rig.socket.written.slice(frames).some((f) => f.type === "rst"),
    );
    await rig.run(100);
    const after = rig.socket.written.slice(frames);
    const rstAt = after.findIndex((f) => f.type === "rst");
    expect(rstAt).toBeGreaterThanOrEqual(0);
    expect(
      after
        .slice(rstAt)
        .some((f) => f.type === "data" && f.streamId === stream.streamId),
    ).toBe(false);
  });

  it("先写再平静地销毁：已写的字节先于 RST 上线", async () => {
    const rig = new Rig();
    const stream = rig.open();
    stream.write(Buffer.from("HTTP/1.1 401\r\n\r\n"));
    stream.destroy();
    await rig.run(4);
    const mine = rig.socket.written.filter(
      (f) => "streamId" in f && f.streamId === stream.streamId,
    );
    expect(mine.map((f) => f.type)).toEqual(["data", "rst"]);
  });

  it("已经 END 之后才出错：尾巴与 END 先发完，RST internal 在最后", async () => {
    const rig = new Rig();
    const stream = rig.open();
    stream.write(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"));
    stream.end();
    await new Promise<void>((resolve) => stream.once("finish", resolve));
    stream.destroy(new Error("late"));
    await rig.run(4);
    const mine = rig.socket.written.filter(
      (f) => "streamId" in f && f.streamId === stream.streamId,
    );
    expect(mine.map((f) => f.type)).toEqual(["data", "end", "rst"]);
    expect(mine.at(-1)).toMatchObject({ code: RST.internal });
  });

  it("平静销毁后排空中：尾巴发完才摘表，RST 在最后", async () => {
    const rig = new Rig(4 << 20, 8 << 20);
    const stream = rig.open();
    stream.write(Buffer.alloc(1 << 20, 1));
    await rig.run(2);
    stream.destroy();
    expect(rig.closed).toEqual([]);
    // 出队列清空（尾巴都交给了 ws）才摘表；之后链路把缓冲里的写完。
    await rig.until(() => rig.closed.includes(stream.streamId));
    expect(stream.queuedBytes).toBe(0);
    await rig.run(20);
    const mine = rig.socket.written.filter(
      (f) => "streamId" in f && f.streamId === stream.streamId,
    );
    expect(rig.socket.dataBytes).toBe(1 << 20);
    expect(mine.at(-1)?.type).toBe("rst");
    expect(rig.closed).toEqual([stream.streamId]);
  });

  it("排空中收到对端 RST：丢弃尾巴、归还信用、摘表，不再发出该流的帧", async () => {
    const rig = new Rig(4 << 20, 8 << 20);
    const stream = rig.open();
    stream.write(Buffer.alloc(2 << 20, 1));
    await rig.run(3);
    stream.destroy();
    expect(rig.closed).toEqual([]);
    const sent = rig.socket.dataBytes + rig.socket.bufferedData;
    expect(sent).toBeLessThan(2 << 20);
    stream.receiveRst(RST.clientGone);
    expect(rig.pool.available).toBe(8 * 2 ** 20 - sent);
    await settle();
    expect(rig.closed).toEqual([stream.streamId]);
    const frames = rig.socket.written.length;
    await rig.run(100);
    expect(rig.socket.dataBytes).toBe(sent);
    expect(
      rig.socket.written
        .slice(frames)
        .some((f) => f.type === "rst" && f.streamId === stream.streamId),
    ).toBe(false);
    expect(rig.writer.backlog).toBe(0);
  });

  it("计数器在尾巴出帧之后才关：出向字节一个不漏", async () => {
    const rig = new Rig(4 << 20, 8 << 20);
    let out = 0;
    let outAtClose: number | undefined;
    const counter: StreamTrafficCounter = {
      add: (_in, bytesOut) => {
        expect(outAtClose).toBeUndefined();
        out += bytesOut;
      },
      identify: () => undefined,
      close: () => {
        outAtClose = out;
      },
    };
    const stream = rig.open(counter);
    stream.write(Buffer.alloc(1 << 20, 1));
    await rig.run(2);
    stream.destroy();
    expect(outAtClose).toBeUndefined();
    await rig.until(() => outAtClose !== undefined);
    expect(outAtClose).toBe(1 << 20);
  });

  it("大量 1 字节写入不是平方量级，字节一个不少", async () => {
    const rig = new Rig(1 << 20);
    const stream = rig.open();
    const start = performance.now();
    for (let i = 0; i < 100_000; i += 1) stream.write(Buffer.from([i & 0xff]));
    expect(performance.now() - start).toBeLessThan(5000);
    const drained = performance.now();
    await rig.until(() => rig.socket.dataBytes === 100_000, 200_000);
    expect(performance.now() - drained).toBeLessThan(10_000);
  }, 30_000);

  it("关闭不泄漏：清空队列，之后的入队无效，flushAll 不看水位", async () => {
    const { rig, bulk } = await bulkRig(4);
    expect(rig.writer.backlog).toBeGreaterThan(0);
    const bytes = rig.socket.bufferedData;
    rig.writer.flushAll();
    expect(rig.socket.bufferedData).toBeGreaterThan(bytes);
    rig.writer.reset();
    expect(rig.writer.backlog).toBe(0);
    for (const stream of bulk) expect(stream.flow.queued).toBe(0);
    const buffered = rig.socket.bufferedAmount;
    rig.writer.control({ type: "pong", ts: 1 });
    rig.writer.schedule(bulk[0] as TunnelDuplex);
    await rig.run(10);
    expect(rig.writer.backlog).toBe(0);
    expect(rig.socket.bufferedAmount).toBeLessThanOrEqual(buffered);
  });
});
