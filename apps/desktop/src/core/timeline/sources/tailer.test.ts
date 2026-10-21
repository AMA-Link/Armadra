import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeTimers } from "../testing";
import {
  POKE_SETTLE_MS,
  POLL_INTERVAL_MS,
  type ReadResult,
  TAIL_BYTES,
  type TailCursor,
  type WatchHandle,
  TailRunner,
  decodeCursor,
  encodeCursor,
  readTranscript,
} from "./tailer";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "armadra-tail-"));
  file = join(dir, "t.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (n: number) => JSON.stringify({ n }) + "\n";

describe("readTranscript", () => {
  it("reads from the cursor without repeating or dropping lines", () => {
    writeFileSync(file, row(1) + row(2));
    const first = readTranscript(file, undefined);
    expect(first.reset).toBe("first");
    expect(first.lines.map((l) => JSON.parse(l).n)).toEqual([1, 2]);

    appendFileSync(file, row(3));
    const second = readTranscript(file, first.cursor);
    expect(second.reset).toBeUndefined();
    expect(second.lines.map((l) => JSON.parse(l).n)).toEqual([3]);

    const idle = readTranscript(file, second.cursor);
    expect(idle.lines).toEqual([]);
    expect(idle.cursor?.offset).toBe(second.cursor?.offset);
  });

  it("holds a half-written line back until its newline arrives", () => {
    writeFileSync(file, row(1) + '{"n":2');
    const a = readTranscript(file, undefined);
    expect(a.lines).toHaveLength(1);
    appendFileSync(file, "}\n" + row(3));
    const b = readTranscript(file, a.cursor);
    expect(b.lines.map((l) => JSON.parse(l).n)).toEqual([2, 3]);
  });

  it("starts a first takeover in the tail window, past the cut line", () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(i)).join("");
    writeFileSync(file, rows);
    const result = readTranscript(file, undefined, { tailBytes: 200 });
    expect(result.lines.length).toBeGreaterThan(5);
    expect(result.lines.length).toBeLessThan(40);
    // 每一行都是完整的 JSON，最后一行是文件的最后一行。
    for (const line of result.lines)
      expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(result.lines.at(-1) as string).n).toBe(199);
    expect(TAIL_BYTES).toBe(2 * 1024 * 1024);
  });

  it("restarts in the tail window when the file shrank", () => {
    writeFileSync(file, row(1) + row(2) + row(3));
    const a = readTranscript(file, undefined);
    truncateSync(file, 0);
    writeFileSync(file, row(9));
    const b = readTranscript(file, a.cursor);
    expect(b.reset).toBe("truncated");
    expect(b.lines.map((l) => JSON.parse(l).n)).toEqual([9]);
  });

  it("notices a replaced file even when it is longer than the old offset", () => {
    writeFileSync(file, row(1) + row(2));
    const a = readTranscript(file, undefined);
    renameSync(file, join(dir, "old.jsonl"));
    writeFileSync(file, row(7) + row(8) + row(9) + row(10));
    const b = readTranscript(file, a.cursor);
    expect(b.reset).toBe("rotated");
    expect(b.lines.map((l) => JSON.parse(l).n)).toEqual([7, 8, 9, 10]);
  });

  it("skips a line longer than the chunk limit and carries on after it", () => {
    writeFileSync(file, "x".repeat(300) + "\n" + row(5));
    const result = readTranscript(file, undefined, { maxChunkBytes: 100 });
    // 第一块里没有换行、又塞满了上限：整块跳过，不卡住。
    expect(result.lines).toEqual([]);
    expect(result.skippedBytes).toBeGreaterThan(0);
    let cursor = result.cursor;
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      const next = readTranscript(file, cursor, { maxChunkBytes: 100 });
      seen.push(...next.lines.map((l) => JSON.parse(l).n));
      cursor = next.cursor;
    }
    expect(seen).toEqual([5]);
  });

  it("answers quietly for a file that is not there", () => {
    const result = readTranscript(join(dir, "missing.jsonl"), undefined);
    expect(result.lines).toEqual([]);
    expect(result.cursor).toBeUndefined();
  });

  it("round-trips the cursor through its stored text", () => {
    writeFileSync(file, row(1));
    const cursor = readTranscript(file, undefined).cursor as TailCursor;
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(encodeCursor(cursor).length).toBeLessThan(2048);
    expect(decodeCursor("not json")).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
  });
});

/** 假监听：测试自己触发事件或报错。 */
function fakeWatch() {
  const state = {
    emit: (_name: string | null) => {},
    fail: (_error: unknown) => {},
    opened: 0,
    refuse: false,
  };
  const watch = (
    _dir: string,
    onEvent: (name: string | null) => void,
    onError: (error: unknown) => void,
  ): WatchHandle => {
    if (state.refuse) throw new Error("no watch here");
    state.opened++;
    state.emit = onEvent;
    state.fail = onError;
    return { close: () => {} };
  };
  return { state, watch };
}

function runnerOn(
  timers: FakeTimers,
  watch: ReturnType<typeof fakeWatch>,
  into: ReadResult[],
  locate: () => string | undefined = () => file,
) {
  return new TailRunner({
    locate,
    onRead: (result) => into.push(result),
    timers,
    watch: watch.watch,
  });
}

const numbers = (reads: ReadResult[]) =>
  reads.flatMap((r) => r.lines.map((l) => JSON.parse(l).n));

describe("TailRunner", () => {
  it("reads within 200 ms of a hook poke", () => {
    writeFileSync(file, row(1));
    const timers = new FakeTimers();
    const reads: ReadResult[] = [];
    const runner = runnerOn(timers, fakeWatch(), reads);
    runner.start();
    expect(numbers(reads)).toEqual([1]);

    appendFileSync(file, row(2));
    runner.poke();
    timers.advance(199);
    expect(numbers(reads)).toEqual([1, 2]);
    runner.stop();
  });

  it("reads again after the settle delay and runs the callback after that", () => {
    writeFileSync(file, row(1));
    const timers = new FakeTimers();
    const reads: ReadResult[] = [];
    const runner = runnerOn(timers, fakeWatch(), reads);
    runner.start();
    let done = false;
    runner.poke(() => {
      done = true;
    });
    timers.advance(100);
    appendFileSync(file, row(2)); // 比 hook 晚落盘的一行
    expect(done).toBe(false);
    timers.advance(POKE_SETTLE_MS);
    expect(numbers(reads)).toEqual([1, 2]);
    expect(done).toBe(true);
    runner.stop();
  });

  it("debounces watch events into one read", () => {
    writeFileSync(file, row(1));
    const timers = new FakeTimers();
    const reads: ReadResult[] = [];
    const watch = fakeWatch();
    const runner = runnerOn(timers, watch, reads);
    runner.start();
    expect(runner.mode).toBe("watch");
    const before = runner.reads;
    appendFileSync(file, row(2));
    watch.state.emit("t.jsonl");
    watch.state.emit("t.jsonl");
    watch.state.emit("other.jsonl"); // 别的文件的事件不理
    timers.advance(150);
    expect(runner.reads).toBe(before + 1);
    expect(numbers(reads)).toEqual([1, 2]);
    runner.stop();
  });

  it("falls back to stat polling when watching fails, comparing size and mtime", () => {
    writeFileSync(file, row(1));
    const timers = new FakeTimers();
    const reads: ReadResult[] = [];
    const watch = fakeWatch();
    watch.state.refuse = true;
    const runner = runnerOn(timers, watch, reads);
    runner.start();
    expect(runner.mode).toBe("poll");
    expect(runner.pollingFallback).toBe(true);

    const idleReads = runner.reads;
    timers.advance(POLL_INTERVAL_MS * 3);
    // 文件没变：只 stat，不读。
    expect(runner.reads).toBe(idleReads);

    appendFileSync(file, row(2));
    timers.advance(POLL_INTERVAL_MS);
    expect(numbers(reads)).toEqual([1, 2]);
    runner.stop();
  });

  it("drops to polling when a working watcher reports an error", () => {
    writeFileSync(file, row(1));
    const timers = new FakeTimers();
    const reads: ReadResult[] = [];
    const watch = fakeWatch();
    const runner = runnerOn(timers, watch, reads);
    runner.start();
    expect(runner.mode).toBe("watch");
    watch.state.fail(new Error("EMFILE"));
    expect(runner.mode).toBe("poll");
    appendFileSync(file, row(2));
    timers.advance(POLL_INTERVAL_MS);
    expect(numbers(reads)).toEqual([1, 2]);
    runner.stop();
  });

  it("keeps looking for a transcript that does not exist yet", () => {
    const timers = new FakeTimers();
    const reads: ReadResult[] = [];
    const found: { path?: string } = {};
    const runner = runnerOn(timers, fakeWatch(), reads, () => found.path);
    runner.start();
    expect(runner.mode).toBe("idle");
    writeFileSync(file, row(1));
    found.path = file;
    timers.advance(6_000);
    expect(numbers(reads)).toEqual([1]);
    runner.stop();
  });

  it("follows a new path after relocate()", () => {
    const other = join(dir, "second.jsonl");
    writeFileSync(file, row(1));
    writeFileSync(other, row(2));
    const timers = new FakeTimers();
    const reads: ReadResult[] = [];
    let located = file;
    const runner = runnerOn(timers, fakeWatch(), reads, () => located);
    runner.start();
    located = other;
    runner.relocate();
    runner.poke();
    timers.advance(100);
    expect(numbers(reads)).toEqual([1, 2]);
    expect(runner.currentPath).toBe(other);
    runner.stop();
  });

  it("resumes from a stored cursor without re-reading what it already saw", () => {
    writeFileSync(file, row(1) + row(2));
    const cursor = readTranscript(file, undefined).cursor;
    appendFileSync(file, row(3));
    const timers = new FakeTimers();
    const reads: ReadResult[] = [];
    const runner = new TailRunner({
      locate: () => file,
      initialCursor: cursor,
      onRead: (r) => reads.push(r),
      timers,
      watch: fakeWatch().watch,
    });
    runner.start();
    expect(numbers(reads)).toEqual([3]);
    runner.stop();
  });
});
