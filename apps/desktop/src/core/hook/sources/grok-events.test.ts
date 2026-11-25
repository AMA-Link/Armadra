import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  channelUnbound,
  markChannelUnbound,
  nodeStateChannel,
  refreshNodeState,
  registerStateRefresher,
} from "../../agent/state-source";
import { tempDir } from "../../testing/temp-dir";
import type { StateSlotContext } from "../../timeline/sources/state-slot";
import { FakeTimers } from "../../timeline/testing";
import type { AgentEvent } from "../normalize/event";
import {
  type GrokDeps,
  PERMISSION_GRACE_MS,
  SessionTail,
  aggregate,
  encodeCwd,
  grokSlotProvider,
  locateEvents,
  readActiveSessions,
} from "./grok-events";
import { installCoreStateSources } from "./index";

/**
 * grok 的状态读取槽（契约 §121）。文件形状取自 1.0.92 的真文件（events.jsonl、
 * active_sessions.json），内容是编的。
 */

const NODE = "node-1";
const ROOT_PID = 100;
const CHILD_PID = 4242;
const CWD = "/work/demo project";

let home: string;
let timers: FakeTimers;
let reports: AgentEvent[];
let table: Map<number, number>;
let rows: { session_id: string; pid: number; cwd: string }[];
let activeRaw: string | undefined;
let removeSources: (() => void) | undefined;

const iso = (offsetMs = 0) => new Date(timers.now() + offsetMs).toISOString();

function line(type: string, extra: Record<string, unknown> = {}, at = 0) {
  return JSON.stringify({ ts: iso(at), type, ...extra });
}

function eventsPath(id: string): string {
  return join(home, "sessions", encodeCwd(CWD), id, "events.jsonl");
}

function writeEvents(id: string, lines: string[]): void {
  const path = eventsPath(id);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.map((entry) => `${entry}\n`).join(""));
}

function append(id: string, lines: string[]): void {
  appendFileSync(eventsPath(id), lines.map((entry) => `${entry}\n`).join(""));
}

function writeActive(): void {
  writeFileSync(
    join(home, "active_sessions.json"),
    activeRaw ??
      JSON.stringify(
        rows.map((row) => ({
          ...row,
          pid_start: 1,
          opened_at: "2026-11-25T00:00:00Z",
        })),
      ),
  );
}

const deps = (): GrokDeps => ({
  home: () => home,
  readActive: readActiveSessions,
  processTable: () => table,
  locate: locateEvents,
  now: () => timers.now(),
});

function open(options: { remote?: boolean } = {}) {
  const provider = grokSlotProvider(deps());
  const context: StateSlotContext = {
    nodeId: NODE,
    workspaceId: "ws",
    agentId: "grok",
    sessionId: "term-1",
    generation: 1,
    cwd: CWD,
    startedAtMs: 0,
    pid: () => ROOT_PID,
    remote: () => options.remote === true,
    report: (event) => {
      reports.push({ ...event });
      return true;
    },
    timers,
    log: { warn: () => undefined, debug: () => undefined },
  };
  const slot = provider.open(context);
  return { slot, context };
}

const states = () =>
  reports.filter((e) => e.kind === "state").map((e) => e.state);

beforeEach(() => {
  home = tempDir("armadra-grok-home-");
  timers = new FakeTimers(Date.parse("2026-11-25T08:00:00Z"));
  reports = [];
  table = new Map([
    [CHILD_PID, ROOT_PID],
    [ROOT_PID, 1],
    [999, 1],
  ]);
  rows = [];
  activeRaw = undefined;
  markChannelUnbound(NODE, false);
});

afterEach(() => {
  removeSources?.();
  removeSources = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("按进程绑定", () => {
  it("PTY 进程自己或它的后代的行才是这个节点的；别人的进程不算", () => {
    rows = [
      { session_id: "mine", pid: CHILD_PID, cwd: CWD },
      { session_id: "other", pid: 999, cwd: CWD },
    ];
    writeActive();
    writeEvents("mine", [line("turn_started")]);
    writeEvents("other", [line("turn_started"), line("permission_requested")]);
    const { slot } = open();
    slot!.start();
    // 别人的行在等审批，但与这个节点无关：只看到自己的 working。
    expect(states()).toEqual(["working"]);
    slot!.stop();
  });

  it("没有这个节点的行（grok 还没起、被别的东西起的）：什么也不报", () => {
    rows = [{ session_id: "other", pid: 999, cwd: CWD }];
    writeActive();
    writeEvents("other", [line("turn_started")]);
    const { slot } = open();
    slot!.start();
    expect(reports).toEqual([]);
    expect(channelUnbound(NODE)).toBe(false);
    slot!.stop();
  });

  it("会话刚开、还没有任何回合：只说 session start，不报状态（没有「完成」可说）", () => {
    rows = [{ session_id: "fresh", pid: CHILD_PID, cwd: CWD }];
    writeActive();
    writeEvents("fresh", []);
    const { slot } = open();
    slot!.start();
    expect(reports.map((e) => e.kind)).toEqual(["session"]);
    expect(states()).toEqual([]);
    slot!.stop();
  });

  it("文件还不存在不是错误，不标记「绑不上」", () => {
    const { slot } = open();
    slot!.start();
    expect(reports).toEqual([]);
    expect(channelUnbound(NODE)).toBe(false);
    slot!.stop();
  });

  it("文件在但读不了（坏 JSON、形状不对）：标记绑不上，之后读好了就撤掉", () => {
    activeRaw = "{not json";
    writeActive();
    const { slot } = open();
    slot!.start();
    expect(channelUnbound(NODE)).toBe(true);
    activeRaw = JSON.stringify([{ session_id: 1 }]);
    writeActive();
    slot!.poke?.();
    expect(channelUnbound(NODE)).toBe(true);
    activeRaw = undefined;
    rows = [{ session_id: "mine", pid: ROOT_PID, cwd: CWD }];
    writeActive();
    writeEvents("mine", []);
    slot!.poke?.();
    expect(channelUnbound(NODE)).toBe(false);
    slot!.stop();
    expect(reports.length).toBeGreaterThan(0);
  });

  it("远程节点、Windows：不开槽（本机文件读不到）", () => {
    expect(open({ remote: true }).slot).toBeUndefined();
  });
});

describe("一个进程里换会话（/new、/resume）", () => {
  it("同一个 pid 的两行都读；旧行在等审批时整体报 waiting，旧行完了、新行在跑报 working", () => {
    rows = [
      { session_id: "old", pid: CHILD_PID, cwd: CWD },
      { session_id: "new", pid: CHILD_PID, cwd: CWD },
    ];
    writeActive();
    writeEvents("old", [
      line("turn_started"),
      line("permission_requested", {}, -PERMISSION_GRACE_MS - 50),
    ]);
    writeEvents("new", [
      line("turn_started"),
      line("turn_ended", { outcome: "completed" }),
    ]);
    const { slot } = open();
    slot!.start();
    expect(states().at(-1)).toBe("waiting");
    // 审批答了，旧回合结束，新会话开始一个回合：working。
    append("old", [
      line("permission_resolved", { decision: "allow", wait_ms: 900 }),
      line("turn_ended", { outcome: "completed" }),
    ]);
    append("new", [line("turn_started")]);
    slot!.poke?.();
    expect(states().at(-1)).toBe("working");
    append("new", [line("turn_ended", { outcome: "completed" })]);
    slot!.poke?.();
    expect(states().at(-1)).toBe("done");
    slot!.stop();
  });

  it("每个新出现的行说一次 session start，不重复", () => {
    rows = [{ session_id: "a", pid: CHILD_PID, cwd: CWD }];
    writeActive();
    writeEvents("a", []);
    const { slot } = open();
    slot!.start();
    slot!.poke?.();
    rows.push({ session_id: "b", pid: CHILD_PID, cwd: CWD });
    writeActive();
    writeEvents("b", []);
    slot!.poke?.();
    const starts = reports.filter(
      (e) => e.kind === "session" && e.sessionPhase === "start",
    );
    expect(starts.map((e) => e.sessionId)).toEqual(["a", "b"]);
    slot!.stop();
  });
});

describe("审批：自动放行不能报成 waiting", () => {
  beforeEach(() => {
    rows = [{ session_id: "s", pid: CHILD_PID, cwd: CWD }];
    writeActive();
  });

  it("--allow 规则 34 ms 内就答了：从头到尾没有 waiting", () => {
    writeEvents("s", [line("turn_started")]);
    const { slot } = open();
    slot!.start();
    append("s", [
      line("permission_requested", { tool_name: "run_terminal_command" }),
    ]);
    slot!.poke?.();
    // 窗口内：还算 working。
    expect(states().at(-1)).toBe("working");
    timers.advance(34);
    append("s", [
      line("permission_resolved", { decision: "allow", wait_ms: 34 }),
      line("tool_completed", { outcome: "success" }),
    ]);
    slot!.poke?.();
    timers.advance(PERMISSION_GRACE_MS + 100);
    expect(states()).not.toContain("waiting");
    slot!.stop();
  });

  it("没人答：窗口一过就报 waiting（计时器触发，不等下一次轮询）", () => {
    writeEvents("s", [line("turn_started")]);
    const { slot } = open();
    slot!.start();
    append("s", [line("permission_requested", { tool_name: "x" })]);
    slot!.poke?.();
    expect(states()).not.toContain("waiting");
    timers.advance(PERMISSION_GRACE_MS + 20);
    expect(states().at(-1)).toBe("waiting");
    // 人答了：回到 working。
    append("s", [
      line("permission_resolved", { decision: "allow", wait_ms: 5000 }),
    ]);
    slot!.poke?.();
    expect(states().at(-1)).toBe("working");
    slot!.stop();
  });

  it("拒绝之后回合以 cancelled 结束：done，带 interrupted", () => {
    writeEvents("s", [
      line("turn_started"),
      line("permission_requested", {}, -1000),
      line("permission_resolved", { decision: "deny", wait_ms: 900 }),
      line("turn_ended", { outcome: "cancelled" }),
    ]);
    const { slot } = open();
    slot!.start();
    const last = reports.at(-1)!;
    expect(last.state).toBe("done");
    expect(last.interrupted).toBe(true);
    slot!.stop();
  });
});

describe("回合的结局", () => {
  beforeEach(() => {
    rows = [{ session_id: "s", pid: ROOT_PID, cwd: CWD }];
    writeActive();
  });

  it.each<[string, { errored?: boolean; interrupted?: boolean }]>([
    ["completed", {}],
    ["cancelled", { interrupted: true }],
    ["error", { errored: true }],
    ["some-new-outcome", { errored: true }],
  ])("outcome %s", (outcome, flags) => {
    writeEvents("s", [line("turn_started"), line("turn_ended", { outcome })]);
    const { slot } = open();
    slot!.start();
    const last = reports.at(-1)!;
    expect(last.state).toBe("done");
    expect(last.errored).toBe(flags.errored);
    expect(last.interrupted).toBe(flags.interrupted);
    expect(last.stateSource).toBe("transcript");
    slot!.stop();
  });

  it("新回合带 newTurn；同一回合里的 tool / phase 行不重复报", () => {
    writeEvents("s", []);
    const { slot } = open();
    slot!.start();
    append("s", [line("turn_started")]);
    slot!.poke?.();
    append("s", [
      line("phase_changed", { phase: "tool_execution" }),
      line("tool_started", { tool_name: "read_file" }),
      line("tool_completed", { outcome: "success" }),
    ]);
    slot!.poke?.();
    const work = reports.filter((e) => e.state === "working");
    expect(work).toHaveLength(1);
    expect(work[0]!.newTurn).toBe(true);
    slot!.stop();
  });

  it("重启后重放：文件里一个没结束的回合，读第一次就是 working", () => {
    writeEvents("s", [line("turn_started"), line("tool_started")]);
    const { slot } = open();
    slot!.start();
    expect(states()).toEqual(["working"]);
    slot!.stop();
  });

  it("判 idle 之前同步补读：文件已经写了 turn_started，轮询还没到", () => {
    writeEvents("s", [
      line("turn_started"),
      line("turn_ended", { outcome: "completed" }),
    ]);
    const { slot } = open();
    slot!.start();
    expect(states().at(-1)).toBe("done");
    const unregister = registerStateRefresher(NODE, () => slot!.readNow!());
    append("s", [line("turn_started")]);
    // 没有 timers.advance：只靠 send 前的同步补读。
    refreshNodeState(NODE);
    unregister();
    expect(states().at(-1)).toBe("working");
    slot!.stop();
  });

  it("半行不读，补全了才读", () => {
    writeEvents("s", [line("turn_started")]);
    const { slot } = open();
    slot!.start();
    const end = line("turn_ended", { outcome: "completed" });
    appendFileSync(eventsPath("s"), end.slice(0, 20));
    slot!.poke?.();
    expect(states().at(-1)).toBe("working");
    appendFileSync(eventsPath("s"), `${end.slice(20)}\n`);
    slot!.poke?.();
    expect(states().at(-1)).toBe("done");
    slot!.stop();
  });

  it("按 cwd 编码找不到时，在 sessions 下一层里按会话 id 找", () => {
    const path = join(home, "sessions", "hash-slug-abc", "s", "events.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${line("turn_started")}\n`);
    const { slot } = open();
    slot!.start();
    expect(states()).toEqual(["working"]);
    slot!.stop();
  });
});

describe("SessionTail 与聚合", () => {
  it("未知的行类型与坏行只计数，不改状态", () => {
    const tail = new SessionTail();
    tail.apply({ type: "mcp_server_connected" });
    tail.apply({ nope: 1 });
    tail.apply("x");
    expect(tail.view(0).state).toBe("idle");
    expect(tail.unknownLines).toBe(2);
  });

  it("等待 > 工作 > 完成", () => {
    const working = { state: "working", turns: 1 } as const;
    const waiting = { state: "waiting", turns: 1 } as const;
    const idle = { state: "idle", turns: 1, ended: "completed" } as const;
    expect(aggregate([idle, working, waiting]).state).toBe("waiting");
    expect(aggregate([idle, working]).state).toBe("working");
    expect(aggregate([idle, idle]).state).toBe("done");
  });
});

describe("这个节点上有没有通道", () => {
  it("本机的有；远程的、绑不上的、provider 没登记的没有", () => {
    removeSources = installCoreStateSources();
    expect(nodeStateChannel("grok", { remote: false })).toBe("transcript");
    expect(nodeStateChannel("grok", { remote: true })).toBeUndefined();
    expect(
      nodeStateChannel("grok", { remote: false, unbound: true }),
    ).toBeUndefined();
    // 别家不受影响。
    expect(nodeStateChannel("claude", { remote: true })).toBe("hook");
    removeSources();
    removeSources = undefined;
    // 撤掉后回到只按 provider 判。
    expect(nodeStateChannel("grok", { remote: true })).toBe("transcript");
  });
});
