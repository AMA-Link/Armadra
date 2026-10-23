import type { CsrfStore } from "./session";

/**
 * 跨标签页串行化 `auth.refresh`：刷新令牌在 HttpOnly Cookie 里，各标签共用一份，
 * 同时刷新时后到的会带着已轮换的旧令牌，云端判为重放并撤销整台设备（Armadra#516）。
 * 做法：Web Locks 排队；拿到锁后若别的标签在本次请求发出之后已刷新过，就直接复用，
 * 不再提交。刷新成功后经 BroadcastChannel 只广播 CSRF 值与时间戳（不涉及 Cookie）。
 * 没有 Web Locks 时退成本标签内互斥（跨标签仍可能撞上，只是不更糟）。
 */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { signal: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}
export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

export interface RefreshCoordinatorOptions {
  /** 锁与广播频道的名字；控制台与运营各用一个。 */
  readonly name: string;
  readonly csrf: CsrfStore;
  readonly locks?: LockManagerLike | null;
  readonly channel?: ChannelLike | null;
  readonly now?: () => number;
  /** 单次刷新的上限（毫秒）：挂住就抛错并放锁，默认 15000。 */
  readonly refreshTimeoutMs?: number;
  /** 排队等锁的上限（毫秒）：等不到就当这次续不上（答 false），默认 20000。 */
  readonly lockWaitMs?: number;
}

export interface RefreshCoordinator {
  /**
   * @param since 触发本次刷新的请求发出的时间；别的标签在此之后刷新过就不再刷。
   * @param refresh 真正的 `auth.refresh`（成功后其答复里的 csrfToken 已记进 csrf）。
   * @param reuse 额外的复用判断（例如 csrf 已有值）。
   */
  run(
    since: number,
    refresh: () => Promise<void>,
    reuse?: () => boolean,
  ): Promise<boolean>;
}

interface Message {
  readonly csrf: string;
  readonly at: number;
}

const isMessage = (data: unknown): data is Message =>
  typeof data === "object" &&
  data !== null &&
  typeof (data as Message).csrf === "string" &&
  typeof (data as Message).at === "number";

export function createRefreshCoordinator(
  options: RefreshCoordinatorOptions,
): RefreshCoordinator {
  const now = options.now ?? Date.now;
  const lockName = `armadra-cloud-refresh:${options.name}`;
  const locks =
    options.locks !== undefined
      ? options.locks
      : typeof navigator !== "undefined" && "locks" in navigator
        ? (navigator.locks as unknown as LockManagerLike)
        : null;
  const channel =
    options.channel !== undefined
      ? options.channel
      : typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(lockName)
        : null;

  let lastRefreshAt = 0;
  channel?.addEventListener("message", (event) => {
    if (!isMessage(event.data)) return;
    lastRefreshAt = Math.max(lastRefreshAt, event.data.at);
    options.csrf.set(event.data.csrf);
  });

  const refreshTimeoutMs = options.refreshTimeoutMs ?? 15_000;
  const lockWaitMs = options.lockWaitMs ?? 20_000;
  const exclusive = <T>(
    task: () => Promise<T>,
    waitSignal: AbortSignal,
  ): Promise<T> =>
    locks ? locks.request(lockName, { signal: waitSignal }, task) : local(task);
  let tail: Promise<unknown> = Promise.resolve();
  const local = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };

  const bounded = (refresh: () => Promise<void>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("refresh timed out")),
        refreshTimeoutMs,
      );
      refresh().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });

  return {
    run: (since, refresh, reuse) => {
      const waitSignal = AbortSignal.timeout(lockWaitMs);
      return exclusive(async () => {
        if (lastRefreshAt >= since || reuse?.() === true) return true;
        await bounded(refresh);
        lastRefreshAt = now();
        const csrf = options.csrf.get();
        if (csrf !== undefined)
          channel?.postMessage({ csrf, at: lastRefreshAt } satisfies Message);
        return true;
      }, waitSignal).catch((error: unknown) => {
        // 等锁超时：本次续不上，交给调用方按失效处理；其余错误照常抛出。
        if (waitSignal.aborted && (error as Error)?.name === "TimeoutError")
          return false;
        throw error;
      });
    },
  };
}
