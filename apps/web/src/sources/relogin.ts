/**
 * 授予同步的重登去抖（契约 §88.2，设计 saas-host-open §2.3）。
 *
 * `me.stream` 的 `grantChanged` / 自己的 `memberChanged` 要求主机按新断言重新同步
 * 授予，但 `cloud/login` 每分钟 5 次、入口预扣：批量改授予时逐条重登会自己撞 `429`。
 * 所以同一个源的请求合并：首个事件后等 {@link RELOGIN_DELAY_MS} 再发（期间来的并入），
 * 两次重登之间至少隔 {@link RELOGIN_GAP_MS}；正在重登时来的事件只记一笔「完后再来一次」。
 */

export const RELOGIN_DELAY_MS = 2_000;
export const RELOGIN_GAP_MS = 15_000;

export interface ReloginSchedulerOptions {
  /** 真正重登一个源；失败由它自己处理（这里只吞掉，不重试）。 */
  readonly run: (key: string) => Promise<void>;
  readonly delayMs?: number;
  readonly gapMs?: number;
  readonly now?: () => number;
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export interface ReloginScheduler {
  /** 这个源要重登一次（合并进已排着的那一次）。 */
  request(key: string): void;
  dispose(): void;
}

interface Slot {
  timer: unknown;
  running: boolean;
  again: boolean;
  lastAt: number;
}

export function createReloginScheduler(
  options: ReloginSchedulerOptions,
): ReloginScheduler {
  const delay = options.delayMs ?? RELOGIN_DELAY_MS;
  const gap = options.gapMs ?? RELOGIN_GAP_MS;
  const now = options.now ?? Date.now;
  const later =
    options.setTimeout ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const cancel =
    options.clearTimeout ??
    ((handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const slots = new Map<string, Slot>();
  let disposed = false;

  const fire = (key: string, slot: Slot) => {
    slot.timer = null;
    if (disposed) return;
    slot.running = true;
    slot.lastAt = now();
    void options
      .run(key)
      .catch(() => undefined)
      .finally(() => {
        slot.running = false;
        if (slot.again) {
          slot.again = false;
          request(key);
        }
      });
  };

  function request(key: string): void {
    if (disposed) return;
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = {
        timer: null,
        running: false,
        again: false,
        lastAt: Number.NEGATIVE_INFINITY,
      };
      slots.set(key, slot);
    }
    if (slot.running) {
      slot.again = true;
      return;
    }
    if (slot.timer !== null) return;
    const at = Math.max(now() + delay, slot.lastAt + gap);
    const target = slot;
    slot.timer = later(() => fire(key, target), at - now());
  }

  return {
    request,
    dispose() {
      disposed = true;
      for (const slot of slots.values())
        if (slot.timer !== null) cancel(slot.timer);
      slots.clear();
    },
  };
}
