import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProbe } from "./probe";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

describe("createProbe（#581）", () => {
  it("同一时刻只有一次在途；问到之后再也不问", async () => {
    let land!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (land = resolve)));
    const probe = createProbe(run);
    for (let i = 0; i < 100; i += 1) probe.ensure();
    expect(run).toHaveBeenCalledTimes(1);
    land();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 100; i += 1) probe.ensure();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("失败后指数退避（1 秒起翻倍、封顶 30 秒）：一直有人要，请求数也有上界", async () => {
    const run = vi.fn(async () => {
      throw new Error("404");
    });
    const probe = createProbe(run);
    // 每 10 毫秒有人要一次（重渲染、重挂载），持续 2 分钟。
    for (let tick = 0; tick < 12_000; tick += 1) {
      probe.ensure();
      await vi.advanceTimersByTimeAsync(10);
    }
    // 1+2+4+8+16 = 31 秒后每 30 秒一次：2 分钟里约 9 次；不退避是 12 000 次。
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(run.mock.calls.length).toBeLessThanOrEqual(10);
    expect(probe.failures).toBe(run.mock.calls.length);
  });

  it("退避期间有人要：排一次到期再问，不立刻发", async () => {
    let fail = true;
    const run = vi.fn(async () => {
      if (fail) throw new Error("offline");
    });
    const probe = createProbe(run);
    probe.ensure();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    fail = false;
    probe.ensure();
    probe.ensure();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(probe.failures).toBe(0);
  });

  it("页面隐藏时不问，回到前台再补一次", async () => {
    let state = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    const run = vi.fn(async () => undefined);
    const probe = createProbe(run);
    probe.ensure();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reset：回到没问过，或当作已经问到", async () => {
    const run = vi.fn(async () => {
      throw new Error("x");
    });
    const probe = createProbe(run);
    probe.ensure();
    await vi.advanceTimersByTimeAsync(0);
    probe.reset();
    probe.ensure();
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    probe.reset(true);
    probe.ensure();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
