/**
 * 转录尾读器（设计 §5.1）：别人的 JSONL 文件，只读、只增量、只读尾部。
 *
 * 两层：
 *
 *   * {@link TranscriptReader}：一个文件、一个游标。`read()` 从游标读到最后一个完整
 *     行，返回这批行和新的游标；第一次（没有游标）只从尾部 {@link TAIL_BYTES} 开始，
 *     更早的内容按需导入；文件被换掉（inode 或开头指纹变了）或被截短（比游标还小）
 *     时回到尾部窗口重来。不解析 JSON、不认识任何一家 CLI。
 *   * {@link TailRunner}：什么时候读。目录 `fs.watch` 加 100 ms 去抖；watch 失败或
 *     出错退回 2 s 的 stat 轮询（只比较大小和 mtime）；hook 一响就 `poke()`，
 *     {@link POKE_DELAY_MS} 之后读一次，再补读一次（CLI 的写盘可能晚于它的 hook）。
 *
 * 各家 CLI 的差异全在适配器里（`claude.ts`、`codex.ts`，B4b 加 `opencode.ts` 等）：
 * 它们只要交出「一行 JSON → 条目」的转换器，读多少、何时读、游标怎么存都在这里。
 */

import { createHash } from "node:crypto";
import {
  type FSWatcher,
  closeSync,
  openSync,
  readSync,
  statSync,
  watch,
} from "node:fs";
import { basename, dirname } from "node:path";

/** 第一次接管只读文件尾部这么多字节。 */
export const TAIL_BYTES = 2 * 1024 * 1024;
/** 一次最多读这么多字节；一行比它还长（内嵌大图）就整行跳过。 */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** 文件开头这么多字节做指纹，判断文件是不是被换掉了。 */
const FINGERPRINT_BYTES = 256;

export const WATCH_DEBOUNCE_MS = 100;
export const POLL_INTERVAL_MS = 2_000;
/** watch 正常时的兜底：网络盘等不发事件的地方也不会永远不读。 */
export const SAFETY_POLL_MS = 15_000;
/** hook 响了以后等多久读（让 CLI 把那一行写完）。 */
export const POKE_DELAY_MS = 20;
/** 再补读一次的间隔。 */
export const POKE_SETTLE_MS = 300;
/** 路径还没定位到时，多久重试一次。 */
export const LOCATE_RETRY_MS = 5_000;

/* --------------------------------- 游标 --------------------------------- */

/** 存在时间线行 `source_cursor` 里（≤ 2048 字符）的续读位置。 */
export interface TailCursor {
  readonly path: string;
  /** 下一个要读的字节；总是落在行首。 */
  readonly offset: number;
  readonly ino: number;
  /** 文件开头 `fpLen` 字节的摘要。 */
  readonly fp: string;
  readonly fpLen: number;
}

export function encodeCursor(cursor: TailCursor): string {
  return JSON.stringify({ v: 1, ...cursor });
}

export function decodeCursor(text: string): TailCursor | undefined {
  if (text === "") return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      value.v !== 1 ||
      typeof value.path !== "string" ||
      typeof value.offset !== "number" ||
      typeof value.ino !== "number" ||
      typeof value.fp !== "string" ||
      typeof value.fpLen !== "number"
    ) {
      return undefined;
    }
    return {
      path: value.path,
      offset: value.offset,
      ino: value.ino,
      fp: value.fp,
      fpLen: value.fpLen,
    };
  } catch {
    return undefined;
  }
}

/* --------------------------------- 读文件 --------------------------------- */

export type ReadReset = "first" | "rotated" | "truncated";

export interface ReadResult {
  /** 读到的完整行（不含换行，已去掉空行）。 */
  readonly lines: string[];
  readonly cursor: TailCursor | undefined;
  /** 这一次不是接着游标读的：第一次、换了文件、被截短。 */
  readonly reset?: ReadReset;
  /** 因为一行太长而跳过的字节数。 */
  readonly skippedBytes: number;
}

function readBytes(
  path: string,
  start: number,
  length: number,
): Buffer<ArrayBuffer> {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const read = readSync(
        handle,
        buffer,
        filled,
        length - filled,
        start + filled,
      );
      if (read === 0) break;
      filled += read;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  } finally {
    closeSync(handle);
  }
}

function fingerprint(
  path: string,
  size: number,
): { fp: string; fpLen: number } {
  const fpLen = Math.min(size, FINGERPRINT_BYTES);
  const head = fpLen === 0 ? Buffer.alloc(0) : readBytes(path, 0, fpLen);
  return {
    fp: createHash("sha1").update(head).digest("hex").slice(0, 16),
    fpLen: head.length,
  };
}

export interface ReaderOptions {
  readonly tailBytes?: number;
  readonly maxChunkBytes?: number;
}

/**
 * 读一次。文件不存在或读不了时答「没有新行、游标不变」，由调用方下次再试。
 *
 * 游标只前进到最后一个换行之后：半行（CLI 正写到一半）留到下次，所以不会把
 * 一行切成两半解析。
 */
export function readTranscript(
  path: string,
  cursor: TailCursor | undefined,
  options: ReaderOptions = {},
): ReadResult {
  const tailBytes = options.tailBytes ?? TAIL_BYTES;
  const maxChunk = options.maxChunkBytes ?? MAX_CHUNK_BYTES;
  let size: number;
  let ino: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { lines: [], cursor, skippedBytes: 0 };
    size = stat.size;
    ino = stat.ino;
  } catch {
    return { lines: [], cursor, skippedBytes: 0 };
  }

  let start: number;
  let reset: ReadReset | undefined;
  let print: { fp: string; fpLen: number };
  try {
    print = fingerprint(path, size);
    if (cursor === undefined || cursor.path !== path) {
      reset = "first";
      start = Math.max(0, size - tailBytes);
    } else if (
      size < cursor.offset ||
      size < cursor.fpLen ||
      cursor.ino !== ino ||
      fingerprint(path, cursor.fpLen).fp !== cursor.fp
    ) {
      // 被截短（比游标还小）或被换掉（inode 变了、开头不是原来的开头）。
      reset =
        size < cursor.offset && cursor.ino === ino ? "truncated" : "rotated";
      start = Math.max(0, size - tailBytes);
    } else {
      start = cursor.offset;
    }
  } catch {
    return { lines: [], cursor, skippedBytes: 0 };
  }

  // 从中间开始（尾部窗口）时，第一行很可能是半行：丢到第一个换行为止。
  let skip = 0;
  if (reset !== undefined && start > 0) {
    const probe = readBytes(path, start - 1, 1);
    if (probe[0] !== 0x0a) {
      const window = readBytes(path, start, Math.min(size - start, maxChunk));
      const newline = window.indexOf(0x0a);
      if (newline === -1) {
        return {
          lines: [],
          cursor: { path, offset: size, ino, ...print },
          reset,
          skippedBytes: size - start,
        };
      }
      skip = newline + 1;
    }
  }
  const from = start + skip;
  const length = Math.min(size - from, maxChunk);
  if (length <= 0) {
    return {
      lines: [],
      cursor: { path, offset: from, ino, ...print },
      ...(reset !== undefined ? { reset } : {}),
      skippedBytes: skip,
    };
  }
  const buffer = readBytes(path, from, length);
  const lastNewline = buffer.lastIndexOf(0x0a);
  let consumed: number;
  let skipped = skip;
  if (lastNewline === -1) {
    // 整块里没有换行：要么是正在写的半行（等），要么是比上限还长的一行（跳过）。
    if (buffer.length >= maxChunk) {
      consumed = buffer.length;
      skipped += consumed;
    } else {
      return {
        lines: [],
        cursor: { path, offset: from, ino, ...print },
        ...(reset !== undefined ? { reset } : {}),
        skippedBytes: skip,
      };
    }
  } else {
    consumed = lastNewline + 1;
  }
  const text =
    lastNewline === -1 ? "" : buffer.subarray(0, consumed).toString("utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return {
    lines,
    cursor: { path, offset: from + consumed, ino, ...print },
    ...(reset !== undefined ? { reset } : {}),
    skippedBytes: skipped,
  };
}

/* --------------------------------- 调度 --------------------------------- */

export interface TailTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTailTimers: TailTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // 读调度不该拖住进程退出。
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface WatchHandle {
  close(): void;
}

/** 监听一个目录；出错通过 `onError` 报，调用方据此退回轮询。 */
export type WatchFn = (
  directory: string,
  onEvent: (filename: string | null) => void,
  onError: (error: unknown) => void,
) => WatchHandle;

export const fsWatch: WatchFn = (directory, onEvent, onError) => {
  const watcher: FSWatcher = watch(directory, (_event, filename) =>
    onEvent(filename === null ? null : String(filename)),
  );
  watcher.on("error", onError);
  return { close: () => watcher.close() };
};

export type StatFn = (
  path: string,
) => { size: number; mtimeMs: number } | undefined;

export const fsStat: StatFn = (path) => {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
};

export interface TailRunnerOptions {
  /** 找转录文件；找不到答 `undefined`，稍后再试。 */
  readonly locate: () => string | undefined;
  readonly initialCursor?: TailCursor | undefined;
  /** 读到一批行：游标已经算好，处理完以后调用方负责存。 */
  readonly onRead: (result: ReadResult, path: string) => void;
  readonly timers?: TailTimers;
  readonly watch?: WatchFn;
  readonly stat?: StatFn;
  readonly read?: ReaderOptions;
  readonly onError?: (error: unknown) => void;
}

/** 一个转录的读取调度。 */
export class TailRunner {
  private readonly timers: TailTimers;
  private readonly watchFn: WatchFn;
  private readonly statFn: StatFn;
  private cursor: TailCursor | undefined;
  private path: string | undefined;
  private watcher: WatchHandle | undefined;
  private watching = false;
  private debounce: unknown;
  private poll: unknown;
  private pokeTimers: unknown[] = [];
  private lastSeen: { size: number; mtimeMs: number } | undefined;
  private lastLocateAt = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private reading = false;
  private after: (() => void)[] = [];
  /** 测试与诊断：已读的次数、当前是轮询还是监听。 */
  reads = 0;

  constructor(private readonly options: TailRunnerOptions) {
    this.timers = options.timers ?? realTailTimers;
    this.watchFn = options.watch ?? fsWatch;
    this.statFn = options.stat ?? fsStat;
    this.cursor = options.initialCursor;
  }

  get mode(): "watch" | "poll" | "idle" {
    if (this.stopped || this.path === undefined) return "idle";
    return this.watching ? "watch" : "poll";
  }

  get currentCursor(): TailCursor | undefined {
    return this.cursor;
  }

  get currentPath(): string | undefined {
    return this.path;
  }

  /** 开始：先读一次，然后挂 watch（或轮询）。 */
  start(): void {
    this.readNow();
  }

  /**
   * hook 响了：{@link POKE_DELAY_MS} 之后读一次，{@link POKE_SETTLE_MS} 之后再补读一次，
   * `then` 在补读之后调（收尾回合用）。
   */
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

  /** 立刻读一次（同步）。 */
  readNow(): void {
    if (this.stopped || this.reading) return;
    this.reading = true;
    try {
      this.ensurePath();
      const path = this.path;
      if (path !== undefined) {
        const result = readTranscript(path, this.cursor, this.options.read);
        this.reads++;
        this.cursor = result.cursor ?? this.cursor;
        this.lastSeen = this.statFn(path);
        if (
          result.lines.length > 0 ||
          result.reset !== undefined ||
          result.skippedBytes > 0
        ) {
          this.options.onRead(result, path);
        }
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.reading = false;
      this.arm();
    }
  }

  /** 路径可能换了（hook 报来新的转录）：下一次读之前重新定位。 */
  relocate(): void {
    this.relocateRequested = true;
  }

  private relocateRequested = false;

  private ensurePath(): void {
    const now = this.timers.now();
    // 有路径、文件也在、没人要求重找：不再定位（Codex 的定位要扫目录）。
    if (
      this.path !== undefined &&
      !this.relocateRequested &&
      this.statFn(this.path) !== undefined
    ) {
      return;
    }
    if (!this.relocateRequested && now - this.lastLocateAt < LOCATE_RETRY_MS) {
      return;
    }
    this.lastLocateAt = now;
    this.relocateRequested = false;
    const located = this.options.locate();
    if (located !== undefined && located !== this.path) {
      this.unwatch();
      this.path = located;
      this.lastSeen = undefined;
    }
  }

  /** 挂监听（失败退回轮询）并安排下一次兜底。 */
  private arm(): void {
    if (this.stopped) return;
    if (
      this.path !== undefined &&
      this.watcher === undefined &&
      !this.watching &&
      !this.watchFailed
    ) {
      this.tryWatch(this.path);
    }
    if (this.poll !== undefined) this.timers.clearTimeout(this.poll);
    const interval =
      this.path === undefined
        ? LOCATE_RETRY_MS
        : this.watching
          ? SAFETY_POLL_MS
          : POLL_INTERVAL_MS;
    this.poll = this.timers.setTimeout(() => this.onPoll(), interval);
  }

  private tryWatch(path: string): void {
    try {
      const name = basename(path);
      this.watcher = this.watchFn(
        dirname(path),
        (filename) => {
          if (filename !== null && filename !== name) return;
          this.schedule();
        },
        () => {
          // 监听出错：退回轮询，下一轮 `arm` 不再尝试挂监听。
          this.unwatch();
          this.watching = false;
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

  private watchFailed = false;

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
    const path = this.path;
    if (path === undefined) {
      this.readNow();
      return;
    }
    if (this.watching) {
      // 兜底：监听没发事件也看一眼文件有没有长。
      const now = this.statFn(path);
      if (!sameStat(now, this.lastSeen)) this.readNow();
      else this.arm();
      return;
    }
    const now = this.statFn(path);
    if (!sameStat(now, this.lastSeen)) this.readNow();
    else {
      this.ensurePath();
      this.arm();
    }
  }

  /** 监听是否已经确认失败（测试用）。 */
  get pollingFallback(): boolean {
    return this.watchFailed;
  }
}

function sameStat(
  a: { size: number; mtimeMs: number } | undefined,
  b: { size: number; mtimeMs: number } | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}
