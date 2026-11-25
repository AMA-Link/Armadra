import { afterEach, describe, expect, it } from "vitest";

import { closeHarness, harness, spawn } from "./manager-harness";

afterEach(closeHarness);

describe("会话起来的通知（onStart）", () => {
  it("新建会话时带着节点 id 通知一次", async () => {
    const starts: { sessionId: string; nodeId: string | null }[] = [];
    const { manager } = harness(undefined, {
      onStart: (event) =>
        starts.push({ sessionId: event.sessionId, nodeId: event.nodeId }),
    });
    const session = await spawn(manager, "node-1");
    expect(starts).toEqual([{ sessionId: session.id, nodeId: "node-1" }]);
  });

  it("裸终端（没有节点）也通知，节点为空", async () => {
    const starts: (string | null)[] = [];
    const { manager } = harness(undefined, {
      onStart: (event) => starts.push(event.nodeId),
    });
    await spawn(manager);
    expect(starts).toEqual([null]);
  });

  it("监听者抛错不影响会话创建", async () => {
    const { manager } = harness(undefined, {
      onStart: () => {
        throw new Error("boom");
      },
    });
    const session = await spawn(manager, "node-1");
    expect(manager.isAlive(session.id)).toBe(true);
  });
});

describe("槽要的会话事实", () => {
  it("pid 取自活着的记录，不认识的会话答 undefined", async () => {
    const { manager } = harness();
    const session = await spawn(manager, "node-1");
    expect(manager.pidOf(session.id)).toBe(1234);
    expect(manager.pidOf("nope")).toBeUndefined();
  });

  it("本机会话与不认识的会话都不算远程", async () => {
    const { manager } = harness();
    const session = await spawn(manager, "node-1");
    expect(manager.isRemote(session.id)).toBe(false);
    expect(manager.isRemote("nope")).toBe(false);
  });

  it("core 重启后接回的 SSH 会话：主机取自节点数据，仍算远程", async () => {
    const { manager, database } = harness();
    database
      .prepare(
        "INSERT INTO boards (id, workspace_id, name, created_at, updated_at) VALUES ('b1', 'ws', 'main', '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z')",
      )
      .run();
    const insertNode = (id: string, data: unknown) =>
      database
        .prepare(
          "INSERT INTO nodes (id, board_id, type, x, y, title, color, data_json, created_at, updated_at) VALUES (?, 'b1', 'terminal', 0, 0, 'n', '#000', ?, '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z')",
        )
        .run(id, JSON.stringify(data));
    insertNode("node-ssh", { kind: "terminal", ssh: { hostId: "host-1" } });
    insertNode("node-local", { kind: "terminal" });
    const remote = await spawn(manager, "node-ssh");
    const local = await spawn(manager, "node-local");
    const adopt = (id: string) => {
      const row = database
        .prepare(
          "SELECT session_key, generation FROM terminal_sessions WHERE id = ?",
        )
        .get(id) as { session_key: string; generation: number };
      (
        manager as unknown as {
          rememberAdopted(key: string, generation: number, pid: number): void;
        }
      ).rememberAdopted(row.session_key, Number(row.generation), 99);
    };
    adopt(remote.id);
    adopt(local.id);
    expect(manager.isRemote(remote.id)).toBe(true);
    expect(manager.isRemote(local.id)).toBe(false);
  });
});
