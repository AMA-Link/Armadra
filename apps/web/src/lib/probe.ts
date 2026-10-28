import { backoffCeiling } from "./backoff";

/**
 * 「问到为止」的一次性探测（`/api/health` 一类：core 起来之后答案不变）。
 *
 * 三条约束，都是为了背后没有 core（配错的反向代理、控制面上的页面）时不变成
 * 对服务端的高频请求：
 *
 *  - 同一时刻只有一次在途，问到了就再也不问；
 *  - 失败之后按指数退避才再问：1 秒起翻倍，封顶 30 秒（`lib/backoff.ts` 的上限，
 *    不抖动——一页只有一个探测，没有一起撞回来的问题）；退避期间又有人要，
 *    排一次到期再问，不立刻发；
 *  - 页面隐藏时不问，回到前台再补。
 *
 * 失败之后没人再要就不再问（「下次用到时再问」）：探测不是轮询。
 */
export interface Probe {
  /** 要答案：没问到、不在途、不在退避里、页面可见时才发一次。 */
  ensure(): void;
  /** 测试用：回到还没问过（`settled` 为真则当作已经问到）。 */
  reset(settled?: boolean): void;
  /** 连续失败了几次（问到后归零）。 */
  readonly failures: number;
}

export interface ProbeOptions {
  /** 第一次失败后的等待（毫秒），默认 1 秒。 */
  readonly baseMs?: number;
  /** 等待的封顶（毫秒），默认 30 秒。 */
  readonly capMs?: number;
  readonly now?: () => number;
}

export const PROBE_BASE_MS = 1_000;
export const PROBE_CAP_MS = 30_000;

function pageHidden(): boolean {
  return globalThis.document?.visibilityState === "hidden";
}

export function createProbe(
  run: () => Promise<void>,
  options: ProbeOptions = {},
): Probe {
  const baseMs = options.baseMs ?? PROBE_BASE_MS;
  const capMs = options.capMs ?? PROBE_CAP_MS;
  const now = options.now ?? (() => Date.now());
  let state: "idle" | "inflight" | "done" = "idle";
  let failures = 0;
  let retryAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waitingVisible = false;

  const onVisible = () => {
    if (pageHidden()) return;
    stopWaitingVisible();
    ensure();
  };

  function stopWaitingVisible(): void {
    if (!waitingVisible) return;
    waitingVisible = false;
    globalThis.document?.removeEventListener("visibilitychange", onVisible);
  }

  function ensure(): void {
    if (state !== "idle") return;
    if (pageHidden()) {
      if (!waitingVisible && globalThis.document) {
        waitingVisible = true;
        globalThis.document.addEventListener("visibilitychange", onVisible);
      }
      return;
    }
    const wait = retryAt - now();
    if (wait > 0) {
      timer ??= setTimeout(() => {
        timer = null;
        ensure();
      }, wait);
      return;
    }
    state = "inflight";
    let pending: Promise<void>;
    try {
      pending = run();
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      () => {
        state = "done";
        failures = 0;
        retryAt = 0;
      },
      () => {
        state = "idle";
        retryAt = now() + backoffCeiling(failures, { baseMs, capMs });
        failures += 1;
      },
    );
  }

  return {
    ensure,
    reset(settled = false) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      stopWaitingVisible();
      state = settled ? "done" : "idle";
      failures = 0;
      retryAt = 0;
    },
    get failures() {
      return failures;
    },
  };
}
