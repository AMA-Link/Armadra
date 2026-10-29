import { describe, expect, it, vi } from "vitest";

import {
  RELOGIN_DELAY_MS,
  RELOGIN_GAP_MS,
  createReloginScheduler,
} from "./relogin";

/** 手动推进的时钟与计时器。 */
function manualClock() {
  let now = 0;
  let next = 1;
  const timers: { id: number; at: number; run: () => void }[] = [];
  return {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      const id = next++;
      timers.push({ id, at: now + ms, run });
      return id;
    },
    clearTimeout: (id: unknown) => {
      const index = timers.findIndex((one) => one.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    /** 推进时间，到点的计时器依次跑。 */
    advance(ms: number) {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (due === undefined || due.at > now) return;
        timers.shift();
        due.run();
      }
    },
    pending: () => timers.map((one) => one.at - now),
  };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("重登去抖（契约 §88.2）", () => {
  it("2 秒内 5 个事件只重登一次", async () => {
    const clock = manualClock();
    const run = vi.fn(async (_key: string) => undefined);
    const scheduler = createReloginScheduler({ ...clock, run });
    for (let i = 0; i < 5; i += 1) {
      scheduler.request("a");
      clock.advance(300);
    }
    expect(run).not.toHaveBeenCalled();
    clock.advance(RELOGIN_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("a");
    await settle();
    clock.advance(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("两次重登至少隔 15 秒；不同的源各算各的", async () => {
    const clock = manualClock();
    const run = vi.fn(async (_key: string) => undefined);
    const scheduler = createReloginScheduler({ ...clock, run });
    scheduler.request("a");
    clock.advance(RELOGIN_DELAY_MS);
    await settle();
    clock.advance(1_000);
    scheduler.request("a");
    scheduler.request("b");
    // a 上一次开始已过 1 秒：等满 15 秒；b 照常 2 秒。
    expect(clock.pending().sort((x, y) => x - y)).toEqual([
      RELOGIN_DELAY_MS,
      RELOGIN_GAP_MS - 1_000,
    ]);
    clock.advance(RELOGIN_DELAY_MS);
    expect(run.mock.calls.map(([key]) => key)).toEqual(["a", "b"]);
    clock.advance(RELOGIN_GAP_MS);
    expect(run.mock.calls.map(([key]) => key)).toEqual(["a", "b", "a"]);
  });

  it("正在重登时来的事件只记一笔，完后再来一次", async () => {
    const clock = manualClock();
    let finish = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((done) => {
          finish = done;
        }),
    );
    const scheduler = createReloginScheduler({ ...clock, run });
    scheduler.request("a");
    clock.advance(RELOGIN_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.request("a");
    scheduler.request("a");
    expect(clock.pending()).toEqual([]);
    finish();
    await settle();
    expect(clock.pending()).toHaveLength(1);
    clock.advance(RELOGIN_GAP_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("失败不重试；dispose 之后不再跑", async () => {
    const clock = manualClock();
    const run = vi.fn(async () => {
      throw new Error("no");
    });
    const scheduler = createReloginScheduler({ ...clock, run });
    scheduler.request("a");
    clock.advance(RELOGIN_DELAY_MS);
    await settle();
    clock.advance(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.request("a");
    scheduler.dispose();
    clock.advance(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
