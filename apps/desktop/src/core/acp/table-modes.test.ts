import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AcpMirror, mirrorPath } from "./mirror";
import { AcpSession } from "./session";
import { AcpError } from "./client";
import { type AcpHostSession, startAcp } from "./host";
import type { AcpSessionNotification } from "./types";

/**
 * 模式目录来自兼容表的家（grok，`ACP_REPORTED_MODES` 的 `table`）：agent 的
 * `session/new|load|resume` 不返回 `modes`，但认 `session/set_mode`。真账号
 * 实测（1.0.92）的形状，用一个假 agent 复现：
 *   * `default` / `plan` 被接受并发 `current_mode_update`；`ask` / `agent` 也被接受
 *     （agent 角色），`acceptEdits` 报 `unknown mode id`；
 *   * `session/load` 恢复上次的模式，答复里不说是哪个。
 */

const AGENT = `
const fs = require("node:fs");
const log = process.argv[2];
let restored = "default";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const seen = (line) => fs.appendFileSync(log, line + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    const reply = (result) => write({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        reply({
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {}, list: {}, close: {} },
          },
          authMethods: [],
        });
        break;
      case "session/new":
        reply({ sessionId: "s-1" });
        break;
      case "session/load":
        seen("load");
        // 恢复了上次的模式（plan），答复里没有 modes。
        restored = "plan";
        reply({});
        break;
      case "session/resume":
        seen("resume");
        restored = "plan";
        reply({});
        break;
      case "session/set_mode": {
        const id = message.params.modeId;
        seen("set_mode " + id);
        if (!["default", "ask", "plan", "agent"].includes(id)) {
          write({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: "Invalid params", data: "unknown mode id: " + id },
          });
        } else {
          if (id !== restored) {
            restored = id;
            write({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: message.params.sessionId,
                update: { sessionUpdate: "current_mode_update", currentModeId: id },
              },
            });
          }
          reply({});
        }
        break;
      }
      default:
        if (message.id !== undefined) reply({});
    }
  }
});
`;

const sessions: AcpHostSession[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.process.terminate()));
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  readonly log: () => string[];
  start(
    options: Partial<Parameters<typeof startAcp>[0]>,
  ): Promise<AcpHostSession>;
}

function rig(agentId = "grok"): Rig {
  const dir = mkdtempSync(join(tmpdir(), "armadra-table-modes-"));
  dirs.push(dir);
  const script = join(dir, "agent.cjs");
  const log = join(dir, "log.txt");
  writeFileSync(script, AGENT);
  writeFileSync(log, "");
  return {
    log: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
    start: async (options) => {
      const session = await startAcp({
        program: process.execPath,
        args: [script, log],
        cwd: tmpdir(),
        agentId,
        ...options,
      });
      sessions.push(session);
      return session;
    },
  };
}

describe("目录来自兼容表的家", () => {
  it("新会话：目录是表（default / plan），现值 default，不另发 set_mode", async () => {
    const r = rig();
    const session = await r.start({});
    expect(session.modes).toEqual({
      availableModes: [
        { id: "default", name: "default" },
        { id: "plan", name: "plan" },
      ],
      currentModeId: "default",
    });
    expect(session.modesFromTable).toBe(true);
    expect(r.log()).toEqual([]);
  });

  it("以 plan 启动：发 set_mode plan，落上了", async () => {
    const r = rig();
    const updates: string[] = [];
    const session = await r.start({
      modeId: "plan",
      requireMode: true,
      onUpdate: (n: AcpSessionNotification) =>
        updates.push(String(n.update.sessionUpdate)),
    });
    expect(r.log()).toEqual(["set_mode plan"]);
    expect(session.modeApplied).toBe(true);
    expect(session.modes?.currentModeId).toBe("plan");
    expect(updates).toContain("current_mode_update");
  });

  it("要一个表里没有的模式（auto-edit 的 acceptEdits）：requireMode 时拒绝", async () => {
    const r = rig();
    await expect(
      r.start({ modeId: "acceptEdits", requireMode: true }),
    ).rejects.toMatchObject({ code: "acp_mode_unavailable" });
    await expect(
      r.start({ modeId: "acceptEdits", requireMode: true }),
    ).rejects.toBeInstanceOf(AcpError);
    // 没有 requireMode：不落、不拦。
    const session = await r.start({ modeId: "acceptEdits" });
    expect(session.modeApplied).toBe(false);
  });

  it("session/load 之后：agent 恢复了上次的 plan，没要求模式也强制落一次 default", async () => {
    const r = rig();
    const session = await r.start({
      resume: { sessionId: "s-1", method: "load" },
    });
    expect(session.opened).toBe("load");
    expect(r.log()).toEqual(["load", "set_mode default"]);
    expect(session.modeApplied).toBe(true);
    expect(session.modes?.currentModeId).toBe("default");
  });

  it("session/resume 同样：落一次 default", async () => {
    const r = rig();
    const session = await r.start({
      resume: { sessionId: "s-1", method: "resume" },
      needReplay: false,
    });
    expect(session.opened).toBe("resume");
    expect(r.log()).toEqual(["resume", "set_mode default"]);
    expect(session.modes?.currentModeId).toBe("default");
  });

  it("接回时要求了 plan：落 plan，不落 default", async () => {
    const r = rig();
    const session = await r.start({
      resume: { sessionId: "s-1", method: "load" },
      modeId: "plan",
      requireMode: true,
    });
    expect(r.log()).toEqual(["load", "set_mode plan"]);
    expect(session.modes?.currentModeId).toBe("plan");
  });

  it("别的家不受影响：不返回 modes 就没有模式，接回也不多发 set_mode", async () => {
    const r = rig("claude");
    const session = await r.start({
      resume: { sessionId: "s-1", method: "load" },
    });
    expect(session.modes).toBeNull();
    expect(session.modesFromTable).toBeUndefined();
    expect(r.log()).toEqual(["load"]);
  });
});

describe("会话里的模式（目录来自兼容表）", () => {
  async function openSession(r: Rig) {
    const dir = mkdtempSync(join(tmpdir(), "armadra-table-session-"));
    dirs.push(dir);
    const node = "11111111-2222-4333-8444-555555555555";
    const session = new AcpSession({
      rowId: "row-1",
      generation: 1,
      nodeId: node,
      workspaceId: "ws",
      agentId: "grok",
      sink: {
        signal: () => undefined,
        publish: () => undefined,
        cancelled: () => undefined,
        transcriptPath: (_id, mirror) => mirror,
      },
      mirrorFor: (id) => new AcpMirror(mirrorPath(dir, node, id)),
    });
    const host = await r.start({ ...session.callbacks() });
    session.opened(host);
    return { session, host };
  }

  async function until(ready: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error("never happened");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("会话内切 plan 与切回 default 都走 set_mode（目录里有）", async () => {
    const r = rig();
    const { session } = await openSession(r);
    await session.setMode("plan");
    expect(session.modes?.currentModeId).toBe("plan");
    await session.setMode("default");
    expect(session.modes?.currentModeId).toBe("default");
    expect(r.log()).toEqual(["set_mode plan", "set_mode default"]);
    // agent 角色 `agent` / `ask` 不在表里：会话层照旧答 acp_mode_unavailable。
    await expect(session.setMode("agent")).rejects.toMatchObject({
      code: "acp_mode_unavailable",
    });
  });

  it("agent 自己发来的 current_mode_update：表里有的认，agent / ask 丢掉", async () => {
    const r = rig();
    const { session, host } = await openSession(r);
    // 绕过会话层直接让 agent 切：它会发 current_mode_update。
    await host.process.setMode(host.sessionId, "plan");
    await until(() => session.modes?.currentModeId === "plan");
    await host.process.setMode(host.sessionId, "agent");
    await host.process.setMode(host.sessionId, "ask");
    // 再切一个表里有的，保证前面两条更新已经被处理过。
    await host.process.setMode(host.sessionId, "default");
    await until(() => session.modes?.currentModeId === "default");
    expect(session.modes?.currentModeId).toBe("default");
    expect(r.log()).toEqual([
      "set_mode plan",
      "set_mode agent",
      "set_mode ask",
      "set_mode default",
    ]);
  });
});
