/**
 * 非文件来源的读取调度（设计 §5.1，OpenCode 的 SQLite 用）。
 *
 * 和 {@link TailRunner} 同一套节奏——目录 `fs.watch` 加 100 ms 去抖，监听失败退回
 * 2 s 轮询，hook 响了 {@link POKE_DELAY_MS} 之后读、{@link POKE_SETTLE_MS} 之后补读——
 * 只是「有没有变」由调用方给的指纹说了算（库文件与它的 WAL 的大小和 mtime），
 * 「读什么」由调用方给的 `read` 说了算。读取本身同步、自己处理游标和错误。
 */

import {
  POKE_DELAY_MS,
  POKE_SETTLE_MS,
  POLL_INTERVAL_MS,
  SAFETY_POLL_MS,
  WATCH_DEBOUNCE_MS,
  type TailTimers,
  type WatchFn,
  type WatchHandle,
  fsWatch,
  realTailTimers,
} from "./tailer";
import type { SourceRunner } from "./types";

export interface PollRunnerOptions {
  /** 读一次；抛出的错误交给 `onError`，不会中断调度。 */
  readonly read: () => void;
  /** 变更指纹；`undefined` 表示来源现在不可用（文件还没有）。 */
  readonly fingerprint: () => string | undefined;
  /** 要监听的目录，以及只关心的文件名前缀。 */
  readonly watchDirectory?: string | undefined;
  readonly watchPrefix?: string | undefined;
  readonly onError?: (error: unknown) => void;
  readonly timers?: TailTimers | undefined;
  readonly watch?: WatchFn | undefined;
}

export class PollRunner implements SourceRunner {
  private readonly timers: TailTimers;
  private readonly watchFn: WatchFn;
  private watcher: WatchHandle | undefined;
  private watching = false;
  private watchFailed = false;
  private debounce: unknown;
  private poll: unknown;
  private pokeTimers: unknown[] = [];
  private after: (() => void)[] = [];
  private last: string | undefined;
  private stopped = false;
  private reading = false;
  /** 测试与诊断：已读的次数。 */
  reads = 0;

  constructor(private readonly options: PollRunnerOptions) {
    this.timers = options.timers ?? realTailTimers;
    this.watchFn = options.watch ?? fsWatch;
  }

  get mode(): "watch" | "poll" | "idle" {
    if (this.stopped) return "idle";
    return this.watching ? "watch" : "poll";
  }

  start(): void {
    this.readNow();
  }

  relocate(): void {
    // 会话换了：马上读一次，读取函数自己看线索。
    this.last = undefined;
    this.readNow();
  }

  poke(then?: () => void): void {
    if (this.stopped) return;
    for (const handle of this.pokeTimers) this.timers.clearTimeout(handle);
    this.pokeTimers = [];
    if (then !== undefined) this.after.push(then);
    this.pokeTimers.push(
      this.timers.setTimeout(() => this.readNow(), POKE_DELAY_MS),
      this.timers.setTimeout(() => {
        this.readNow();
        const callbacks = this.after;
        this.after = [];
        for (const callback of callbacks) callback();
      }, POKE_SETTLE_MS),
    );
  }

  readNow(): void {
    if (this.stopped || this.reading) return;
    this.reading = true;
    try {
      this.options.read();
      this.reads++;
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      // 读失败也记下指纹：否则库一直打不开时每 2 s 重试并重复报错，等下一次写入再读。
      this.last = this.options.fingerprint();
      this.reading = false;
      this.arm();
    }
  }

  stop(): void {
    this.stopped = true;
    this.unwatch();
    for (const handle of this.pokeTimers) this.timers.clearTimeout(handle);
    this.pokeTimers = [];
    if (this.debounce !== undefined) this.timers.clearTimeout(this.debounce);
    if (this.poll !== undefined) this.timers.clearTimeout(this.poll);
    this.debounce = undefined;
    this.poll = undefined;
  }

  private arm(): void {
    if (this.stopped) return;
    if (
      !this.watching &&
      !this.watchFailed &&
      this.options.watchDirectory !== undefined
    ) {
      this.tryWatch(this.options.watchDirectory);
    }
    if (this.poll !== undefined) this.timers.clearTimeout(this.poll);
    this.poll = this.timers.setTimeout(
      () => this.onPoll(),
      this.watching ? SAFETY_POLL_MS : POLL_INTERVAL_MS,
    );
  }

  private tryWatch(directory: string): void {
    const prefix = this.options.watchPrefix;
    try {
      this.watcher = this.watchFn(
        directory,
        (filename) => {
          if (prefix !== undefined && filename !== null) {
            if (!filename.startsWith(prefix)) return;
          }
          this.schedule();
        },
        () => {
          this.unwatch();
          this.watchFailed = true;
          this.arm();
        },
      );
      this.watching = true;
    } catch {
      this.watching = false;
      this.watchFailed = true;
    }
  }

  private unwatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.watching = false;
  }

  private schedule(): void {
    if (this.stopped || this.debounce !== undefined) return;
    this.debounce = this.timers.setTimeout(() => {
      this.debounce = undefined;
      this.readNow();
    }, WATCH_DEBOUNCE_MS);
  }

  private onPoll(): void {
    this.poll = undefined;
    if (this.stopped) return;
    const now = this.options.fingerprint();
    if (now !== this.last) this.readNow();
    else this.arm();
  }
}
