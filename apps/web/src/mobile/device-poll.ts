/**
 * 设备码登录的轮询状态机（cloud 设计 §11.5：间隔 5 秒，问得太快答 `rate_limited`）。
 *
 * 只管「什么时候再问一次」：按服务端给的间隔排下一次；被限流就退避（翻倍，封顶
 * {@link MAX_BACKOFF_MS}，不早于对端给的 `retryAfterMs`）；App 回到前台时立即补一次
 * （{@link DevicePoller.pollNow}）。问什么、怎么存会话由 `connect.ts` 的
 * `pollDevice` 决定，这里只认它的答案。计时器与时钟可注入，测试不用真等。
 */

/** 一次轮询的答案：`pending` 继续等；`retry` 稍后再问（限流 / 暂时连不上）；`settled` 终结。 */
export type DevicePollStep<T> =
  | { readonly kind: "pending" }
  | { readonly kind: "retry"; readonly afterMs: number }
  | { readonly kind: "settled"; readonly value: T };

/** 被限流后退避的上限。 */
export const MAX_BACKOFF_MS = 30_000;
/** 两次轮询之间至少隔多久：回前台补一次时避免与刚发出的一次挤在一起。 */
export const MIN_GAP_MS = 1_000;

export interface DevicePollerDeps<T> {
  /** 问一次；只在这里抛的意外会被当作终结前的最后一次失败交给 `onError`。 */
  readonly poll: () => Promise<DevicePollStep<T>>;
  readonly intervalMs: number;
  readonly onSettled: (value: T) => void;
  readonly onError: (error: unknown) => void;
  /**
   * 在途状态变化（开始问 → `true`，答复回来 → `false`）：界面据此显示「正在确认」，并在这期间
   * 不让人重新获取设备码或取消——此时作废设备码会丢掉刚批准的结果（#666）。
   */
  readonly onBusyChange?: (busy: boolean) => void;
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export class DevicePoller<T> {
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown = null;
  private inFlight = false;
  private stopped = true;
  private lastAtMs = Number.NEGATIVE_INFINITY;
  private backoffMs = 0;
  /** 在途时收到「立刻问」（`urgent`）：这一次答 `pending` 后马上再问一次。 */
  private again = false;

  constructor(private readonly deps: DevicePollerDeps<T>) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer =
      deps.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** 正有一次在问。 */
  get busy(): boolean {
    return this.inFlight;
  }

  /** 开始：第一次在一个间隔之后（刚发起，人还在浏览器里）。 */
  start(): void {
    this.stopped = false;
    this.again = false;
    this.schedule(this.deps.intervalMs);
  }

  /** 停：取消排好的下一次；在途的一次返回后也不再处理。 */
  stop(): void {
    this.stopped = true;
    this.again = false;
    this.cancelTimer();
  }

  /**
   * 立即补一次（App 回到前台）。已经停了、正有一次在途、或上一次刚发出（
   * {@link MIN_GAP_MS} 内）都不重复问；排好的下一次改由这一次的结果重新排。
   *
   * `urgent`：确知刚发生了值得问的事（浏览器里批准后深链回来，#666）。不受
   * {@link MIN_GAP_MS} 限制；正有一次在途时，那一次答 `pending` 后立刻再问一次——
   * 在途的那一次可能发在批准之前。
   */
  pollNow(urgent = false): void {
    if (this.stopped) return;
    if (this.inFlight) {
      if (urgent) this.again = true;
      return;
    }
    if (!urgent && this.now() - this.lastAtMs < MIN_GAP_MS) return;
    this.cancelTimer();
    void this.tick();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    this.lastAtMs = this.now();
    this.deps.onBusyChange?.(true);
    let step: DevicePollStep<T>;
    try {
      step = await this.deps.poll();
    } catch (error) {
      this.inFlight = false;
      this.deps.onBusyChange?.(false);
      if (this.stopped) return;
      this.stopped = true;
      this.deps.onError(error);
      return;
    }
    this.inFlight = false;
    this.deps.onBusyChange?.(false);
    if (this.stopped) return;
    if (step.kind === "settled") {
      this.stopped = true;
      this.deps.onSettled(step.value);
      return;
    }
    const again = this.again;
    this.again = false;
    if (step.kind === "pending") {
      this.backoffMs = 0;
      if (again) void this.tick();
      else this.schedule(this.deps.intervalMs);
      return;
    }
    // 退避：连续被限流则翻倍；不早于对端要求的时刻，也不短于正常间隔。
    this.backoffMs = Math.min(
      MAX_BACKOFF_MS,
      this.backoffMs === 0 ? this.deps.intervalMs * 2 : this.backoffMs * 2,
    );
    this.schedule(Math.max(step.afterMs, this.backoffMs));
  }
}
