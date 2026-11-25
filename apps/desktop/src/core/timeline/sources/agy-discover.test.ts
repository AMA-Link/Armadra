import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertSession } from "../../hook/fixture";
import type { AgySessionDeps } from "../../history/agy-session";
import { FakeTimers } from "../testing";
import { agyTranscriptWith } from "./agy";
import { type Rig, fixtureLines, rig } from "./harness";
import type { TranscriptAdapter } from "./types";
import { ADAPTERS, DISCOVER_FAST_MS, DISCOVER_SLOW_MS } from "./index";

/**
 * 没有 hook 的终端 agy：管理器按间隔问适配器「这个终端在哪个会话里」，答出来就建来源
 * （#1036）。进程、日志、索引库都是注入的假读法，不起真 agy。
 */

const SESSION = "term-1";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

let dir: string;
let timers: FakeTimers;
let r: Rig;
let created: string[];
let pidKnown: boolean;
let saved: TranscriptAdapter | undefined;

function deps(): AgySessionDeps {
  return {
    platform: () => "darwin",
    agyPids: () => [42],
    heldLogs: () => ["/h/.gemini/antigravity-cli/log/cli-1.log"],
    readLog: () =>
      created
        .map(
          (id) =>
            `I1125 02:13:51 server.go:1269] Created conversation ${id} (backend=X)`,
        )
        .join("\n"),
    topLevel: (ids) => new Set(ids),
    stateDir: () => dir,
    exists: () => true,
  };
}

function transcriptFor(id: string): string {
  const path = join(dir, "brain", id, ".system_generated", "logs");
  return join(path, "transcript.jsonl");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "armadra-test-agy-timeline-"));
  timers = new FakeTimers();
  created = [];
  pidKnown = true;
  r = rig({ timers, watch: () => ({ close() {} }) });
  insertSession(r.fixture, { id: SESSION, status: "running", agentId: "agy" });
  r.domain.sources.setTerminalFacts({
    pid: () => (pidKnown ? 77 : undefined),
    remote: () => false,
  });
  const adapters = ADAPTERS as Record<string, TranscriptAdapter | undefined>;
  saved = adapters.agy;
  adapters.agy = agyTranscriptWith(deps());
});

afterEach(() => {
  (ADAPTERS as Record<string, TranscriptAdapter | undefined>).agy = saved;
  r.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a terminal agy without hooks", () => {
  it("creates no source until the log names a conversation, then reads its transcript", () => {
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    expect(r.domain.sources.size).toBe(0);
    timers.advance(DISCOVER_FAST_MS);
    expect(r.domain.sources.size).toBe(0);
    // 第一条提示发出去之后，进程日志里才有 Created conversation。
    created = [A];
    timers.advance(DISCOVER_FAST_MS);
    expect(r.domain.sources.size).toBe(1);
    expect(r.domain.sources.runnerOf(SESSION)).toBeDefined();
  });

  it("follows /new: a later conversation in the same log moves the source", () => {
    created = [A];
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    expect(r.domain.sources.size).toBe(1);
    const writes: string[] = [];
    const runner = r.domain.sources.runnerOf(SESSION);
    const relocate = runner?.relocate.bind(runner);
    if (runner !== undefined)
      runner.relocate = () => {
        writes.push("relocate");
        relocate?.();
      };
    created = [A, B];
    timers.advance(DISCOVER_FAST_MS);
    expect(writes).toEqual(["relocate"]);
    // 再问一遍答案没变：不再 relocate。
    timers.advance(DISCOVER_FAST_MS);
    expect(writes).toEqual(["relocate"]);
  });

  it("shows nothing and does not throw where the pid is unknown", () => {
    pidKnown = false;
    created = [A];
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    timers.advance(DISCOVER_FAST_MS * 3);
    expect(r.domain.sources.size).toBe(0);
  });

  it("slows down after the first two minutes, and stops when the session is no longer running", () => {
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    // 会话行的创建时刻在远处：已经不算「刚起来」，间隔是慢的。
    r.fixture.core.database
      .prepare("UPDATE terminal_sessions SET created_at = ? WHERE id = ?")
      .run(new Date(timers.now() - 10 * 60_000).toISOString(), SESSION);
    r.domain.sources.close();
    // 关掉之后再前进不会有任何动作（没有悬着的计时器去建来源）。
    created = [A];
    timers.advance(DISCOVER_SLOW_MS * 3);
    expect(r.domain.sources.size).toBe(0);
  });

  it("stops asking once the terminal session has ended", () => {
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    r.fixture.core.database
      .prepare("UPDATE terminal_sessions SET status = 'exited' WHERE id = ?")
      .run(SESSION);
    created = [A];
    timers.advance(DISCOVER_FAST_MS * 3);
    expect(r.domain.sources.size).toBe(0);
  });

  it("converts the transcript the discovered path points at", () => {
    created = [A];
    const path = transcriptFor(A);
    // 目录由 stateDir 推出来；写文件前先建目录。
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, fixtureLines("agy/transcript.jsonl").join("\n") + "\n");
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    timers.advance(1_000);
    const items = Object.values(r.domain.writer.state(SESSION)?.items ?? {});
    expect(items.some((item) => item.kind === "user")).toBe(true);
    expect(items.some((item) => item.kind === "tool")).toBe(true);
  });
});
