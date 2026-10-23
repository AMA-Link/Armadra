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
    request(name, callback) {
      const next = (tails.get(name) ?? Promise.resolve()).then(
        callback,
        callback,
      );
      tails.set(
        name,
        next.catch(() => undefined),
      );
      return next;
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
            for (const listener of other.listeners) listener({ data });
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
  it("两个标签同时 401：只发一次 refresh，两边都拿到新 CSRF", async () => {
    const locks = fakeLocks();
    const channel = fakeBus();
    const a = tab("console", locks, channel());
    const b = tab("console", locks, channel());
    const since = Date.now() - 1;
    const send = vi.fn();
    const refreshIn = (t: typeof a) => async () => {
      send();
      await Promise.resolve();
      t.csrf.set("c2");
    };
    const [ra, rb] = await Promise.all([
      a.coordinator.run(since, refreshIn(a)),
      b.coordinator.run(since, refreshIn(b)),
    ]);
    expect([ra, rb]).toEqual([true, true]);
    expect(send).toHaveBeenCalledTimes(1);
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
});
