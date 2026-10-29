import { describe, expect, it, vi } from "vitest";

import { fail } from "../http/errors";
import { AttributionQueue, RelayExchanges, olderThan } from "./relay-login";
import type { NativeCredentials } from "./source-client";

const credentials = (token: string): NativeCredentials => ({
  hostId: "h",
  deviceId: "d",
  accessToken: token,
  refreshToken: `r-${token}`,
  accessExpiresAtMs: 10_000_000,
  principalHint: "",
});

describe("经中继换票的合并（契约 §88.2）", () => {
  const KEY = "source h https://relay";

  it("重登只共用自己到来之后才开始的那次；之前就开始的（旧断言）不共用", () => {
    const memo = new RelayExchanges();
    // A 的重登先开始，B 在 A 进行中到来。
    const a = memo.arrival(KEY);
    const aBegan = memo.begin(KEY);
    const b = memo.arrival(KEY);
    memo.record(KEY, true, aBegan, credentials("A"));
    expect(memo.shared(KEY, a, true, 0)?.accessToken).toBe("A");
    expect(memo.shared(KEY, b, true, 0)).toBeUndefined();
    // B 自己换；C 在 B 开始之前到来，可以共用 B 的。
    const c = memo.arrival(KEY);
    const bBegan = memo.begin(KEY);
    memo.record(KEY, true, bBegan, credentials("B"));
    expect(memo.shared(KEY, c, true, 0)?.accessToken).toBe("B");
  });

  it("普通换票共用到来之后完成的任何一次；重登不共用刷新换来的；不新鲜的不共用", () => {
    const memo = new RelayExchanges();
    const a = memo.arrival(KEY);
    const b = memo.arrival(KEY);
    memo.record(KEY, false, memo.begin(KEY), credentials("A"));
    expect(memo.shared(KEY, b, false, 0)?.accessToken).toBe("A");
    expect(memo.shared(KEY, b, true, 0)).toBeUndefined();
    expect(memo.shared(KEY, a, false, 10_000_000)).toBeUndefined();
    // 自己到来之前就完成的不算。
    expect(memo.shared(KEY, memo.arrival(KEY), false, 0)).toBeUndefined();
  });
});

describe("版本比较", () => {
  it("x.y.z 逐段比，认不出答 false", () => {
    expect(olderThan("0.9.4", "0.10.0")).toBe(true);
    expect(olderThan("0.10.0", "0.10.0")).toBe(false);
    expect(olderThan("1.0.0-beta", "0.11.0")).toBe(false);
    expect(olderThan("", "0.10.0")).toBe(false);
  });
});

describe("重登之后的归属纠正按源排队（契约 §88.2）", () => {
  const gate = () => {
    let open = () => {};
    const opened = new Promise<void>((done) => {
      open = done;
    });
    return { opened, open };
  };
  const silent = { warn: vi.fn() };

  it("同一个源按顺序做；还在排队时被更新的一次取代就不做；不同的源互不等", async () => {
    const queue = new AttributionQueue();
    const order: string[] = [];
    const first = gate();
    const started = gate();
    queue.run(
      "a",
      async () => {
        order.push("a1:start");
        started.open();
        await first.opened;
        order.push("a1:end");
      },
      silent,
    );
    // a1 已经开始做（不是还在排队）：后面再来的不会取代它。
    await started.opened;
    const a2 = vi.fn(async () => void order.push("a2"));
    queue.run("a", a2, silent);
    queue.run("a", async () => void order.push("a3"), silent);
    await queue.run("b", async () => void order.push("b1"), silent);
    expect(order).toEqual(["a1:start", "b1"]);
    first.open();
    await queue.settled();
    // a2 排队时 a3 已经跟上来：它拿的是更早的断言，跳过。
    expect(a2).not.toHaveBeenCalled();
    expect(order).toEqual(["a1:start", "b1", "a1:end", "a3"]);
    expect(queue.pending).toBe(0);
  });

  it("都还没开始时只做最新的那一次", async () => {
    const queue = new AttributionQueue();
    const calls: number[] = [];
    for (const n of [1, 2, 3])
      queue.run("a", async () => void calls.push(n), silent);
    await queue.settled();
    expect(calls).toEqual([3]);
  });

  it("失败只记一条 warn：字段只有源号与错误码；之后照常排", async () => {
    const queue = new AttributionQueue();
    const log = { warn: vi.fn() };
    await queue.run(
      "a",
      async () => {
        throw fail("source_unreachable", "refresh-secret-should-not-leak");
      },
      log,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![1]).toEqual({
      sourceId: "a",
      code: "source_unreachable",
    });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret");
    const next = vi.fn(async () => undefined);
    await queue.run("a", next, log);
    expect(next).toHaveBeenCalledTimes(1);
    expect(queue.pending).toBe(0);
  });
});
