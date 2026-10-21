// 流式探针用的脚本化 ACP Agent（acp-view-bench 用）：零依赖、不联网、不碰文件系统。
//
//   node tools/probes/fixtures/acp-bench-agent.mjs [--session-id <id>]
//
// `session/new` 答固定的会话 id（缺省 `bench-session`），好让探针把合成的镜像预先放到
// 约定的路径上。`session/prompt` 的正文里带 `[bench <分块数> <每秒分块数> <每块字符数>]`
// 时，按这个节奏吐 `agent_message_chunk`，每块带 `⟦序号:毫秒时间戳⟧` 标记；没有这个标记
// 的 prompt 回一句 `ok`。stdin 结束即退出。
//
// `--history <回合数>`（可带 `--history-seed`）：声明 `loadSession`，`session/load` 回放这么多
// 回合的合成历史（`acp-session-gen.mjs` 的 `mirrorRecords`），之后答空结果。这样探针不用把
// 历史直接写进 SQLite，而是走 core 的回放路径，把历史写进会话时间线。
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { chunkText, mirrorRecords, replayUpdates } from "./acp-session-gen.mjs";

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

/** `--history N` 的值；没有就 0。 */
function numberFlag(name, fallback) {
  const at = process.argv.indexOf(name);
  const value = at === -1 ? fallback : Number(process.argv[at + 1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function main() {
  const at = process.argv.indexOf("--session-id");
  const fixed = at === -1 ? "bench-session" : process.argv[at + 1];
  const history = numberFlag("--history", 0);
  const historySeed = numberFlag("--history-seed", 1);
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
            agentCapabilities: {
              promptCapabilities: {},
              ...(history > 0 ? { loadSession: true } : {}),
            },
            authMethods: [],
            agentInfo: { name: "acp-bench-agent", version: "1.0.0" },
          },
        });
        return;
      case "session/new":
        send({ id, result: { sessionId: fixed } });
        return;
      case "session/load": {
        if (history === 0 || params.sessionId !== fixed) {
          send({
            id,
            error: { code: -32602, message: "unknown session" },
          });
          return;
        }
        for (const update of replayUpdates(
          mirrorRecords({ turns: history, seed: historySeed }),
        ))
          send({
            method: "session/update",
            params: { sessionId: fixed, update },
          });
        send({ id, result: {} });
        return;
      }
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
