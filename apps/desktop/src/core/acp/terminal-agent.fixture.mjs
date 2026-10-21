/**
 * 会向客户端要终端的假 ACP Agent（只给 `terminal-session.test.ts` 用）。
 *
 * 提示里的标记决定做什么：
 *   [term]        跑一条会输出两行、退出码 5 的命令：create → 挂到工具 → wait_for_exit → output → release
 *   [term-hang]   起一个写 pid 文件然后一直挂着的命令，回合结束也不 release、不 kill
 *   [term-escape] 想在工作空间之外开终端，把错误回报出来
 *   [caps]        回报 initialize 时客户端声明的 terminal 能力
 */

import { JsonRpcPeer, RpcError } from "@armadra/agent/acp";

let clientTerminal;
const SESSION = "term-agent-1";

const peer = new JsonRpcPeer({
  input: process.stdin,
  output: process.stdout,
  onRequest: async (method, params) => {
    if (method === "initialize") {
      clientTerminal = params?.clientCapabilities?.terminal;
      return {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "term-agent", version: "0.0.0" },
      };
    }
    if (method === "session/new") {
      return {
        sessionId: SESSION,
        modes: {
          currentModeId: "build",
          availableModes: [
            { id: "build", name: "build" },
            { id: "plan", name: "plan" },
          ],
        },
      };
    }
    if (method === "session/set_mode" || method === "session/set_config_option")
      return {};
    if (method === "session/prompt") return prompt(params);
    throw new RpcError(-32601, method);
  },
  onNotification: () => {},
  onClose: () => process.exit(0),
});

const say = (text) =>
  peer.notify("session/update", {
    sessionId: SESSION,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });

const update = (body) =>
  peer.notify("session/update", { sessionId: SESSION, update: body });

async function prompt(params) {
  const text = (params.prompt ?? []).map((block) => block.text ?? "").join(" ");
  if (text.includes("[caps]"))
    await say(`caps:${JSON.stringify(clientTerminal)}`);
  if (text.includes("[term]")) {
    const { terminalId } = await peer.request("terminal/create", {
      sessionId: SESSION,
      command: process.execPath,
      args: [
        "-e",
        "console.log('line one'); setTimeout(() => { console.log('line two'); process.exit(5); }, 300)",
      ],
    });
    await update({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "Run script",
      kind: "execute",
      status: "in_progress",
      content: [{ type: "terminal", terminalId }],
    });
    const exit = await peer.request("terminal/wait_for_exit", {
      sessionId: SESSION,
      terminalId,
    });
    const out = await peer.request("terminal/output", {
      sessionId: SESSION,
      terminalId,
    });
    await peer.request("terminal/release", { sessionId: SESSION, terminalId });
    // 释放之后 Agent 再发一次只有 terminalId 的更新：输出不能被冲掉。
    await update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "failed",
      content: [{ type: "terminal", terminalId }],
    });
    await say(
      `exit:${JSON.stringify(exit)} output:${JSON.stringify(out.output)}`,
    );
  }
  if (text.includes("[term-hang]")) {
    const { terminalId } = await peer.request("terminal/create", {
      sessionId: SESSION,
      command: process.execPath,
      args: [
        "-e",
        "require('fs').writeFileSync('hang.pid', String(process.pid)); setTimeout(() => {}, 120000)",
      ],
    });
    await update({
      sessionUpdate: "tool_call",
      toolCallId: "tc-2",
      title: "Run forever",
      kind: "execute",
      status: "in_progress",
      content: [{ type: "terminal", terminalId }],
    });
    await say("started");
  }
  if (text.includes("[term-escape]")) {
    try {
      await peer.request("terminal/create", {
        sessionId: SESSION,
        command: process.execPath,
        args: ["-e", "0"],
        cwd: "/",
      });
      await say("escape:allowed");
    } catch (error) {
      await say(`escape:${error.code}`);
    }
  }
  return { stopReason: "end_turn" };
}
