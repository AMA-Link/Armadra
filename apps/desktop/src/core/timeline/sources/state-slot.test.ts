import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { insertSession } from "../../hook/fixture";
import { DONE, WORKING, stateEvent } from "../../hook/normalize/event";
import { installInternalReporter } from "../../hook/report";
import { FakeTimers } from "../testing";
import { type Rig, rig } from "./harness";
import {
  type StateSlot,
  type StateSlotContext,
  type StateSlotLevel,
  registerStateSlot,
} from "./index";

const SESSION = "slot-1";

let r: Rig;
let off: (() => void)[] = [];

beforeEach(() => {
  r = rig({ timers: new FakeTimers(), watch: () => ({ close() {} }) });
  installInternalReporter(r.fixture.context);
});

afterEach(() => {
  for (const undo of off) undo();
  off = [];
  installInternalReporter(undefined);
  r.close();
});

interface Probe {
  readonly contexts: StateSlotContext[];
  readonly started: number[];
  readonly stopped: number[];
  readonly pokes: number[];
  readonly reads: number[];
}

function register(
  level: StateSlotLevel,
  open: (context: StateSlotContext) => StateSlot | undefined = () => ({
    start() {},
    stop() {},
  }),
  agentId = "claude",
): Probe {
  const probe: Probe = {
    contexts: [],
    started: [],
    stopped: [],
    pokes: [],
    reads: [],
  };
  off.push(
    registerStateSlot({
      agentId,
      level,
      open(context) {
        probe.contexts.push(context);
        const slot = open(context);
        if (slot === undefined) return undefined;
        return {
          start() {
            probe.started.push(1);
            slot.start();
          },
          poke() {
            probe.pokes.push(1);
            slot.poke?.();
          },
          readNow() {
            probe.reads.push(1);
            slot.readNow?.();
          },
          stop() {
            probe.stopped.push(1);
            slot.stop();
          },
        };
      },
    }),
  );
  return probe;
}

describe("状态读取槽的生命周期", () => {
  it("会话一起来就开，不等任何上报", () => {
    const probe = register("reported");
    insertSession(r.fixture, { id: SESSION, status: "running", generation: 2 });
    expect(r.fixture.status()).toBeUndefined();
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    expect(probe.started).toHaveLength(1);
    expect(r.domain.sources.slotCount).toBe(1);
    expect(probe.contexts[0]).toMatchObject({
      nodeId: r.fixture.nodeId,
      sessionId: SESSION,
      generation: 2,
      agentId: "claude",
    });
  });

  it("同一个会话只开一次", () => {
    const probe = register("reported");
    insertSession(r.fixture, { id: SESSION, status: "running" });
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    expect(probe.contexts).toHaveLength(1);
  });

  it("没登记槽的 CLI、没有运行中会话的节点：什么也不开", () => {
    register("reported", undefined, "codex");
    insertSession(r.fixture, { id: SESSION, status: "running" });
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    expect(r.domain.sources.slotCount).toBe(0);
    r.database.prepare("UPDATE terminal_sessions SET status = 'exited'").run();
    register("reported");
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    expect(r.domain.sources.slotCount).toBe(0);
  });

  it("槽自己说这个节点读不了（远程等）：不开，节点照常", () => {
    register("reported", () => undefined);
    insertSession(r.fixture, { id: SESSION, status: "running" });
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    expect(r.domain.sources.slotCount).toBe(0);
  });

  it("槽开的时候抛错只记日志，不影响会话", () => {
    register("reported", () => {
      throw new Error("boom");
    });
    insertSession(r.fixture, { id: SESSION, status: "running" });
    expect(() =>
      r.domain.sources.onSessionStart(r.fixture.nodeId),
    ).not.toThrow();
    expect(r.domain.sources.slotCount).toBe(0);
  });

  it("hook 门铃叫醒槽，并补开漏开的那一个", () => {
    const probe = register("reported");
    insertSession(r.fixture, { id: SESSION, status: "running" });
    const event = stateEvent(r.fixture.nodeId, "claude", WORKING);
    r.domain.sources.onHook(r.fixture.nodeId, event);
    expect(probe.started).toHaveLength(1);
    r.domain.sources.onHook(r.fixture.nodeId, event);
    expect(probe.pokes.length).toBeGreaterThan(0);
  });

  it("会话不再 running：巡检最后读一次再停", () => {
    const probe = register("reported");
    insertSession(r.fixture, { id: SESSION, status: "running" });
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    expect(r.domain.sources.reap()).toBe(0);
    r.database.prepare("UPDATE terminal_sessions SET status = 'exited'").run();
    expect(r.domain.sources.reap()).toBe(1);
    expect(probe.reads).toHaveLength(1);
    expect(probe.stopped).toHaveLength(1);
    expect(r.domain.sources.slotCount).toBe(0);
  });

  it("节点换了新会话：旧会话的槽停掉", () => {
    const probe = register("reported");
    insertSession(r.fixture, { id: SESSION, status: "running", generation: 1 });
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    r.database.prepare("UPDATE terminal_sessions SET status = 'exited'").run();
    insertSession(r.fixture, {
      id: "slot-2",
      status: "running",
      generation: 2,
    });
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    expect(probe.stopped).toHaveLength(1);
    expect(r.domain.sources.slotCount).toBe(1);
    expect(r.domain.sources.slotOf("slot-2")).toBeDefined();
  });

  it("core 重启：running 的会话重新开槽", () => {
    const probe = register("reported");
    insertSession(r.fixture, { id: SESSION, status: "running" });
    r.domain.sources.resume();
    expect(probe.started).toHaveLength(1);
  });

  it("close 停掉所有槽", () => {
    const probe = register("reported");
    insertSession(r.fixture, { id: SESSION, status: "running" });
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    r.domain.sources.close();
    expect(probe.stopped).toHaveLength(1);
  });

  it("终端事实：未装配时 pid 读不到、按本机算；装配后取它的答案", () => {
    const probe = register("reported");
    insertSession(r.fixture, { id: SESSION, status: "running" });
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    const context = probe.contexts[0] as StateSlotContext;
    expect(context.pid()).toBeUndefined();
    expect(context.remote()).toBe(false);
    r.domain.sources.setTerminalFacts({ pid: () => 4242, remote: () => true });
    expect(context.pid()).toBe(4242);
    expect(context.remote()).toBe(true);
  });
});

describe("换代、重入与槽的故障", () => {
  it("同一个会话原地换代（id 不变、代次加一）：旧槽停掉、按新代次重开", () => {
    const probe = register("reported");
    insertSession(r.fixture, { id: SESSION, status: "running", generation: 1 });
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    r.database
      .prepare("UPDATE terminal_sessions SET generation = 2 WHERE id = ?")
      .run(SESSION);
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    expect(probe.stopped).toHaveLength(1);
    expect(probe.started).toHaveLength(2);
    expect(probe.contexts.map((c) => c.generation)).toEqual([1, 2]);
    expect(r.domain.sources.slotCount).toBe(1);
  });

  it("同代次再叫一次：不重开", () => {
    const probe = register("reported");
    insertSession(r.fixture, { id: SESSION, status: "running", generation: 1 });
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    expect(probe.started).toHaveLength(1);
  });

  it("start 里同步上报：门铃不再叫回它自己，也不会重复开槽", () => {
    let pokesDuringReport = 0;
    let reporting = false;
    const probe = register("reported", (context) => ({
      start() {
        reporting = true;
        const event = stateEvent(context.nodeId, "claude", WORKING);
        event.stateSource = "extension";
        context.report(event);
        reporting = false;
      },
      poke() {
        if (reporting) pokesDuringReport++;
      },
      stop() {},
    }));
    insertSession(r.fixture, { id: SESSION, status: "running" });
    installInternalReporter({
      ...r.fixture.context,
      onHook: (id, event) => r.domain.sources.onHook(id, event),
    });
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    expect(pokesDuringReport).toBe(0);
    expect(probe.contexts).toHaveLength(1);
    expect(r.fixture.status()?.state).toBe("working");
  });

  it("open 里同步上报：门铃补开不会重复 open", () => {
    const probe = register("reported", (context) => {
      const event = stateEvent(context.nodeId, "claude", WORKING);
      event.stateSource = "extension";
      context.report(event);
      return { start() {}, stop() {} };
    });
    insertSession(r.fixture, { id: SESSION, status: "running" });
    installInternalReporter({
      ...r.fixture.context,
      onHook: (id, event) => r.domain.sources.onHook(id, event),
    });
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    expect(probe.contexts).toHaveLength(1);
    expect(r.domain.sources.slotCount).toBe(1);
  });

  it("start 抛错：槽不留在表里，已停", () => {
    const probe = register("reported", () => ({
      start() {
        throw new Error("boom");
      },
      stop() {},
    }));
    insertSession(r.fixture, { id: SESSION, status: "running" });
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    expect(r.domain.sources.slotCount).toBe(0);
    expect(probe.stopped).toHaveLength(1);
  });

  it("readNow 抛错：巡检照样停槽，不中断后面的来源", () => {
    const probe = register("reported", () => ({
      start() {},
      readNow() {
        throw new Error("boom");
      },
      stop() {},
    }));
    insertSession(r.fixture, { id: SESSION, status: "running" });
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    r.database.prepare("UPDATE terminal_sessions SET status = 'exited'").run();
    expect(() => r.domain.sources.reap()).not.toThrow();
    expect(probe.stopped).toHaveLength(1);
    expect(r.domain.sources.slotCount).toBe(0);
  });

  it("poke 抛错：不连累同一个 hook 的转录门铃", () => {
    register("reported", () => ({
      start() {},
      poke() {
        throw new Error("boom");
      },
      stop() {},
    }));
    insertSession(r.fixture, { id: SESSION, status: "running" });
    r.domain.sources.onSessionStart(r.fixture.nodeId, SESSION);
    const event = stateEvent(r.fixture.nodeId, "claude", WORKING);
    expect(() =>
      r.domain.sources.onHook(r.fixture.nodeId, event),
    ).not.toThrow();
  });

  it("按会话 id 开槽：节点上最新的 running 行不是它时不开", () => {
    const probe = register("reported");
    insertSession(r.fixture, { id: SESSION, status: "running", generation: 1 });
    r.domain.sources.onSessionStart(r.fixture.nodeId, "not-a-session");
    expect(probe.started).toHaveLength(0);
  });
});

describe("声明的级别由管理器执行", () => {
  function opened(level: StateSlotLevel): StateSlotContext {
    const probe = register(level);
    insertSession(r.fixture, { id: SESSION, status: "running" });
    r.domain.sources.onSessionStart(r.fixture.nodeId);
    return probe.contexts[0] as StateSlotContext;
  }

  it("上报级：带上报级来源的事件进状态，已验证", () => {
    const context = opened("reported");
    const event = stateEvent(r.fixture.nodeId, "claude", WORKING);
    event.stateSource = "extension";
    expect(context.report(event)).toBe(true);
    expect(r.fixture.status()).toMatchObject({
      state: "working",
      stateSource: "extension",
      verified: true,
    });
  });

  it("上报级：来源缺席或是观察级：整条丢弃，不悄悄降级", () => {
    const context = opened("reported");
    for (const source of [undefined, "observed"]) {
      const event = stateEvent(r.fixture.nodeId, "claude", WORKING);
      if (source !== undefined) event.stateSource = source;
      expect(context.report(event)).toBe(false);
    }
    expect(r.fixture.status()).toBeUndefined();
  });

  it("观察级：来源一律写成 observed，不验证，不满足上报判定", () => {
    const context = opened("observed");
    const event = stateEvent(r.fixture.nodeId, "claude", DONE);
    event.stateSource = "extension"; // 槽想自称上报级也没用
    expect(context.report(event)).toBe(true);
    expect(r.fixture.status()).toMatchObject({
      state: "done",
      stateSource: "observed",
      verified: false,
    });
  });

  it("没装配上报口：空操作，不抛", () => {
    const context = opened("reported");
    installInternalReporter(undefined);
    const event = stateEvent(r.fixture.nodeId, "claude", WORKING);
    event.stateSource = "hook";
    expect(context.report(event)).toBe(false);
  });

  it("上报会敲时间线门铃（槽的事件也让转录读一次）", () => {
    const context = opened("reported");
    const onHook = vi.spyOn(r.domain.sources, "onHook");
    installInternalReporter({
      ...r.fixture.context,
      onHook: (id, e) => r.domain.sources.onHook(id, e),
    });
    const event = stateEvent(r.fixture.nodeId, "claude", WORKING);
    event.stateSource = "hook";
    context.report(event);
    expect(onHook).toHaveBeenCalled();
  });
});
