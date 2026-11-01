/**
 * 发 URL 模式 `elicitation/create` 的假 ACP Agent（只给 `elicitation-complete.test.ts` 用）。
 *
 * 任何提示：先发一条带 `elicitationId` 的 URL 模式请求，等客户端答（或被撤回），
 * 再以 `end_turn` 收尾，并把客户端的答复动作作为文本回出来。
 */

import { JsonRpcPeer, RpcError } from "@armadra/agent/acp";

const SESSION = "url-agent-1";

const peer = new JsonRpcPeer({
  input: process.stdin,
  output: process.stdout,
  onRequest: async (method) => {
    if (method === "initialize") {
      return {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "url-agent", version: "0.0.0" },
      };
    }
    if (method === "session/new") return { sessionId: SESSION };
    if (method === "session/prompt") {
      let action = "error";
      try {
        const answer = await peer.request("elicitation/create", {
          sessionId: SESSION,
          mode: "url",
          message: "Authorize",
          url: "https://example.com/auth",
          elicitationId: "el-1",
        });
        action = answer.action;
      } catch {
        // 撤回或连接关闭。
      }
      await peer.notify("session/update", {
        sessionId: SESSION,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `answered ${action}` },
        },
      });
      return { stopReason: "end_turn" };
    }
    throw new RpcError(-32601, method);
  },
  onNotification: () => {},
  onClose: () => process.exit(0),
});
