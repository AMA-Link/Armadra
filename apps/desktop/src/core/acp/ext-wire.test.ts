import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RPC_ERRORS, RpcError } from "@armadra/agent/acp";

import { type AcpHostSession, startAcp } from "./host";
import { type AcpExtRequestSpec, GROK_EXIT_PLAN_MODE } from "./ext-requests";
import { pendingCardOf } from "../agent/pending-cards";
import { CANVAS_MCP_NAME } from "./mcp";
import { AcpMirror, mirrorPath } from "./mirror";
import { AcpSession } from "./session";

/**
 * 扩展请求经**真实的 `AcpClient`**（0.24.0 的 `onExtRequest`）走一遍线路：一个脚本
 * 化的假 agent 在 `session/prompt` 里按指令发 `_` 开头的请求，把客户端的答复（result
 * 或 error）记进日志。覆盖 -32601（未核实的规格、未登记的方法）、-32800（拒绝、撤回）、
 * -32603（映射抛非 `RpcError`），以及会话层：同 `toolCallId` 先到自家工具的 `tool_call`
 * 之后，计划卡进了审批表、没有被 `autoApproveOwnTool` 代答（对照：普通审批照旧被放行）。
 */

const AGENT = `
const fs = require("node:fs");
const log = process.argv[2];
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = (what, message) =>
  fs.appendFileSync(log, JSON.stringify({ what, result: message.result, error: message.error }) + "\\n");
let buffer = "";
let promptId;
const waiting = new Map();
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    if (message.method === undefined && waiting.has(message.id)) {
      record(waiting.get(message.id), message);
      waiting.delete(message.id);
      if (waiting.size === 0 && promptId !== undefined) {
        write({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
        promptId = undefined;
      }
      continue;
    }
    const reply = (result) => write({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
        break;
      case "session/new":
        reply({ sessionId: "s-1" });
        break;
      case "session/prompt": {
        promptId = message.id;
        const directive = JSON.parse(message.params.prompt[0].text);
        if (directive.update) {
          write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: directive.update } });
        }
        let next = 900;
        for (const request of directive.requests ?? []) {
          const id = next++;
          waiting.set(id, request.what);
          write({ jsonrpc: "2.0", id, method: request.method, params: request.params });
          if (request.cancelAfterMs !== undefined) {
            setTimeout(() => write({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: id } }), request.cancelAfterMs);
          }
        }
        if (waiting.size === 0) {
          write({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
          promptId = undefined;
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

const PLAN = {
  sessionId: "s-1",
  toolCallId: "call-1",
  planContent: "# Plan\n1. x\n",
};

/** 一个核实过的假规格。 */
function verified(
  reply: AcpExtRequestSpec["reply"] = () => ({ approved: true }),
): AcpExtRequestSpec {
  return { ...GROK_EXIT_PLAN_MODE, verified: true, reply };
}

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "armadra-test-ext-wire-"));
  dirs.push(dir);
  const script = join(dir, "agent.cjs");
  const log = join(dir, "log.jsonl");
  writeFileSync(script, AGENT);
  writeFileSync(log, "");
  const logged = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            what: string;
            result?: unknown;
            error?: { code: number };
          },
      );
  const signals: { signal: unknown; request?: unknown }[] = [];
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error("never happened");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  async function open(extRequests: Record<string, AcpExtRequestSpec>) {
    const session = new AcpSession({
      rowId: "row-1",
      generation: 1,
      nodeId: "11111111-2222-4333-8444-555555555555",
      workspaceId: "ws",
      agentId: "grok",
      sink: {
        signal: (signal, request) => signals.push({ signal, request }),
        publish: () => undefined,
        cancelled: () => undefined,
        transcriptPath: (_id, mirror) => mirror,
      },
      mirrorFor: (id) =>
        new AcpMirror(
          mirrorPath(dir, "11111111-2222-4333-8444-555555555555", id),
        ),
    });
    const host = await startAcp({
      program: process.execPath,
      args: [script, log],
      cwd: tmpdir(),
      agentId: "grok",
      extRequests,
      ...session.callbacks(),
    });
    sessions.push(host);
    session.opened(host);
    const prompt = (directive: unknown) =>
      host.process.prompt(host.sessionId, [
        { type: "text", text: JSON.stringify(directive) },
      ]);
    return { session, host, prompt };
  }
  return { logged, until, open, signals };
}

const plan = (extra: Record<string, unknown> = {}) => ({
  what: "plan",
  method: "_x.ai/exit_plan_mode",
  params: PLAN,
  ...extra,
});

describe("扩展请求经真实 AcpClient 的线路", () => {
  it("生产配置（grok 的规格 verified: false）：请求回 -32601，不挂卡——升级之后生产行为不变", async () => {
    const r = rig();
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": GROK_EXIT_PLAN_MODE,
    });
    await prompt({ requests: [plan()] });
    expect(r.logged()).toEqual([
      expect.objectContaining({
        what: "plan",
        error: expect.objectContaining({ code: -32601 }),
      }),
    ]);
    expect(session.pending()).toEqual([]);
  });

  it("没登记的方法：-32601；非 `_` 开头的未知方法也是", async () => {
    const r = rig();
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": verified(),
    });
    await prompt({
      requests: [
        { what: "other", method: "_x.ai/never_heard", params: {} },
        { what: "plain", method: "unknown/method", params: {} },
      ],
    });
    const codes = Object.fromEntries(
      r.logged().map((entry) => [entry.what, entry.error?.code]),
    );
    expect(codes).toEqual({ other: -32601, plain: -32601 });
    expect(session.pending()).toEqual([]);
  });

  it("批准：回成功的 result（映射函数的应答）", async () => {
    const r = rig();
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": verified(),
    });
    const turn = prompt({ requests: [plan()] });
    await r.until(() => session.pending().length === 1);
    const [card] = session.pending();
    expect(session.answer(card!.pendingId, "approve")).toBe(true);
    await turn;
    expect(r.logged()).toEqual([{ what: "plan", result: { approved: true } }]);
  });

  it("拒绝：回 -32800，不是成功", async () => {
    const r = rig();
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": verified(),
    });
    const turn = prompt({ requests: [plan()] });
    await r.until(() => session.pending().length === 1);
    expect(session.answer(session.pending()[0]!.pendingId, "reject")).toBe(
      true,
    );
    await turn;
    expect(r.logged()).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: -32800 }),
      }),
    ]);
    expect(r.logged()[0]?.result).toBeUndefined();
  });

  it("计划卡挂起时：审批记录的请求里有 core 写的 card，状态帧的 pendingCard 查得到；结算后撤掉", async () => {
    const r = rig();
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": verified(),
    });
    const turn = prompt({ requests: [plan()] });
    await r.until(() => session.pending().length === 1);
    const pendingId = session.pending()[0]!.pendingId;
    expect(pendingCardOf(pendingId)).toBe("plan");
    const permission = r.signals.find(
      (entry) => (entry.signal as { signal?: string }).signal === "permission",
    );
    expect(permission?.request).toMatchObject({
      protocol: "acp",
      card: "plan",
    });
    session.answer(pendingId, "reject");
    await turn;
    expect(pendingCardOf(pendingId)).toBeUndefined();
  });

  it("会话 cancel：卡片收起，请求回 -32800", async () => {
    const r = rig();
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": verified(),
    });
    const turn = prompt({ requests: [plan()] });
    await r.until(() => session.pending().length === 1);
    await session.cancel();
    await turn;
    expect(session.pending()).toEqual([]);
    expect(r.logged()).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: -32800 }),
      }),
    ]);
  });

  it("对端撤回请求（$/cancel_request）：卡片收起，请求回 -32800", async () => {
    const r = rig();
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": verified(),
    });
    const turn = prompt({ requests: [plan({ cancelAfterMs: 150 })] });
    await r.until(() => session.pending().length === 1);
    await turn;
    expect(session.pending()).toEqual([]);
    expect(r.logged()).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: -32800 }),
      }),
    ]);
  });

  it("映射函数抛了非 RpcError：-32603（上游把它藏成 internal error）", async () => {
    const r = rig();
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": verified(() => {
        throw new Error("secret detail");
      }),
    });
    const turn = prompt({ requests: [plan()] });
    await r.until(() => session.pending().length === 1);
    session.answer(session.pending()[0]!.pendingId, "approve");
    await turn;
    const [entry] = r.logged();
    expect(entry?.error?.code).toBe(-32603);
    expect(JSON.stringify(entry)).not.toContain("secret detail");
  });

  it("映射函数抛 RpcError：错误码原样回", async () => {
    const r = rig();
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": verified(() => {
        throw new RpcError(RPC_ERRORS.invalidParams, "nope");
      }),
    });
    const turn = prompt({ requests: [plan()] });
    await r.until(() => session.pending().length === 1);
    session.answer(session.pending()[0]!.pendingId, "approve");
    await turn;
    expect(r.logged()[0]?.error?.code).toBe(-32602);
  });
});

describe("会话层：计划卡不被自家工具的免审批代答", () => {
  const ownTool = {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "canvas_list",
    _meta: {
      claudeCode: { toolName: `mcp__${CANVAS_MCP_NAME}__canvas_list` },
    },
  };

  it("假 Agent 先发自家工具的 tool_call，再发同 toolCallId 的扩展请求：请求进了审批表，没有被代答", async () => {
    const r = rig();
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": verified(),
    });
    const turn = prompt({ update: ownTool, requests: [plan()] });
    await r.until(() => session.pending().length === 1);
    // 过了一会儿还在：没有被自动放行。
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(session.pending()).toHaveLength(1);
    expect(r.logged()).toEqual([]);
    session.answer(session.pending()[0]!.pendingId, "reject");
    await turn;
    expect(r.logged()[0]?.error?.code).toBe(-32800);
  });

  it("规格标题为空（卡片没有任何身份信息）、同 id 的自家工具调用：靠 origin 守卫仍然挂卡，没有被代答", async () => {
    const r = rig();
    const untitled: AcpExtRequestSpec = {
      ...verified(),
      card: (given) => {
        const card = GROK_EXIT_PLAN_MODE.card(given);
        return card === undefined ? undefined : { ...card, title: "" };
      },
    };
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": untitled,
    });
    const turn = prompt({ update: ownTool, requests: [plan()] });
    await r.until(() => session.pending().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(session.pending()).toHaveLength(1);
    expect(r.logged()).toEqual([]);
    session.answer(session.pending()[0]!.pendingId, "reject");
    await turn;
  });

  it("对照：同样先到自家工具的 tool_call，普通 session/request_permission 照旧被放行", async () => {
    const r = rig();
    const { session, prompt } = await r.open({
      "_x.ai/exit_plan_mode": verified(),
    });
    await prompt({
      update: ownTool,
      requests: [
        {
          what: "perm",
          method: "session/request_permission",
          params: {
            sessionId: "s-1",
            toolCall: { toolCallId: "call-1" },
            options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
          },
        },
      ],
    });
    expect(session.pending()).toEqual([]);
    expect(r.logged()).toEqual([
      expect.objectContaining({
        result: { outcome: { outcome: "selected", optionId: "yes" } },
      }),
    ]);
  });
});
