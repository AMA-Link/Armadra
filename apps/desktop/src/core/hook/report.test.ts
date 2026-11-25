import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeContextSequence } from "../terminal/sequences";
import { uuidV7 } from "../workspaces/support";
import { type HookFixture, hookFixture, insertSession } from "./fixture";
import { DONE, WORKING, stateEvent } from "./normalize/event";
import {
  installInternalReporter,
  internalReporter,
  reportInternal,
} from "./report";

const open: HookFixture[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
  installInternalReporter(undefined);
});
function fixture(): HookFixture {
  const it_ = hookFixture();
  open.push(it_);
  return it_;
}

function working(it_: HookFixture, source: string | undefined) {
  const event = stateEvent(it_.nodeId, "claude", WORKING);
  if (source !== undefined) event.stateSource = source;
  return event;
}

describe("core 内部上报入口", () => {
  it("写库、发事件，并按来源标已验证", () => {
    const it_ = fixture();
    const status = reportInternal(it_.context, {
      nodeId: it_.nodeId,
      agentId: "claude",
      event: working(it_, "acp"),
    });
    expect(status?.state).toBe("working");
    expect(status?.stateSource).toBe("acp");
    expect(status?.verified).toBe(true);
    expect(it_.status()?.state).toBe("working");
    expect(it_.published.map((event) => event.type)).toContain("agent.status");
  });

  it("观察级的来源不验证", () => {
    const it_ = fixture();
    const status = reportInternal(it_.context, {
      nodeId: it_.nodeId,
      agentId: "claude",
      event: working(it_, "observed"),
    });
    expect(status?.stateSource).toBe("observed");
    expect(status?.verified).toBe(false);
  });

  it("没有来源或来源不在词汇表里：整条丢掉", () => {
    const it_ = fixture();
    for (const source of [undefined, "nonsense"]) {
      expect(
        reportInternal(it_.context, {
          nodeId: it_.nodeId,
          agentId: "claude",
          event: working(it_, source),
        }),
      ).toBeUndefined();
    }
    expect(it_.status()).toBeUndefined();
  });

  it("节点不存在、或来自节点之外的 CLI：丢掉", () => {
    const it_ = fixture();
    expect(
      reportInternal(it_.context, {
        nodeId: uuidV7(),
        agentId: "claude",
        event: working(it_, "acp"),
      }),
    ).toBeUndefined();
    insertSession(it_, { id: uuidV7(), status: "running", agentId: "claude" });
    expect(
      reportInternal(it_.context, {
        nodeId: it_.nodeId,
        agentId: "codex",
        event: working(it_, "acp"),
      }),
    ).toBeUndefined();
    expect(it_.status()).toBeUndefined();
  });

  it("敲时间线门铃（apply 自己不敲）", () => {
    const it_ = fixture();
    const onHook = vi.fn();
    reportInternal(
      { ...it_.context, onHook },
      {
        nodeId: it_.nodeId,
        agentId: "claude",
        event: working(it_, "acp"),
      },
    );
    expect(onHook).toHaveBeenCalledTimes(1);
    expect(onHook.mock.calls[0]?.[0]).toBe(it_.nodeId);
  });

  it("门铃抛错不影响上报", () => {
    const it_ = fixture();
    const status = reportInternal(
      {
        ...it_.context,
        onHook: () => {
          throw new Error("boom");
        },
      },
      {
        nodeId: it_.nodeId,
        agentId: "claude",
        event: working(it_, "acp"),
      },
    );
    expect(status?.state).toBe("working");
  });

  describe("自造终端绑定", () => {
    function counted(it_: HookFixture, sessionId: string) {
      insertSession(it_, { id: sessionId, status: "running", generation: 1 });
      initializeContextSequence(
        join(it_.core.directory, "context-sequences"),
        sessionId,
        1,
      );
    }

    it("会话是节点正在跑的：从会话自己的计数器抽修订号", () => {
      const it_ = fixture();
      const sessionId = uuidV7();
      counted(it_, sessionId);
      const done = stateEvent(it_.nodeId, "claude", DONE);
      done.stateSource = "extension";
      reportInternal(it_.context, {
        nodeId: it_.nodeId,
        agentId: "claude",
        event: done,
        terminalSession: { sessionId, generation: 1 },
      });
      const rows = it_.core.database
        .prepare(
          "SELECT source_revision FROM run_reports WHERE node_id = ? ORDER BY source_revision",
        )
        .all(it_.nodeId) as { source_revision: number }[];
      expect(rows.map((row) => Number(row.source_revision))).toEqual([1]);
    });

    it("会话不是这个节点的：整条丢掉，不落状态", () => {
      const it_ = fixture();
      const done = stateEvent(it_.nodeId, "claude", DONE);
      done.stateSource = "extension";
      expect(
        reportInternal(it_.context, {
          nodeId: it_.nodeId,
          agentId: "claude",
          event: done,
          terminalSession: { sessionId: uuidV7(), generation: 1 },
        }),
      ).toBeUndefined();
      expect(it_.status()).toBeUndefined();
    });

    it("抽不出修订号（没有计数器）：上报照常，只是没有运行关联报告", () => {
      const it_ = fixture();
      const sessionId = uuidV7();
      insertSession(it_, { id: sessionId, status: "running", generation: 1 });
      const done = stateEvent(it_.nodeId, "claude", DONE);
      done.stateSource = "extension";
      expect(
        reportInternal(it_.context, {
          nodeId: it_.nodeId,
          agentId: "claude",
          event: done,
          terminalSession: { sessionId, generation: 1 },
        })?.state,
      ).toBe("done");
      expect(
        it_.core.database
          .prepare("SELECT COUNT(*) AS n FROM run_reports")
          .get(),
      ).toMatchObject({ n: 0 });
    });
  });

  it("装配后才有登记的上报口", () => {
    const it_ = fixture();
    expect(internalReporter()).toBeUndefined();
    installInternalReporter(it_.context);
    const report = internalReporter();
    expect(
      report?.({
        nodeId: it_.nodeId,
        agentId: "claude",
        event: working(it_, "acp"),
      })?.state,
    ).toBe("working");
  });

  it("事件属于别的节点：丢掉，不借这个入口写进来", () => {
    const it_ = fixture();
    const other = stateEvent(uuidV7(), "claude", WORKING);
    other.stateSource = "acp";
    expect(
      reportInternal(it_.context, {
        nodeId: it_.nodeId,
        agentId: "claude",
        event: other,
      }),
    ).toBeUndefined();
    expect(it_.status()).toBeUndefined();
  });

  describe("custom 节点", () => {
    it("归属与绑定都按节点自己的 custom id（与 ingest 一致）", () => {
      const it_ = fixture();
      const sessionId = uuidV7();
      insertSession(it_, {
        id: sessionId,
        status: "running",
        generation: 1,
        agentId: "custom:mine",
      });
      initializeContextSequence(
        join(it_.core.directory, "context-sequences"),
        sessionId,
        1,
      );
      const done = stateEvent(it_.nodeId, "claude", DONE);
      done.stateSource = "extension";
      const status = reportInternal(it_.context, {
        nodeId: it_.nodeId,
        // 槽给的是 base id
        agentId: "claude",
        event: done,
        terminalSession: { sessionId, generation: 1 },
      });
      expect(status?.agentId).toBe("custom:mine");
      expect(
        it_.core.database
          .prepare("SELECT COUNT(*) AS n FROM run_reports WHERE node_id = ?")
          .get(it_.nodeId),
      ).toMatchObject({ n: 1 });
    });
  });
});
