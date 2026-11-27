import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { linkNodes } from "../canvas/links.fixture";
import { freeLease } from "../drive/lease";
import {
  CHILD_DONE_MODES,
  DEFAULT_CHILD_DONE,
  noteChildDone,
  resetChildDone,
} from "./child-done";
import { CHILD_DONE_MODES as DOCUMENT_MODES } from "../canvas/validation";
import { SendPump } from "./send-pump";
import { resetSendLimits } from "./send-limits";
import { pendingFor } from "./send-queue";
import { resetInboxWake } from "./wake";

/** 子会话完成回流（Armadra#1062 S6）。 */

let fixture: AgentFixture;
let main: string;
let child: string;
let mainSession: string;

function setAgent(nodeId: string, agent: Record<string, unknown>): void {
  fixture.database
    .prepare("UPDATE nodes SET data_json = ? WHERE id = ?")
    .run(JSON.stringify({ kind: "terminal", agent }), nodeId);
}

/** 下级先报一次 working：回流只在这之后的第一次 done 触发（#1073）。 */
function work(): void {
  noteChildDone(fixture.collab, child, "working");
}

/** 一轮：working 之后 done。 */
function finishTurn() {
  work();
  return noteChildDone(fixture.collab, child, "done");
}

function idle(nodeId: string, sessionId: string): void {
  fixture.terminal.drive.set(nodeId, {
    nodeId,
    sessionId,
    state: "idle",
    stateSource: "hook",
    lease: freeLease(0),
    driveGeneration: 0,
  } as never);
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  resetChildDone();
  fixture = agentFixture();
  main = fixture.agentNode("Planner", "codex");
  child = fixture.agentNode("Worker", "codex");
  mainSession = fixture.session(main, "codex");
  fixture.session(child, "codex");
  linkNodes(fixture.database, main, child, "supervises");
  fixture.terminal.foreground = { command: "codex" };
  idle(main, mainSession);
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  resetInboxWake();
});

describe("档位", () => {
  it("缺省提示；文档校验与之同一份", () => {
    expect(DEFAULT_CHILD_DONE).toBe("notify");
    expect([...CHILD_DONE_MODES]).toEqual([...DOCUMENT_MODES]);
  });
});

describe("noteChildDone", () => {
  it("下级报 done：上级队里多一条 child-done，提示里有名字与怎么读", () => {
    work();
    const outcome = noteChildDone(fixture.collab, child, "done");
    expect(outcome.queued).toEqual([main]);
    const items = pendingFor(fixture.database, main, 0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      origin: "child-done",
      sourceNodeId: child,
      targetNodeId: main,
      hops: 0,
      trail: [],
    });
    expect(items[0]?.body).toContain("下级「Worker」做完了一轮");
    expect(items[0]?.body).toContain(`context summary --node ${child}`);
  });

  it("不是 done、没有上级、上级关掉了，都不回流", () => {
    expect(noteChildDone(fixture.collab, child, "working").queued).toEqual([]);
    expect(noteChildDone(fixture.collab, main, "done").queued).toEqual([]);
    setAgent(main, { id: "codex", childDone: "off" });
    work();
    const outcome = noteChildDone(fixture.collab, child, "done");
    expect(outcome.queued).toEqual([]);
    expect(outcome.skipped).toEqual([{ mainId: main, reason: "off" }]);
    expect(pendingFor(fixture.database, main, 0)).toHaveLength(0);
  });

  it("没见过 working 的 done 不回流（重启后的第一次 done）", () => {
    expect(noteChildDone(fixture.collab, child, "done").queued).toEqual([]);
    expect(pendingFor(fixture.database, main, 0)).toHaveLength(0);
  });

  it("同一轮只回流一次", () => {
    work();
    noteChildDone(fixture.collab, child, "done");
    noteChildDone(fixture.collab, child, "done");
    expect(pendingFor(fixture.database, main, 0)).toHaveLength(1);
  });

  it("同一轮连报的 done（中间夹着别的状态、时间也变了）只回流一次；经过 working 的下一轮再回流（#1073）", () => {
    const touch = (at: string) =>
      fixture.database
        .prepare(
          "INSERT INTO agent_status (node_id, workspace_id, agent_id, updated_at) VALUES (?, ?, 'codex', ?) " +
            "ON CONFLICT(node_id) DO UPDATE SET updated_at = excluded.updated_at",
        )
        .run(child, fixture.workspaceId, at);
    touch("2026-11-26T00:00:01Z");
    expect(finishTurn().queued).toEqual([main]);
    // 同一轮结束时几毫秒里 done → 别的状态 → done（真机上的 ACP 就是这样）。
    noteChildDone(fixture.collab, child, "waiting");
    touch("2026-11-26T00:00:02Z");
    expect(noteChildDone(fixture.collab, child, "done").queued).toEqual([]);
    expect(pendingFor(fixture.database, main, 0)).toHaveLength(1);
    // 下一轮：先 working 再 done。
    touch("2026-11-26T00:00:03Z");
    expect(finishTurn().queued).toEqual([main]);
    expect(pendingFor(fixture.database, main, 0)).toHaveLength(2);
  });

  it("上级是这个下级在跑的任务的协调者时不回流", () => {
    fixture.database
      .prepare(
        "INSERT INTO workflow_task_runs (task_id, coordinator_node_id, runner_id, node_id, status, started_at) VALUES ('t1', ?, 'codex', ?, 'running', 0)",
      )
      .run(main, child);
    work();
    const outcome = noteChildDone(fixture.collab, child, "done");
    expect(outcome.skipped).toEqual([{ mainId: main, reason: "coordinated" }]);
  });

  it("deliver 档读不到摘要时退回提示", () => {
    setAgent(main, { id: "codex", childDone: "deliver" });
    work();
    noteChildDone(fixture.collab, child, "done");
    const body = pendingFor(fixture.database, main, 0)[0]?.body ?? "";
    expect(body).toContain("下级「Worker」做完了一轮");
  });
});

describe("投递", () => {
  it("经出队泵投进上级：署名是应用，向上那条规矩不拦它", async () => {
    const pump = new SendPump(() => fixture.collab);
    // `noteStatus` 自己就推了上级一下（出队是异步的）。
    pump.noteStatus(child, "working");
    pump.noteStatus(child, "done");
    await vi.waitFor(() => expect(fixture.terminal.submits).toHaveLength(1));
    const written = fixture.terminal.submits[0]?.data ?? "";
    expect(written).toContain("from: Armadra 下级回流");
    expect(written).toContain("下级「Worker」做完了一轮");
  });

  it("上级在忙就排着，不投", async () => {
    fixture.terminal.drive.set(main, {
      nodeId: main,
      sessionId: mainSession,
      state: "busy",
      stateSource: "hook",
      lease: freeLease(0),
      driveGeneration: 0,
    } as never);
    const pump = new SendPump(() => fixture.collab);
    pump.noteStatus(child, "working");
    pump.noteStatus(child, "done");
    await pump.drain(main);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.terminal.submits).toHaveLength(0);
    expect(pendingFor(fixture.database, main, 0)).toHaveLength(1);
  });
});
