import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  parseEtime,
  psProcessTable,
  readActiveSessions,
} from "./grok-events";
import { installCoreStateSources } from "./index";

/**
 * grok 的状态读取槽（契约 §123）。文件形状取自 1.0.92 的真文件（events.jsonl、
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
let names: Map<number, string>;
let started: Map<number, number>;
let platform: NodeJS.Platform;
let screenText: string | undefined;
let sessionHome: string | undefined;
let rows: {
  session_id: string;
  pid: number;
  cwd: string;
  opened_at?: string;
  /** 微秒；缺省 1（不与任何启动时间比）。 */
  pid_start?: number;
}[];
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
          pid_start: row.pid_start ?? 1,
          opened_at: row.opened_at ?? "2026-11-25T00:00:00Z",
        })),
      ),
  );
}

const deps = (): GrokDeps => ({
  home: (override) => override ?? home,
  readActive: readActiveSessions,
  processTable: () => ({ parents: table, names, startedMs: started }),
  platform: () => platform,
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
    env: (name) => (name === "GROK_HOME" ? sessionHome : undefined),
    screen: async () => screenText,
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
  names = new Map();
  started = new Map();
  platform = "darwin";
  screenText = undefined;
  sessionHome = undefined;
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

  it("远程节点：不开槽（本机文件读不到）", () => {
    expect(open({ remote: true }).slot).toBeUndefined();
  });

  it("Windows：不开槽，通道门也答没有（平台取自注入，不读 process）", () => {
    platform = "win32";
    expect(open().slot).toBeUndefined();
    removeSources = installCoreStateSources(deps());
    expect(nodeStateChannel("grok", { remote: false })).toBeUndefined();
    platform = "darwin";
    expect(open().slot).toBeDefined();
    expect(nodeStateChannel("grok", { remote: false })).toBe("transcript");
  });
});

describe("陈旧的行：进程不在了、pid 被复用", () => {
  const T0 = Date.parse("2026-11-25T07:00:00Z");
  const ready = (pidStart: number | undefined) => {
    rows = [
      {
        session_id: "s",
        pid: CHILD_PID,
        cwd: CWD,
        ...(pidStart === undefined ? {} : { pid_start: pidStart * 1000 }),
      },
    ];
    writeActive();
    writeEvents("s", [line("turn_started")]);
  };

  it("pid 已经不在进程表里（崩了没来得及清行）：这一行不算", () => {
    ready(undefined);
    table.delete(CHILD_PID);
    const { slot } = open();
    slot!.start();
    expect(reports).toEqual([]);
    slot!.stop();
  });

  it("pid 还在但启动时间对不上（被别的进程复用）：不算；对得上才算", () => {
    ready(T0);
    started.set(CHILD_PID, T0 + 60 * 60_000);
    const stale = open();
    stale.slot!.start();
    expect(reports).toEqual([]);
    stale.slot!.stop();

    started.set(CHILD_PID, T0 + 2_000);
    const live = open();
    live.slot!.start();
    expect(states()).toEqual(["working"]);
    live.slot!.stop();
  });

  it("记录里没有 pid_start、或进程表里没有启动时间：不判，照常绑定", () => {
    ready(undefined);
    started.set(CHILD_PID, T0);
    const a = open();
    a.slot!.start();
    expect(states()).toEqual(["working"]);
    a.slot!.stop();
    reports.length = 0;
    started.clear();
    ready(T0);
    const b = open();
    b.slot!.start();
    expect(states()).toEqual(["working"]);
    b.slot!.stop();
  });

  it("etime 的几种写法与真实进程表里的自己", () => {
    expect(parseEtime("00:08")).toBe(8);
    expect(parseEtime("01:02:03")).toBe(3723);
    expect(parseEtime("2-03:04:05")).toBe(2 * 86_400 + 3 * 3_600 + 4 * 60 + 5);
    expect(parseEtime("garbage")).toBeUndefined();
    if (process.platform === "win32") return;
    const real = psProcessTable(() => Date.now() + 3_600_000);
    const mine = real?.startedMs?.get(process.pid);
    // 精度约一秒（etime）：与 `process.uptime()` 推出来的启动时间差在几秒内。
    expect(mine).toBeDefined();
    const expected = Date.now() + 3_600_000 - process.uptime() * 1000;
    expect(Math.abs((mine ?? 0) - expected)).toBeLessThan(5_000);
    // 进程表的缓存按「现在」算：把这趟用的假时间挪走，别留给后面的用例。
    psProcessTable(() => 0);
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
    removeSources = installCoreStateSources(deps());
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

describe("对话记录路径（时间线适配器读它）", () => {
  const updates = (id: string) =>
    join(dirname(eventsPath(id)), "updates.jsonl");
  const starts = () => reports.filter((e) => e.kind === "session");

  it("session start 带 updates.jsonl 的路径；/new 出来的新会话（没有回合，opened_at 更晚）成为当前", () => {
    rows = [{ session_id: "one", pid: CHILD_PID, cwd: CWD }];
    writeActive();
    writeEvents("one", [line("turn_started")]);
    const { slot } = open();
    slot!.start();
    expect(starts()[0]?.transcriptPath).toBe(updates("one"));
    expect(reports.find((e) => e.state === "working")?.transcriptPath).toBe(
      updates("one"),
    );
    // `/new`：新行 opened_at 比旧会话最近一回合开始得晚。
    rows = [
      ...rows,
      {
        session_id: "two",
        pid: CHILD_PID,
        cwd: CWD,
        opened_at: new Date(timers.now() + 5_000).toISOString(),
      },
    ];
    timers.advance(10_000);
    writeActive();
    writeEvents("two", []);
    slot!.poke?.();
    expect(starts().at(-1)?.transcriptPath).toBe(updates("two"));
    append("one", [line("turn_ended", { outcome: "completed" })]);
    slot!.poke?.();
    const last = reports.at(-1);
    expect(last?.transcriptPath).toBe(updates("two"));
    expect(last?.sessionId).toBe("two");
    slot!.stop();
  });

  it("回切已见过的会话：旧会话发了新提示，当前就回到它，状态上报带它的路径与 id", () => {
    rows = [
      { session_id: "one", pid: CHILD_PID, cwd: CWD },
      {
        session_id: "two",
        pid: CHILD_PID,
        cwd: CWD,
        opened_at: new Date(timers.now() + 1_000).toISOString(),
      },
    ];
    writeActive();
    writeEvents("one", [
      line("turn_started"),
      line("turn_ended", { outcome: "completed" }),
    ]);
    writeEvents("two", []);
    const { slot } = open();
    slot!.start();
    expect(reports.at(-1)?.transcriptPath ?? updates("two")).toBe(
      updates("two"),
    );
    timers.advance(30_000);
    append("one", [line("turn_started")]);
    slot!.poke?.();
    const last = reports.at(-1);
    expect(last?.state).toBe("working");
    expect(last?.transcriptPath).toBe(updates("one"));
    expect(last?.sessionId).toBe("one");
    // 又回到 two（它发了更晚的提示）。
    timers.advance(30_000);
    append("one", [line("turn_ended", { outcome: "completed" })]);
    append("two", [line("turn_started")]);
    slot!.poke?.();
    expect(reports.at(-1)?.transcriptPath).toBe(updates("two"));
    slot!.stop();
  });

  it("重启后行序与活动会话不一致：按最近一回合的时间选，不按行序；最后一个announce的是它", () => {
    // 行序里 b 在后，但 a 才是最近发过提示的。
    rows = [
      { session_id: "a", pid: CHILD_PID, cwd: CWD },
      { session_id: "b", pid: CHILD_PID, cwd: CWD },
    ];
    writeActive();
    writeEvents("b", [
      line("turn_started", {}, -60_000),
      line("turn_ended", { outcome: "completed" }, -59_000),
    ]);
    writeEvents("a", [line("turn_started", {}, -1_000)]);
    const { slot } = open();
    slot!.start();
    expect(starts().at(-1)?.transcriptPath).toBe(updates("a"));
    expect(reports.at(-1)?.transcriptPath).toBe(updates("a"));
    expect(reports.at(-1)?.sessionId).toBe("a");
    slot!.stop();
  });

  it("行里 session_id 带路径分隔符或 .. 的不要（会话 id 要拼进路径）", () => {
    rows = [
      { session_id: "../evil", pid: CHILD_PID, cwd: CWD },
      { session_id: "good", pid: CHILD_PID, cwd: CWD },
    ];
    writeActive();
    writeEvents("good", [line("turn_started")]);
    const read = readActiveSessions(home);
    expect(read.kind === "rows" && read.rows.map((r) => r.sessionId)).toEqual([
      "good",
    ]);
  });
});

describe("计划审阅（exit_plan_mode）", () => {
  const ready = () => {
    rows = [{ session_id: "p", pid: CHILD_PID, cwd: CWD }];
    writeActive();
  };

  it("tool_started 起就是 waiting（带 awaitingInput 与 askKind），tool_completed 后清掉", () => {
    ready();
    writeEvents("p", [
      line("turn_started"),
      line("tool_started", { tool_name: "exit_plan_mode" }),
    ]);
    const { slot } = open();
    slot!.start();
    const waiting = reports.filter((e) => e.state === "waiting").at(-1);
    expect(waiting?.awaitingInput).toBe(true);
    expect(waiting?.askKind).toBe("exit_plan_mode");
    append("p", [line("tool_completed", { tool_name: "exit_plan_mode" })]);
    slot!.poke?.();
    const after = reports.at(-1);
    expect(after?.state).toBe("working");
    expect(after?.questionClosed).toBe(true);
    slot!.stop();
  });

  it("回合先结束了：审阅标记也清掉，不会一直 waiting", () => {
    ready();
    writeEvents("p", [
      line("turn_started"),
      line("tool_started", { tool_name: "exit_plan_mode" }),
    ]);
    const { slot } = open();
    slot!.start();
    append("p", [line("turn_ended", { outcome: "cancelled" })]);
    slot!.poke?.();
    const last = reports.at(-1);
    expect(last?.state).toBe("done");
    expect(last?.interrupted).toBe(true);
    slot!.stop();
  });

  it("真账号 1.0.92 的形状：tool_started 后立刻 permission_requested/resolved allow(wait 0)，没有 tool_completed；回答之后是新一轮 loop_started", () => {
    ready();
    writeEvents("p", [
      line("turn_started"),
      line("loop_started"),
      line("tool_started", { tool_name: "search_replace" }),
      line("tool_completed", { tool_name: "search_replace" }),
      line("loop_started"),
      line("tool_started", { tool_name: "exit_plan_mode" }),
      line("permission_requested", { tool_name: "exit_plan_mode" }),
      line("permission_resolved", {
        tool_name: "exit_plan_mode",
        decision: "allow",
        wait_ms: 0,
      }),
    ]);
    const { slot } = open();
    slot!.start();
    expect(states().at(-1)).toBe("waiting");
    expect(reports.at(-1)?.askKind).toBe("exit_plan_mode");
    // 用户在审阅里选了 q / a：模型接着跑一轮，回合随后结束。
    append("p", [line("loop_started"), line("first_token")]);
    slot!.poke?.();
    expect(states().at(-1)).toBe("working");
    append("p", [line("turn_ended", { outcome: "completed" })]);
    slot!.poke?.();
    expect(states().at(-1)).toBe("done");
    slot!.stop();
  });

  it("question card（ask_user_question）同样：waiting，被取消的回合以 cancelled 结束就清掉", () => {
    ready();
    writeEvents("p", [
      line("turn_started"),
      line("tool_started", { tool_name: "ask_user_question" }),
      line("permission_requested", { tool_name: "ask_user_question" }),
      line("permission_resolved", {
        tool_name: "ask_user_question",
        decision: "allow",
        wait_ms: 0,
      }),
    ]);
    const { slot } = open();
    slot!.start();
    const waiting = reports.filter((e) => e.state === "waiting").at(-1);
    expect(waiting?.askKind).toBe("ask_user_question");
    append("p", [line("turn_ended", { outcome: "cancelled" })]);
    slot!.poke?.();
    expect(reports.at(-1)?.state).toBe("done");
    expect(reports.at(-1)?.interrupted).toBe(true);
    slot!.stop();
  });

  it("别的工具不触发 waiting", () => {
    ready();
    writeEvents("p", [
      line("turn_started"),
      line("tool_started", { tool_name: "read_file" }),
    ]);
    const { slot } = open();
    slot!.start();
    expect(states()).toEqual(["working"]);
    slot!.stop();
  });
});

describe("绑不上的节点", () => {
  const grokRuns = () => names.set(CHILD_PID, "grok");

  it("grok 在进程树里、连续 15 秒没有本节点的行：标记绑不上；行出现后撤销", async () => {
    grokRuns();
    writeActive();
    const { slot } = open();
    slot!.start();
    expect(channelUnbound(NODE)).toBe(false);
    timers.advance(14_000);
    expect(channelUnbound(NODE)).toBe(false);
    timers.advance(2_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(channelUnbound(NODE)).toBe(true);
    rows = [{ session_id: "late", pid: CHILD_PID, cwd: CWD }];
    writeActive();
    writeEvents("late", [line("turn_started")]);
    slot!.poke?.();
    expect(channelUnbound(NODE)).toBe(false);
    slot!.stop();
  });

  it("画面在信任框上：行本来就要等回答才有，不标记", async () => {
    grokRuns();
    screenText = "  Do you trust the contents of this directory?\n  1. Yes";
    screenText = "Do you trust the contents of this directory?";
    writeActive();
    const { slot } = open();
    slot!.start();
    timers.advance(16_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(channelUnbound(NODE)).toBe(false);
    slot!.stop();
  });

  it("进程名是 grok-native（真实路径）也认；进程树里没有 grok 则不算", async () => {
    names.set(CHILD_PID, "grok-native");
    writeActive();
    const first = open();
    first.slot!.start();
    timers.advance(16_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(channelUnbound(NODE)).toBe(true);
    first.slot!.stop();
    markChannelUnbound(NODE, false);
  });

  it("进程树里没有 grok（还没起、已退出）：不算绑不上", async () => {
    names.set(CHILD_PID, "node");
    writeActive();
    const { slot } = open();
    slot!.start();
    timers.advance(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(channelUnbound(NODE)).toBe(false);
    slot!.stop();
  });

  it("GROK_HOME 取节点会话的环境，不取 core 的", () => {
    const other = tempDir("armadra-grok-home2-");
    sessionHome = other;
    writeFileSync(
      join(other, "active_sessions.json"),
      JSON.stringify([
        {
          session_id: "x",
          pid: CHILD_PID,
          cwd: CWD,
          pid_start: 1,
          opened_at: "2026-11-25T00:00:00Z",
        },
      ]),
    );
    const path = join(other, "sessions", encodeCwd(CWD), "x", "events.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${line("turn_started")}\n`);
    const { slot } = open();
    slot!.start();
    expect(states()).toEqual(["working"]);
    slot!.stop();
    rmSync(other, { recursive: true, force: true });
  });
});

describe("行全部消失与截断", () => {
  it("绑定集合从有变无：发 session end 并清记忆，下一个会话从零开始", () => {
    rows = [{ session_id: "a", pid: CHILD_PID, cwd: CWD }];
    writeActive();
    writeEvents("a", [line("turn_started")]);
    const { slot } = open();
    slot!.start();
    rows = [];
    writeActive();
    slot!.poke?.();
    expect(
      reports.filter((e) => e.kind === "session").map((e) => e.sessionPhase),
    ).toEqual(["start", "end"]);
    rows = [{ session_id: "b", pid: CHILD_PID, cwd: CWD }];
    writeActive();
    writeEvents("b", [line("turn_started")]);
    slot!.poke?.();
    const last = reports.at(-1);
    expect(last?.state).toBe("working");
    expect(last?.newTurn).toBe(true);
    slot!.stop();
  });

  it("新回合按每个会话自己的回合数判，不看总数", () => {
    rows = [
      { session_id: "a", pid: CHILD_PID, cwd: CWD },
      { session_id: "b", pid: CHILD_PID, cwd: CWD },
    ];
    writeActive();
    writeEvents("a", [
      line("turn_started"),
      line("turn_ended", { outcome: "completed" }),
    ]);
    writeEvents("b", [
      line("turn_started"),
      line("turn_ended", { outcome: "completed" }),
    ]);
    const { slot } = open();
    slot!.start();
    // b 关掉，a 开始新回合：总数没涨，但 a 的回合数涨了。
    rows = [{ session_id: "a", pid: CHILD_PID, cwd: CWD }];
    writeActive();
    append("a", [line("turn_started")]);
    slot!.poke?.();
    const last = reports.at(-1);
    expect(last?.state).toBe("working");
    expect(last?.newTurn).toBe(true);
    slot!.stop();
  });

  it("文件被截断或换掉：从头重读，不沿用旧的状态", () => {
    rows = [{ session_id: "a", pid: CHILD_PID, cwd: CWD }];
    writeActive();
    writeEvents("a", [
      line("turn_started"),
      line("tool_started", { tool_name: "x".repeat(300) }),
    ]);
    const { slot } = open();
    slot!.start();
    expect(states()).toEqual(["working"]);
    writeEvents("a", [
      line("turn_started"),
      line("turn_ended", { outcome: "completed" }),
    ]);
    slot!.poke?.();
    expect(states().at(-1)).toBe("done");
    slot!.stop();
  });

  it("重放窗口切在回合中间（看不到 turn_started）：回合里的行也算在回合内", () => {
    const tail = new SessionTail();
    tail.apply({ type: "tool_started", tool_name: "x" });
    expect(tail.view(0).state).toBe("working");
    const other = new SessionTail();
    other.apply({ type: "first_token" });
    expect(other.view(0).state).toBe("working");
    other.apply({ type: "turn_ended", outcome: "completed" });
    expect(other.view(0).state).toBe("idle");
  });

  it("聚合的 ended 取最近结束的那个，不取行序里最后一个", () => {
    const newer = {
      state: "idle",
      turns: 1,
      ended: "cancelled",
      endedAt: 2_000,
    } as const;
    const older = {
      state: "idle",
      turns: 1,
      ended: "completed",
      endedAt: 1_000,
    } as const;
    expect(aggregate([newer, older]).ended).toBe("cancelled");
    expect(aggregate([older, newer]).ended).toBe("cancelled");
  });
});
