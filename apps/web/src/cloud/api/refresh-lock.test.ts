import { describe, expect, it, vi } from "vitest";

import {
  createRefreshCoordinator,
  type ChannelLike,
  type LockManagerLike,
} from "./refresh-lock";
import { createCsrfStore } from "./session";

/** 跨「标签」共用的假锁：同名排队。 */
function fakeLocks(): LockManagerLike {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name, { signal }, callback) {
      const prev = tails.get(name) ?? Promise.resolve();
      let done!: () => void;
      const held = new Promise<void>((resolve) => (done = resolve));
      tails.set(name, held);
      return new Promise((resolve, reject) => {
        const abort = () => {
          done();
          reject(signal.reason);
        };
        let waiting = true;
        signal.addEventListener("abort", () => waiting && abort());
        void prev.then(() => {
          if (!waiting || signal.aborted) return;
          waiting = false;
          callback().then(resolve, reject).finally(done);
        });
      });
    },
  };
}

/** 假广播：发给同名的其它端。 */
function fakeBus() {
  const ends: Array<{
    listeners: Array<(event: { data: unknown }) => void>;
  }> = [];
  return (): ChannelLike => {
    const me = { listeners: [] as Array<(event: { data: unknown }) => void> };
    ends.push(me);
    return {
      postMessage(data) {
        for (const other of ends)
          if (other !== me)
            // 异步投递，贴近真实 BroadcastChannel。
            setTimeout(() => {
              for (const listener of other.listeners) listener({ data });
            }, 0);
      },
      addEventListener(_type, listener) {
        me.listeners.push(listener);
      },
    };
  };
}

function tab(
  name: string,
  locks: LockManagerLike | null,
  channel: ChannelLike | null,
) {
  const csrf = createCsrfStore();
  return {
    csrf,
    coordinator: createRefreshCoordinator({ name, csrf, locks, channel }),
  };
}

describe("跨标签刷新锁", () => {
  it("两个标签同时 401：refresh 串行，两边都拿到新 CSRF", async () => {
    const locks = fakeLocks();
    const channel = fakeBus();
    const a = tab("console", locks, channel());
    const b = tab("console", locks, channel());
    const since = Date.now() - 1;
    const send = vi.fn();
    let running = 0;
    const refreshIn = (t: typeof a) => async () => {
      send();
      running += 1;
      expect(running).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      t.csrf.set("c2");
      running -= 1;
    };
    const [ra, rb] = await Promise.all([
      a.coordinator.run(since, refreshIn(a)),
      b.coordinator.run(since, refreshIn(b)),
    ]);
    expect([ra, rb]).toEqual([true, true]);
    // 广播异步到达时后到的一方可能再刷一次，但绝不重叠；去重见 client.test.ts。
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(a.csrf.get()).toBe("c2");
    expect(b.csrf.get()).toBe("c2");
  });

  it("控制台与运营各自独立加锁，互不阻塞", async () => {
    const locks = fakeLocks();
    const consoleTab = tab("console", locks, null);
    const opsTab = tab("ops", locks, null);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = consoleTab.coordinator.run(Date.now() + 10, () => gate);
    const fast = vi.fn(async () => {});
    await opsTab.coordinator.run(Date.now() + 10, fast);
    expect(fast).toHaveBeenCalledTimes(1);
    release();
    await slow;
  });

  it("锁 API 不可用：本标签内仍串行，且仍广播 CSRF", async () => {
    const channel = fakeBus();
    const a = tab("console", null, channel());
    const b = tab("console", null, channel());
    const order: string[] = [];
    const first = a.coordinator.run(Date.now() - 1, async () => {
      order.push("start");
      await Promise.resolve();
      a.csrf.set("c9");
      order.push("end");
    });
    const second = a.coordinator.run(Date.now() - 1, async () => {
      order.push("again");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["start", "end"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(b.csrf.get()).toBe("c9");
  });

  it("没有锁也没有广播：每次照常刷新", async () => {
    const a = tab("console", null, null);
    const refresh = vi.fn(async () => {});
    await a.coordinator.run(Date.now() + 10, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reuse 为真（已有 CSRF）时不刷新", async () => {
    const a = tab("console", fakeLocks(), null);
    const refresh = vi.fn(async () => {});
    await a.coordinator.run(Date.now() + 10, refresh, () => true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("广播异步到达时两次刷新也严格串行，不重叠", async () => {
    const locks = fakeLocks();
    const channel = fakeBus();
    const a = tab("console", locks, channel());
    const b = tab("console", locks, channel());
    let running = 0;
    let peak = 0;
    let calls = 0;
    const refresh = async () => {
      calls += 1;
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
    };
    const future = Date.now() + 1000;
    await Promise.all([
      a.coordinator.run(future, refresh),
      b.coordinator.run(future, refresh),
    ]);
    expect(calls).toBe(2);
    expect(peak).toBe(1);
  });

  it("第一个 run 抛错，第二个 run 仍执行 refresh 并返回 true", async () => {
    const locks = fakeLocks();
    const a = tab("console", locks, null);
    const b = tab("console", locks, null);
    const future = Date.now() + 1000;
    const failing = a.coordinator.run(future, async () => {
      throw new Error("boom");
    });
    const second = vi.fn(async () => {});
    const [first, ok] = await Promise.allSettled([
      failing,
      b.coordinator.run(future, second),
    ]);
    expect(first.status).toBe("rejected");
    expect(ok).toEqual({ status: "fulfilled", value: true });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("本标签内（无锁 API）第一个抛错后，第二个仍执行", async () => {
    const a = tab("console", null, null);
    const future = Date.now() + 1000;
    const failing = a.coordinator.run(future, async () => {
      throw new Error("boom");
    });
    const second = vi.fn(async () => {});
    const results = await Promise.allSettled([
      failing,
      a.coordinator.run(future, second),
    ]);
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]).toEqual({ status: "fulfilled", value: true });
  });

  it("刷新挂住：超时抛错并放锁，其它标签随后能刷新", async () => {
    const locks = fakeLocks();
    const csrfA = createCsrfStore();
    const csrfB = createCsrfStore();
    const a = createRefreshCoordinator({
      name: "console",
      csrf: csrfA,
      locks,
      channel: null,
      refreshTimeoutMs: 20,
    });
    const b = createRefreshCoordinator({
      name: "console",
      csrf: csrfB,
      locks,
      channel: null,
      refreshTimeoutMs: 20,
    });
    const future = Date.now() + 1000;
    const hung = a.run(future, () => new Promise<void>(() => {}));
    const next = vi.fn(async () => {});
    const waiting = b.run(future, next);
    await expect(hung).rejects.toThrow("timed out");
    await expect(waiting).resolves.toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("等锁超时：这次续不上，答 false 且不执行 refresh", async () => {
    const locks = fakeLocks();
    const holder = createRefreshCoordinator({
      name: "console",
      csrf: createCsrfStore(),
      locks,
      channel: null,
      refreshTimeoutMs: 500,
    });
    const waiter = createRefreshCoordinator({
      name: "console",
      csrf: createCsrfStore(),
      locks,
      channel: null,
      lockWaitMs: 20,
    });
    const future = Date.now() + 1000;
    const hold = holder.run(
      future,
      () => new Promise((r) => setTimeout(r, 80)),
    );
    const refresh = vi.fn(async () => {});
    await expect(waiter.run(future, refresh)).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    await hold;
  });
});
