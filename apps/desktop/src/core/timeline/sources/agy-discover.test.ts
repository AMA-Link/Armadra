import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertSession } from "../../hook/fixture";
import type { AgySessionDeps } from "../../history/agy-session";
import { FakeTimers } from "../testing";
import { agyTranscriptWith } from "./agy";
import { type Rig, fixtureLines, rig } from "./harness";
import { ADAPTERS, DISCOVER_FAST_MS, DISCOVER_SLOW_MS } from "./index";
import type { TranscriptAdapter } from "./types";

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
let logText: string;
let pids: number[];
let pidKnown: boolean;
let psCalls: number;
let saved: TranscriptAdapter | undefined;

const created = (id: string) =>
  `I1125 02:13:51.634988     262 server.go:1269] Created conversation ${id} (backend=X)\n`;

function deps(): AgySessionDeps {
  return {
    platform: () => "darwin",
    agyPids: () => {
      psCalls += 1;
      return pids;
    },
    heldLogs: async () => [join(dir, "log", "cli-1.log")],
    logSize: () => Buffer.byteLength(logText),
    readLogFrom: (_path, from) => Buffer.from(logText).subarray(from),
    classify: (ids) => new Map(ids.map((id) => [id, "top" as const])),
    stateDir: () => dir,
    exists: () => true,
  };
}

/** 让已经排队的微任务（异步的 discover）跑完。 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function advance(ms: number): Promise<void> {
  timers.advance(ms);
  await flush();
}

function adapters(): Record<string, TranscriptAdapter | undefined> {
  return ADAPTERS as Record<string, TranscriptAdapter | undefined>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "armadra-test-agy-timeline-"));
  timers = new FakeTimers();
  logText = "";
  pids = [42];
  pidKnown = true;
  psCalls = 0;
  r = rig({ timers, watch: () => ({ close() {} }) });
  insertSession(r.fixture, { id: SESSION, status: "running", agentId: "agy" });
  r.domain.sources.setTerminalFacts({
    pid: () => (pidKnown ? 77 : undefined),
    remote: () => false,
  });
  saved = adapters().agy;
  adapters().agy = agyTranscriptWith(deps());
});

afterEach(() => {
  adapters().agy = saved;
  r.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a terminal agy without hooks", () => {
  it("creates no source until the log names a conversation, polling fast meanwhile", async () => {
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    await flush();
    expect(r.domain.sources.size).toBe(0);
    await advance(DISCOVER_FAST_MS);
    expect(r.domain.sources.size).toBe(0);
    // 第一条提示发出去之后，进程日志里才有 Created conversation。
    logText = created(A);
    await advance(DISCOVER_FAST_MS);
    expect(r.domain.sources.size).toBe(1);
    expect(r.domain.sources.runnerOf(SESSION)).toBeDefined();
  });

  it("once found it asks slowly: nothing at the fast interval, then at the slow one", async () => {
    logText = created(A);
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    await flush();
    expect(r.domain.sources.size).toBe(1);
    const before = psCalls;
    await advance(DISCOVER_FAST_MS * 3);
    expect(psCalls).toBe(before);
    await advance(DISCOVER_SLOW_MS - DISCOVER_FAST_MS * 3);
    expect(psCalls).toBe(before + 1);
  });

  it("follows /new: a later conversation in the same log moves the source, once", async () => {
    logText = created(A);
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    await flush();
    const runner = r.domain.sources.runnerOf(SESSION);
    expect(runner).toBeDefined();
    const writes: string[] = [];
    const relocate = runner?.relocate.bind(runner);
    if (runner !== undefined)
      runner.relocate = () => {
        writes.push("relocate");
        relocate?.();
      };
    logText += created(B);
    await advance(DISCOVER_SLOW_MS);
    expect(writes).toEqual(["relocate"]);
    await advance(DISCOVER_SLOW_MS);
    expect(writes).toEqual(["relocate"]);
  });

  it("a second agy process appearing under the node leaves the existing source alone", async () => {
    logText = created(A);
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    await flush();
    const runner = r.domain.sources.runnerOf(SESSION);
    let relocated = 0;
    if (runner !== undefined) runner.relocate = () => void (relocated += 1);
    // 嵌套出第二个 agy：解析器答不出，来源不动、不丢、不重定位。
    pids = [42, 43];
    await advance(DISCOVER_SLOW_MS * 3);
    expect(r.domain.sources.size).toBe(1);
    expect(r.domain.sources.runnerOf(SESSION)).toBe(runner);
    expect(relocated).toBe(0);
  });

  it("shows nothing and does not throw where the pid is unknown", async () => {
    pidKnown = false;
    logText = created(A);
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    await advance(DISCOVER_FAST_MS * 3);
    expect(r.domain.sources.size).toBe(0);
  });

  it("stops asking once the terminal session has ended, and on close", async () => {
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    await flush();
    r.fixture.core.database
      .prepare("UPDATE terminal_sessions SET status = 'exited' WHERE id = ?")
      .run(SESSION);
    logText = created(A);
    await advance(DISCOVER_FAST_MS * 3);
    expect(r.domain.sources.size).toBe(0);

    const second = "term-2";
    r.fixture.core.database
      .prepare("UPDATE terminal_sessions SET status = 'running' WHERE id = ?")
      .run(SESSION);
    logText = "";
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    await flush();
    r.domain.sources.close();
    logText = created(A);
    await advance(DISCOVER_SLOW_MS * 3);
    expect(r.domain.sources.size).toBe(0);
    expect(second).toBe("term-2");
  });

  it("after a core restart a still-running session is looked at again", async () => {
    logText = created(A);
    // 重启：没有 onSessionStart，管理器靠 `resume()` 接回仍在跑的会话。
    r.domain.sources.resume();
    await flush();
    expect(r.domain.sources.size).toBe(1);
  });

  it("converts the transcript the discovered path points at", async () => {
    logText = created(A);
    const path = join(dir, "brain", A, ".system_generated", "logs");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "transcript.jsonl"),
      fixtureLines("agy/transcript.jsonl").join("\n") + "\n",
    );
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    await flush();
    timers.advance(1_000);
    const items = Object.values(r.domain.writer.state(SESSION)?.items ?? {});
    expect(items.some((item) => item.kind === "user")).toBe(true);
    expect(items.some((item) => item.kind === "tool")).toBe(true);
  });
});
