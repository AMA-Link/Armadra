import { afterEach, describe, expect, it, vi } from "vitest";

import { type ProbeOptions, createProbe } from "./probe";

/**
 * 全部确定：手动时钟与手动计时器，`run` 的成败由用例自己落定，微任务按次数排空——
 * 不读真实时间、不用框架的假定时器，负载再高结果也一样。
 */
function manualClock() {
  let now = 0;
  let next = 1;
  const timers: { id: number; at: number; run: () => void }[] = [];
  const options: ProbeOptions = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = next++;
      timers.push({ id, at: now + ms, run });
      return id;
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((one) => one.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  return {
    options,
    /** 推进时间，到点的计时器依次跑。 */
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (due === undefined || due.at > target) break;
        timers.shift();
        now = due.at;
        due.run();
      }
      now = target;
    },
    pending: () => timers.length,
  };
}

/** 排空微任务（`run` 的成败回调在这里落定）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

afterEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

describe("createProbe（#581）", () => {
  it("同一时刻只有一次在途；问到之后再也不问", async () => {
    const clock = manualClock();
    let land!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (land = resolve)));
    const probe = createProbe(run, clock.options);
    for (let i = 0; i < 100; i += 1) probe.ensure();
    expect(run).toHaveBeenCalledTimes(1);
    land();
    await flush();
    for (let i = 0; i < 100; i += 1) probe.ensure();
    clock.advance(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("失败后指数退避（1 秒起翻倍、封顶 30 秒）：一直有人要，请求数也有上界", async () => {
    const clock = manualClock();
    const run = vi.fn(async () => {
      throw new Error("404");
    });
    const probe = createProbe(run, clock.options);
    // 每 10 毫秒有人要一次（重渲染、重挂载），持续 2 分钟。
    for (let tick = 0; tick < 12_000; tick += 1) {
      probe.ensure();
      await flush();
      clock.advance(10);
    }
    // 发起时刻：0、1、3、7、15、31 秒，之后每 30 秒一次：61、91 秒——2 分钟里正好 8 次。
    expect(run).toHaveBeenCalledTimes(8);
    expect(probe.failures).toBe(8);
  });

  it("退避期间有人要：排一次到期再问，不立刻发", async () => {
    const clock = manualClock();
    let fail = true;
    const run = vi.fn(async () => {
      if (fail) throw new Error("offline");
    });
    const probe = createProbe(run, clock.options);
    probe.ensure();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    fail = false;
    probe.ensure();
    probe.ensure();
    expect(clock.pending()).toBe(1);
    clock.advance(999);
    expect(run).toHaveBeenCalledTimes(1);
    clock.advance(1);
    expect(run).toHaveBeenCalledTimes(2);
    await flush();
    expect(probe.failures).toBe(0);
  });

  it("页面隐藏时不问，回到前台再补一次", async () => {
    const clock = manualClock();
    let state = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    const run = vi.fn(async () => undefined);
    const probe = createProbe(run, clock.options);
    probe.ensure();
    clock.advance(5_000);
    expect(run).not.toHaveBeenCalled();
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reset：回到没问过，或当作已经问到", async () => {
    const clock = manualClock();
    const run = vi.fn(async () => {
      throw new Error("x");
    });
    const probe = createProbe(run, clock.options);
    probe.ensure();
    await flush();
    probe.reset();
    probe.ensure();
    expect(run).toHaveBeenCalledTimes(2);
    await flush();
    probe.reset(true);
    probe.ensure();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
