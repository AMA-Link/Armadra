/**
 * 会话列表不看 `cwd` 过滤的假 ACP Agent（只给 `session-list.test.ts` 用）：
 * `session/list` 不管请求里的 `cwd`，一律把「主机上所有项目」的会话报回来，
 * 模拟一个自己不限定目录的 Agent。工作空间根 = 本进程的启动目录。
 */

import { dirname, join } from "node:path";

import { JsonRpcPeer, RpcError } from "@armadra/agent/acp";

const root = process.cwd();

const SESSIONS = [
  { sessionId: "in-root", cwd: root, title: "root" },
  { sessionId: "in-sub", cwd: join(root, "sub"), title: "sub" },
  // 与根同前缀的兄弟目录不算在根里。
  { sessionId: "sibling", cwd: `${root}-sibling`, title: "sibling" },
  { sessionId: "parent", cwd: dirname(root), title: "parent" },
  { sessionId: "elsewhere", cwd: "/somewhere/else", title: "elsewhere" },
  { sessionId: "no-cwd", cwd: "", title: "no cwd" },
];

const peer = new JsonRpcPeer({
  input: process.stdin,
  output: process.stdout,
  onRequest: async (method) => {
    if (method === "initialize") {
      return {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { list: {} } },
        agentInfo: { name: "list-agent", version: "0.0.0" },
      };
    }
    if (method === "session/list") return { sessions: SESSIONS };
    throw new RpcError(-32601, method);
  },
  onNotification: () => {},
  onClose: () => process.exit(0),
});
void peer;
