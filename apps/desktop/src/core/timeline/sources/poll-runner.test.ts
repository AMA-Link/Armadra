import { describe, expect, it } from "vitest";

import { FakeTimers } from "../testing";
import { PollRunner } from "./poll-runner";
import {
  POKE_SETTLE_MS,
  POLL_INTERVAL_MS,
  SAFETY_POLL_MS,
  WATCH_DEBOUNCE_MS,
  type WatchHandle,
} from "./tailer";

function setup(
  options: {
    watch?: boolean;
    failRead?: boolean;
  } = {},
) {
  const timers = new FakeTimers();
  const state = { version: "a", reads: 0, errors: 0 };
  let emit: ((filename: string | null) => void) | undefined;
  let fail: (() => void) | undefined;
  const runner = new PollRunner({
    read: () => {
      state.reads++;
      if (options.failRead === true) throw new Error("locked");
    },
    fingerprint: () => state.version,
    watchDirectory: "/db",
    watchPrefix: "opencode.db",
    onError: () => {
      state.errors++;
    },
    timers,
    watch: (_directory, onEvent, onError): WatchHandle => {
      if (options.watch === false) throw new Error("no watch");
      emit = onEvent;
      fail = () => onError(new Error("gone"));
      return { close() {} };
    },
  });
  return {
    timers,
    state,
    runner,
    emit: (f: string | null) => emit?.(f),
    fail: () => fail?.(),
  };
}

describe("PollRunner", () => {
  it("reads at start, on a hook poke and once more after it settles", () => {
    const s = setup();
    s.runner.start();
    expect(s.state.reads).toBe(1);
    let settled = 0;
    s.runner.poke(() => settled++);
    s.timers.advance(30);
    expect(s.state.reads).toBe(2);
    s.timers.advance(POKE_SETTLE_MS);
    expect(s.state.reads).toBe(3);
    expect(settled).toBe(1);
  });

  it("debounces watch events for the database files only", () => {
    const s = setup();
    s.runner.start();
    expect(s.runner.mode).toBe("watch");
    s.emit("other.txt");
    s.timers.advance(WATCH_DEBOUNCE_MS + 1);
    expect(s.state.reads).toBe(1);
    s.emit("opencode.db-wal");
    s.emit("opencode.db-wal");
    s.timers.advance(WATCH_DEBOUNCE_MS + 1);
    expect(s.state.reads).toBe(2);
  });

  it("falls back to polling and only reads when the fingerprint changed", () => {
    const s = setup({ watch: false });
    s.runner.start();
    expect(s.runner.mode).toBe("poll");
    s.timers.advance(POLL_INTERVAL_MS);
    expect(s.state.reads).toBe(1);
    s.state.version = "b";
    s.timers.advance(POLL_INTERVAL_MS);
    expect(s.state.reads).toBe(2);
  });

  it("drops to polling when the watcher errors", () => {
    const s = setup();
    s.runner.start();
    s.fail();
    expect(s.runner.mode).toBe("poll");
    s.state.version = "c";
    s.timers.advance(POLL_INTERVAL_MS);
    expect(s.state.reads).toBe(2);
  });

  it("keeps a safety poll while watching", () => {
    const s = setup();
    s.runner.start();
    s.state.version = "d";
    s.timers.advance(SAFETY_POLL_MS);
    expect(s.state.reads).toBe(2);
  });

  it("reports a failed read once and does not retry until something changes", () => {
    const s = setup({ failRead: true, watch: false });
    s.runner.start();
    expect(s.state.errors).toBe(1);
    s.timers.advance(POLL_INTERVAL_MS * 3);
    expect(s.state.errors).toBe(1);
    s.state.version = "e";
    s.timers.advance(POLL_INTERVAL_MS);
    expect(s.state.errors).toBe(2);
  });

  it("stops reading after stop()", () => {
    const s = setup();
    s.runner.start();
    s.runner.stop();
    s.runner.poke();
    s.timers.advance(POKE_SETTLE_MS * 5);
    expect(s.state.reads).toBe(1);
    expect(s.runner.mode).toBe("idle");
  });
});
