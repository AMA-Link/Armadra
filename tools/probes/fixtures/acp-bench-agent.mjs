// 流式探针用的脚本化 ACP Agent（acp-view-bench 用）：零依赖、不联网、不碰文件系统。
//
//   node tools/probes/fixtures/acp-bench-agent.mjs [--session-id <id>]
//
// `session/new` 答固定的会话 id（缺省 `bench-session`），好让探针把合成的镜像预先放到
// 约定的路径上。`session/prompt` 的正文里带 `[bench <分块数> <每秒分块数> <每块字符数>]`
// 时，按这个节奏吐 `agent_message_chunk`，每块带 `⟦序号:毫秒时间戳⟧` 标记；没有这个标记
// 的 prompt 回一句 `ok`。stdin 结束即退出。
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { chunkText } from "./acp-session-gen.mjs";

/** `[bench 200 50 48]` → `{ chunks, rate, size }`；没有就 `null`。 */
export function parseScript(text) {
  const match = /\[bench (\d+) (\d+) (\d+)\]/u.exec(text);
  return match === null
    ? null
    : {
        chunks: Number(match[1]),
        rate: Number(match[2]),
        size: Number(match[3]),
      };
}

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const chunk = (sessionId, text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function stream(sessionId, { chunks, rate, size }) {
  const begin = performance.now();
  for (let index = 0; index < chunks; index += 1) {
    const wait = begin + (index * 1000) / rate - performance.now();
    if (wait > 0) await sleep(wait);
    chunk(sessionId, chunkText(index, Date.now(), size));
  }
}

function main() {
  const at = process.argv.indexOf("--session-id");
  const fixed = at === -1 ? "bench-session" : process.argv[at + 1];
  const lines = createInterface({ input: process.stdin });
  let busy = Promise.resolve();
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined || message.method === undefined) return;
    const { id, method, params = {} } = message;
    switch (method) {
      case "initialize":
        send({
          id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { promptCapabilities: {} },
            authMethods: [],
            agentInfo: { name: "acp-bench-agent", version: "1.0.0" },
          },
        });
        return;
      case "session/new":
        send({ id, result: { sessionId: fixed } });
        return;
      case "session/prompt": {
        const text = (Array.isArray(params.prompt) ? params.prompt : [])
          .map((block) => (block?.type === "text" ? block.text : ""))
          .join("");
        const script = parseScript(text);
        // 串行：同一个会话一次只跑一个回合，与真 Agent 一致。
        busy = busy.then(async () => {
          if (script === null) chunk(params.sessionId, "ok");
          else await stream(params.sessionId, script);
          send({ id, result: { stopReason: "end_turn" } });
        });
        return;
      }
      default:
        send({
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        });
    }
  });
  lines.on("close", () => process.exit(0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
