import { describe, expect, it } from "vitest";

import { type Flow, Sched, newFlow } from "./sched";

/** 调度器本身（移植自中继 `sched_test.go`）：轮转、稀疏流先出、预算、每批至少一条老流出帧、重置。 */

interface Item {
  readonly name: string;
  readonly flow: Flow;
  left: number;
  readonly frame: number;
}

function item(name: string, left: number, frame: number): Item {
  return { name, flow: newFlow(), left, frame };
}

function drain(q: Sched<Item>, budget: number): string[] {
  const out: string[] = [];
  q.drain(budget, (it) => {
    if (it.left === 0) return { size: -1, more: false };
    it.left -= 1;
    out.push(it.name);
    return { size: it.frame, more: it.left > 0 };
  });
  return out;
}

describe("写端调度器", () => {
  it("老流轮转、稀疏流先出、老流每批至少一帧", () => {
    const q = new Sched<Item>();
    const bulk = [
      item("a", 100, 100),
      item("b", 100, 100),
      item("c", 100, 100),
    ];
    for (const it of bulk) q.add(it, it.flow, it.left * it.frame);
    // 预算 250：100 + 100 未到、再一帧到 300 就停。
    expect(drain(q, 250)).toEqual(["a", "b", "c"]);
    // 已在队列里的忽略。
    for (const it of bulk) q.add(it, it.flow, it.left * it.frame);
    for (let round = 0; round < 4; round += 1) drain(q, 250);
    const [a, , c] = bulk as [Item, Item, Item];
    expect(Math.abs(c.left - a.left)).toBeLessThanOrEqual(1);
    // 停了几批之后才就绪的小流排在老流前面。
    const probe = item("p", 1, 10);
    q.add(probe, probe.flow, 10);
    expect(drain(q, 250)[0]).toBe("p");
    // 稀疏流再多，老流也每批至少一帧。
    for (let i = 0; i < 50; i += 1) {
      const it = item("s", 1, 100);
      q.add(it, it.flow, 100);
    }
    const got = drain(q, 100);
    expect(got.some((n) => n === "a" || n === "b" || n === "c")).toBe(true);
  });

  it("上一批刚出过帧、下一批还没开始就又就绪的流不算稀疏；隔了一批才醒来的才算", () => {
    const q = new Sched<Item>();
    const bulk = item("bulk", 100, 100);
    const chatty = item("chatty", 1, 10);
    q.add(bulk, bulk.flow, 10_000);
    q.add(chatty, chatty.flow, 10);
    // 第一批之前谁都没出过帧：按入队顺序。
    expect(drain(q, 1000)).toEqual(["bulk", "chatty"]);
    // chatty 在批与批之间补数据：served 等于当前批次，进老流，排在 bulk 后面。
    chatty.left = 1;
    q.add(chatty, chatty.flow, 10);
    expect(drain(q, 1000)).toEqual(["bulk", "chatty"]);
    // 一批里没有它之后再就绪，才是刚醒来的稀疏流，先于 bulk。
    drain(q, 1000);
    chatty.left = 1;
    q.add(chatty, chatty.flow, 10);
    expect(drain(q, 1000)).toEqual(["chatty", "bulk"]);
    // 排着超过上限的积压：不算稀疏，按老流排在 bulk 后面。
    drain(q, 1000);
    const heavy = item("heavy", 2, 10);
    heavy.flow.seq = 0;
    q.add(heavy, heavy.flow, 1 << 20);
    const got = drain(q, 1000);
    expect(got.indexOf("bulk")).toBeLessThan(got.indexOf("heavy"));
  });

  it("写端报告进度：上一帧已写出的流再就绪排最前，还没写出的排在老流之后", () => {
    const q = new Sched<Item>({ reportsSent: true });
    const a = item("a", 100, 100);
    const b = item("b", 100, 100);
    const k = item("k", 1, 10);
    const s = item("s", 1, 10);
    q.add(k, k.flow, 10);
    q.add(s, s.flow, 10);
    q.add(a, a.flow, 10_000);
    q.add(b, b.flow, 10_000);
    const seqs = new Map<string, number>();
    const base = q.drain(1000, (it, seq) => {
      it.left -= 1;
      seqs.set(it.name, seq);
      return { size: it.frame, more: it.left > 0 };
    });
    // 帧序：k=1 s=2 a=3 b=4，step 拿到的序号就是 base + k。
    expect([...seqs.values()]).toEqual([1, 2, 3, 4].map((n) => base + n));
    // 写端写到第 1 帧：k 的帧已写出，s、a、b 的还没；这一批还没写完，k 与 s 又各来一个按键。
    q.noteSent(seqs.get("k") as number);
    k.left = 1;
    s.left = 1;
    q.add(k, k.flow, 10);
    q.add(s, s.flow, 10);
    const order = drain(q, 1000);
    expect(order[0]).toBe("k");
    expect(order.indexOf("s")).toBeGreaterThan(order.indexOf("a"));
    // 报告进度时不按批追平：s 的上一帧（序号 2）直到写出才算稀疏。
    s.left = 1;
    q.add(s, s.flow, 10);
    expect(drain(q, 1000).indexOf("s")).toBeGreaterThan(0);
  });

  it("报告进度时不在批首追平：出过帧的流隔了一批、但没报告写出，再就绪仍是老流", () => {
    const q = new Sched<Item>({ reportsSent: true });
    const a = item("a", 100, 100);
    const s = item("s", 1, 10);
    q.add(s, s.flow, 10);
    q.add(a, a.flow, 10_000);
    expect(drain(q, 1000)).toEqual(["s", "a"]);
    // 又取了一批（不含 s），写端没报告任何帧写出：s 的上一帧仍在传输层前面排着。
    expect(drain(q, 1000)).toEqual(["a"]);
    s.left = 1;
    q.add(s, s.flow, 10);
    // 按批追平（中继的做法）会把 s 当成稀疏流排第一。
    expect(drain(q, 1000)).toEqual(["a", "s"]);
  });

  it("不报告进度：退回「上一批开始之后」，一批之内写出与否不影响判定", () => {
    const q = new Sched<Item>();
    const a = item("a", 100, 100);
    const k = item("k", 1, 10);
    q.add(k, k.flow, 10);
    q.add(a, a.flow, 10_000);
    drain(q, 1000);
    k.left = 1;
    q.add(k, k.flow, 10);
    expect(drain(q, 1000)).toEqual(["a", "k"]);
  });

  it("没有可出的帧的流被摘掉，可再次加入；重置后为空", () => {
    const q = new Sched<Item>();
    const dead = item("dead", 0, 0);
    q.add(dead, dead.flow, 0);
    const live = item("live", 2, 1);
    q.add(live, live.flow, 2);
    expect(drain(q, 100)).toEqual(["live"]);
    dead.left = 1;
    q.add(dead, dead.flow, 1);
    expect(drain(q, 100)).toHaveLength(2);
    q.reset();
    expect(drain(q, 100)).toEqual([]);
    expect(q.size).toBe(0);
  });
});
