import { afterEach, describe, expect, it, vi } from "vitest";
import { setTerminalBridge, sendPump } from ".";
import { linkNodes } from "../canvas/links.fixture";
import { enqueue } from "../collab/send-queue";
import { freeLease } from "../drive/lease";
import { stubTerminal } from "./fixture";
import { uuidV7 } from "../workspaces/support";
import { programBlocks } from "../collab/program-block";
import { install as installAgents } from ".";
import { fixture, type Fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { install as installCanvas } from "../canvas/routes";

/**
 * 装配点的接线（`agent/index.ts`）：总线上的 `terminal.program` 事件经
 * `programFreeHook` 叫醒出队泵。撤掉那一行接线，这里就会变红。
 */

let open: Fixture | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  programBlocks.clear();
  setTerminalBridge(undefined);
  open?.close();
  open = undefined;
});

function emit(status: { state: string } | undefined, nodeId = "n1"): void {
  open!.bus.emit("workspace.event", {
    workspaceId: "w1",
    event: {
      type: "terminal.program",
      sessionId: "s1",
      nodeId,
      ...(status === undefined ? {} : { status }),
    },
  } as never);
}

describe("the terminal.program wiring", () => {
  it("wakes the send pump when a node leaves blocked, and only then", () => {
    open = fixture([installWorkspaces, installCanvas, installAgents]);
    const free = vi.spyOn(sendPump(), "noteFree").mockImplementation(() => {});
    emit({ state: "working" });
    expect(free).not.toHaveBeenCalled();
    emit({ state: "blocked" });
    expect(free).not.toHaveBeenCalled();
    emit({ state: "working" });
    expect(free).toHaveBeenCalledTimes(1);
    expect(free).toHaveBeenCalledWith("n1");
    emit({ state: "working" });
    expect(free).toHaveBeenCalledTimes(1);
  });
});

describe("the restart time agent/index.ts hands the pump", () => {
  /** 一个终端节点、一条会话、一条排队项；`agentId` 为空是没有状态通道的裸终端。 */
  function queued(agentId: string | null, options: { unverified: boolean }) {
    const database = open!.database;
    const workspaceId = (
      database.prepare("SELECT id FROM workspaces LIMIT 1").get() as {
        id: string;
      }
    ).id;
    const boardId = (
      database.prepare("SELECT id FROM boards LIMIT 1").get() as { id: string }
    ).id;
    const stamp = new Date().toISOString();
    const node = (title: string, agent: string | null) => {
      const id = uuidV7();
      database
        .prepare(
          "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, " +
            "labels_json, note, data_json, created_at, updated_at) " +
            "VALUES (?, ?, 'terminal', ?, '#0a84ff', 0, 0, 240, 200, '[]', '', ?, ?, ?)",
        )
        .run(
          id,
          boardId,
          title,
          JSON.stringify(
            agent === null
              ? { kind: "terminal" }
              : { kind: "terminal", agent: { id: agent } },
          ),
          stamp,
          stamp,
        );
      return id;
    };
    const source = node("Source", null);
    const target = node("Target", agentId);
    linkNodes(database, source, target);
    const sessionId = uuidV7();
    database
      .prepare(
        "INSERT INTO terminal_sessions (id, workspace_id, session_key, kind, owner_node_id, agent_id, " +
          "cwd, shell, status, generation, attach_state, created_at) " +
          "VALUES (?, ?, ?, 'terminal', ?, ?, ?, '/bin/sh', 'running', 1, 'live', ?)",
      )
      .run(
        sessionId,
        workspaceId,
        target,
        target,
        agentId ?? "",
        open!.directory,
        stamp,
      );
    const stub = stubTerminal();
    stub.drive.set(target, {
      nodeId: target,
      sessionId,
      state: "idle",
      stateSource: agentId === null ? "observed" : "hook",
      lease: freeLease(0),
      driveGeneration: 0,
    } as never);
    stub.activity.set(sessionId, {
      pending: false,
      lastInputAt: undefined,
      lastOutputAt: Date.now() - 5_000,
    });
    stub.foreground = { command: agentId ?? "sh" };
    setTerminalBridge(stub.bridge);
    const id = uuidV7();
    const now = Math.floor(Date.now() / 1000);
    const inserted = enqueue(database, {
      id,
      workspaceId,
      sourceNodeId: source,
      targetNodeId: target,
      origin: "send",
      body: "做",
      hops: 0,
      trail: [],
      now,
      state: "queued",
      ...(options.unverified ? { unverified: true } : {}),
    });
    expect(inserted.kind).toBe("inserted");
    // 排队项早于这个 core 起来的时刻：模拟「重启前排下的」。
    database
      .prepare(
        "UPDATE agent_send_queue SET created_at = created_at - 100000 WHERE id = ?",
      )
      .run(id);
    return { id, target, source, stub };
  }

  it("ends a pre-restart --unverified item aimed at a target with no state channel, and tells the sender", async () => {
    open = fixture([installWorkspaces, installCanvas, installAgents]);
    const { id, target, source, stub } = queued(null, { unverified: true });
    await sendPump().drain(target);
    expect(stub.submits).toHaveLength(0);
    const row = open.database
      .prepare(
        "SELECT state, last_reason, settled_by FROM agent_send_queue WHERE id = ?",
      )
      .get(id) as { state: string; last_reason: string; settled_by: string };
    expect(row).toEqual({
      state: "cancelled",
      last_reason: "TARGET_STATE_UNVERIFIED",
      settled_by: "gate",
    });
    const receipt = open.database
      .prepare(
        "SELECT body FROM agent_mailbox WHERE target_node_id = ? AND message_key = ?",
      )
      .get(source, `receipt:${id}`) as { body: string } | undefined;
    expect(receipt?.body).toContain("TARGET_STATE_UNVERIFIED");
    expect(receipt?.body).toContain("重启");
  });

  it("delivers a pre-restart --unverified item aimed at a target that has a state channel", async () => {
    open = fixture([installWorkspaces, installCanvas, installAgents]);
    const { id, target, stub } = queued("claude", { unverified: true });
    await sendPump().drain(target);
    expect(stub.submits).toHaveLength(1);
    const row = open.database
      .prepare("SELECT state FROM agent_send_queue WHERE id = ?")
      .get(id) as { state: string };
    expect(row.state).toBe("done");
  });

  it("delivers an old queued item without --unverified as usual", async () => {
    open = fixture([installWorkspaces, installCanvas, installAgents]);
    const { target, stub } = queued("claude", { unverified: false });
    await sendPump().drain(target);
    expect(stub.submits).toHaveLength(1);
  });
});
