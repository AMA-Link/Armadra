import { describe, expect, it, vi } from "vitest";

import {
  DevicePoller,
  type DevicePollStep,
  MAX_BACKOFF_MS,
  MIN_GAP_MS,
} from "./device-poll";

/** 手动拨的时钟：计时器只在 `advance` 时到点，`now` 随之前进。 */
function clock() {
  let time = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => time,
    setTimer: (run: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: time + ms, run });
      return id;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    pending: () => [...timers.values()].map((timer) => timer.at - time),
    async advance(ms: number) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].run();
        await Promise.resolve();
        await Promise.resolve();
      }
      time = target;
    },
  };
}

function setup(
  steps: Array<DevicePollStep<string> | Error>,
  intervalMs = 5_000,
) {
  const time = clock();
  const queue = [...steps];
  const poll = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) return { kind: "pending" } as const;
    if (next instanceof Error) throw next;
    return next;
  });
  const onSettled = vi.fn();
  const onError = vi.fn();
  const poller = new DevicePoller<string>({
    poll,
    intervalMs,
    onSettled,
    onError,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  return { time, poll, onSettled, onError, poller };
}

describe("设备码轮询状态机", () => {
  it("按服务端给的间隔轮询，pending 一直等；批准即终结并停下", async () => {
    const { time, poll, onSettled, poller } = setup([
      { kind: "pending" },
      { kind: "pending" },
      { kind: "settled", value: "approved" },
    ]);
    poller.start();
    expect(poll).not.toHaveBeenCalled();
    await time.advance(4_999);
    expect(poll).not.toHaveBeenCalled();
    await time.advance(1);
    expect(poll).toHaveBeenCalledTimes(1);
    await time.advance(5_000);
    expect(poll).toHaveBeenCalledTimes(2);
    await time.advance(5_000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(onSettled).toHaveBeenCalledWith("approved");
    await time.advance(60_000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(time.pending()).toEqual([]);
  });

  it("拒绝与过期同样是终结的答案，只交付一次", async () => {
    for (const value of ["denied", "expired"]) {
      const { time, onSettled, poller } = setup([{ kind: "settled", value }]);
      poller.start();
      await time.advance(5_000);
      await time.advance(60_000);
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(value);
    }
  });

  it("被限流就退避：翻倍到上限、不早于对端的 retryAfter；恢复后回到正常间隔", async () => {
    const { time, poll, poller } = setup([
      { kind: "retry", afterMs: 0 },
      { kind: "retry", afterMs: 0 },
      { kind: "retry", afterMs: 40_000 },
      { kind: "pending" },
    ]);
    poller.start();
    await time.advance(5_000);
    expect(poll).toHaveBeenCalledTimes(1);
    // 第一次被限流：翻倍 = 10 秒。
    expect(time.pending()).toEqual([10_000]);
    await time.advance(10_000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(time.pending()).toEqual([20_000]);
    await time.advance(20_000);
    expect(poll).toHaveBeenCalledTimes(3);
    // 对端要等 40 秒：听对端的，不被 30 秒的上限截断。
    expect(time.pending()).toEqual([40_000]);
    await time.advance(40_000);
    expect(poll).toHaveBeenCalledTimes(4);
    // pending：退避清零，回到 5 秒。
    expect(time.pending()).toEqual([5_000]);
    expect(MAX_BACKOFF_MS).toBe(30_000);
  });

  it("退避封顶 30 秒", async () => {
    const { time, poller } = setup(
      Array.from({ length: 6 }, () => ({ kind: "retry", afterMs: 0 }) as const),
    );
    poller.start();
    let last = 0;
    await time.advance(5_000);
    for (let index = 0; index < 5; index += 1) {
      last = time.pending()[0]!;
      await time.advance(last);
    }
    expect(last).toBe(MAX_BACKOFF_MS);
    expect(time.pending()).toEqual([MAX_BACKOFF_MS]);
  });

  it("取消：排好的下一次作废，在途的一次返回后也不再交付", async () => {
    const first = setup([{ kind: "pending" }]);
    first.poller.start();
    first.poller.stop();
    await first.time.advance(60_000);
    expect(first.poll).not.toHaveBeenCalled();

    let release: (step: DevicePollStep<string>) => void = () => undefined;
    const time = clock();
    const onSettled = vi.fn();
    const poller = new DevicePoller<string>({
      poll: () => new Promise((resolve) => (release = resolve)),
      intervalMs: 5_000,
      onSettled,
      onError: vi.fn(),
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    poller.start();
    await time.advance(5_000);
    poller.stop();
    release({ kind: "settled", value: "approved" });
    await Promise.resolve();
    await Promise.resolve();
    expect(onSettled).not.toHaveBeenCalled();
    expect(time.pending()).toEqual([]);
  });

  it("回到前台立即补一次，排好的下一次改由这一次的结果重排", async () => {
    const { time, poll, onSettled, poller } = setup([
      { kind: "pending" },
      { kind: "settled", value: "approved" },
    ]);
    poller.start();
    await time.advance(5_000);
    expect(poll).toHaveBeenCalledTimes(1);
    await time.advance(3_000);
    poller.pollNow();
    await Promise.resolve();
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledWith("approved");
    expect(time.pending()).toEqual([]);
  });

  it("补一次不会与刚发出的一次挤在一起，也不会在途时重复，停了更不会", async () => {
    const { time, poll, poller } = setup([{ kind: "pending" }]);
    poller.start();
    await time.advance(5_000);
    expect(poll).toHaveBeenCalledTimes(1);
    // 刚问过（不足 MIN_GAP_MS）：不重复。
    poller.pollNow();
    expect(poll).toHaveBeenCalledTimes(1);
    await time.advance(MIN_GAP_MS);
    poller.pollNow();
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);

    const stopped = setup([]);
    stopped.poller.start();
    stopped.poller.stop();
    stopped.poller.pollNow();
    expect(stopped.poll).not.toHaveBeenCalled();
  });

  it("轮询抛出意外：交给 onError 并停下，不无限重试", async () => {
    const { time, poll, onError, poller } = setup([new Error("boom")]);
    poller.start();
    await time.advance(5_000);
    expect(onError).toHaveBeenCalledTimes(1);
    await time.advance(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("在途状态：开始问 true、答复回来 false，界面据此显示「正在确认」", async () => {
    const time = clock();
    const busy: boolean[] = [];
    let release: (step: DevicePollStep<string>) => void = () => undefined;
    const poller = new DevicePoller<string>({
      poll: () => new Promise((resolve) => (release = resolve)),
      intervalMs: 5_000,
      onSettled: vi.fn(),
      onError: vi.fn(),
      onBusyChange: (value) => busy.push(value),
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    poller.start();
    expect(poller.busy).toBe(false);
    await time.advance(5_000);
    expect(poller.busy).toBe(true);
    expect(busy).toEqual([true]);
    release({ kind: "pending" });
    await time.advance(0);
    expect(poller.busy).toBe(false);
    expect(busy).toEqual([true, false]);
  });

  it("在途状态：抛出意外与终结答案同样先落回 false", async () => {
    const busy: boolean[] = [];
    const time = clock();
    const poller = new DevicePoller<string>({
      poll: async () => {
        throw new Error("boom");
      },
      intervalMs: 5_000,
      onSettled: vi.fn(),
      onError: vi.fn(),
      onBusyChange: (value) => busy.push(value),
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    poller.start();
    await time.advance(5_000);
    expect(busy).toEqual([true, false]);
  });

  it("urgent：不受最小间隔限制；在途时那一次答 pending 后立刻再问，答 settled 就不再问", async () => {
    const time = clock();
    const releases: Array<(step: DevicePollStep<string>) => void> = [];
    const poll = vi.fn(
      () => new Promise<DevicePollStep<string>>((r) => releases.push(r)),
    );
    const onSettled = vi.fn();
    const poller = new DevicePoller<string>({
      poll,
      intervalMs: 5_000,
      onSettled,
      onError: vi.fn(),
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    poller.start();
    await time.advance(5_000);
    expect(poll).toHaveBeenCalledTimes(1);
    // 普通补一次在途时被忽略；urgent 记下，等这一次答完再问。
    poller.pollNow();
    await time.advance(0);
    expect(poll).toHaveBeenCalledTimes(1);
    poller.pollNow(true);
    releases[0]!({ kind: "pending" });
    await time.advance(0);
    expect(poll).toHaveBeenCalledTimes(2);
    // 刚发出（MIN_GAP 内）也照样 urgent。
    poller.pollNow(true);
    releases[1]!({ kind: "settled", value: "ok" });
    await time.advance(0);
    expect(onSettled).toHaveBeenCalledWith("ok");
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("urgent 空闲时直接问，且不受刚发出一次的最小间隔限制", async () => {
    const { time, poll, poller } = setup([
      { kind: "pending" },
      { kind: "pending" },
    ]);
    poller.start();
    await time.advance(5_000);
    expect(poll).toHaveBeenCalledTimes(1);
    await time.advance(MIN_GAP_MS - 1);
    poller.pollNow();
    expect(poll).toHaveBeenCalledTimes(1);
    poller.pollNow(true);
    await time.advance(0);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});
