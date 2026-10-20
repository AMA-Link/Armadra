// 合成的 ACP 会话数据（ACP 渐进式展示 B0，acp-view-bench 用）。
//
// 三样东西，全是确定性的（同一个种子产出同一字节），不含任何真实对话：
//
//   * `mirrorRecords`：core 写的 ACP 镜像（`<数据目录>/acp/<节点>/<会话>.acp.jsonl`，
//     形状见 `core/history/acp-mirror.ts`）。每个回合 = 一条用户 prompt、若干行助手
//     分块（与 core 逐块写镜像一致）、每隔几回合一对工具调用与结果；
//   * `claudeTranscriptLines`：Claude Code 形状的转录行（`{type, message:{content}}`），
//     长到给定字节数为止；
//   * `chunkText`：流式探针的分块正文，带 `⟦序号:毫秒时间戳⟧` 标记，收端据此算延迟。
//
// 命令行：
//   node tools/probes/fixtures/acp-session-gen.mjs mirror <文件> [--turns 300] [--seed 1]
//   node tools/probes/fixtures/acp-session-gen.mjs transcript <文件> [--mib 5] [--seed 1]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** 小而稳的伪随机数（mulberry32）：不依赖平台的 `Math.random`。 */
export function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = (
  "session turn stream chunk render markdown list table code block agent tool " +
  "result update patch diff file path line search build test pass fail retry " +
  "queue cursor offset buffer frame window scroll layout state reducer store " +
  "memo batch merge sync cache index node board canvas terminal prompt reply"
).split(" ");

const pick = (random, list) => list[Math.floor(random() * list.length)];

function sentence(random, words) {
  const out = [];
  for (let i = 0; i < words; i += 1) out.push(pick(random, WORDS));
  const text = out.join(" ");
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

/**
 * 一段约 `target` 字节的 Markdown：标题、段落、列表、行内代码、代码块、表格轮着来。
 * 页面渲染的成本取决于这种混合内容，纯文本量不出来。
 */
export function markdownBody(random, target = 1600) {
  const parts = [];
  let size = 0;
  let kind = 0;
  while (size < target) {
    let block;
    switch (kind % 5) {
      case 0:
        block = `## ${sentence(random, 3)}\n\n${sentence(random, 14)} ${sentence(random, 10)}`;
        break;
      case 1:
        block = [1, 2, 3, 4]
          .map(
            (n) => `- **${pick(random, WORDS)}** ${n}: ${sentence(random, 6)}`,
          )
          .join("\n");
        break;
      case 2:
        block = `Run \`pnpm --filter ${pick(random, WORDS)} test\` and check \`${pick(random, WORDS)}.ts\`. ${sentence(random, 12)}`;
        break;
      case 3:
        block = `\`\`\`ts\nexport function ${pick(random, WORDS)}(value: number): number {\n  const next = value + ${Math.floor(random() * 100)};\n  return next * 2;\n}\n\`\`\``;
        break;
      default:
        block = `| name | value |\n| --- | --- |\n| ${pick(random, WORDS)} | ${Math.floor(random() * 1000)} |\n| ${pick(random, WORDS)} | ${Math.floor(random() * 1000)} |`;
    }
    parts.push(block);
    size += block.length + 2;
    kind += 1;
  }
  return parts.join("\n\n");
}

/** 把 `text` 切成 `count` 段（尽量落在空白处），模拟逐块到达的助手回复。 */
export function splitChunks(text, count) {
  if (count <= 1) return [text];
  const chunks = [];
  const step = Math.ceil(text.length / count);
  let from = 0;
  while (from < text.length) {
    let to = Math.min(text.length, from + step);
    const space = text.indexOf(" ", to);
    if (space !== -1 && space - to < 24) to = space + 1;
    chunks.push(text.slice(from, to));
    from = to;
  }
  return chunks;
}

/**
 * N 个回合的镜像记录。`turnLabel(n)` 出现在每条助手回复开头（`turn-<n>`），页面
 * 探针据此判断「第 n 回合已经画出来」。
 *
 * @param {{ turns?: number, seed?: number, replyBytes?: number, chunksPerReply?: number, toolEvery?: number, start?: number }} options
 */
export function mirrorRecords({
  turns = 300,
  seed = 1,
  replyBytes = 1600,
  chunksPerReply = 4,
  toolEvery = 3,
  start = Date.UTC(2026, 9, 20, 8, 0, 0),
} = {}) {
  const random = rng(seed);
  const records = [];
  let clock = start;
  const at = () => new Date((clock += 1500)).toISOString();
  for (let turn = 1; turn <= turns; turn += 1) {
    records.push({
      role: "user",
      blocks: [
        {
          type: "text",
          text: `${turnLabel(turn)} ask: ${sentence(random, 9)}`,
        },
      ],
      at: at(),
    });
    if (turn % toolEvery === 0) {
      const id = `tool-${turn}`;
      records.push({
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            name: "Read file",
            id,
            input: { path: `src/${pick(random, WORDS)}.ts` },
            kind: "read",
          },
        ],
        at: at(),
      });
      records.push({
        role: "user",
        blocks: [
          {
            type: "tool_result",
            id,
            content: markdownBody(random, 600),
          },
        ],
        at: at(),
      });
    }
    const reply = `${turnLabel(turn)} reply\n\n${markdownBody(random, replyBytes)}`;
    for (const text of splitChunks(reply, chunksPerReply)) {
      records.push({
        role: "assistant",
        blocks: [{ type: "text", text }],
        at: at(),
      });
    }
  }
  return records;
}

export const turnLabel = (turn) => `turn-${turn}`;

/** Claude Code 形状的转录行，直到总长至少 `bytes`。 */
export function claudeTranscriptLines({ bytes = 1024 * 1024, seed = 1 } = {}) {
  const random = rng(seed);
  const lines = [];
  let size = 0;
  let turn = 0;
  let clock = Date.UTC(2026, 9, 20, 8, 0, 0);
  const push = (value) => {
    const line = JSON.stringify(value);
    lines.push(line);
    size += Buffer.byteLength(line) + 1;
  };
  while (size < bytes) {
    turn += 1;
    push({
      type: "user",
      timestamp: new Date((clock += 2000)).toISOString(),
      message: {
        role: "user",
        content: `${turnLabel(turn)} ask: ${sentence(random, 9)}`,
      },
    });
    push({
      type: "assistant",
      timestamp: new Date((clock += 2000)).toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: markdownBody(random, 1200) },
          {
            type: "tool_use",
            id: `toolu_${turn}`,
            name: "Bash",
            input: { command: `pnpm --filter ${pick(random, WORDS)} test` },
          },
        ],
      },
    });
    push({
      type: "user",
      timestamp: new Date((clock += 2000)).toISOString(),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `toolu_${turn}`,
            content: markdownBody(random, 900),
          },
        ],
      },
    });
  }
  return lines;
}

/**
 * 流式探针的一个分块：`⟦序号:时间戳⟧ ` 开头，补到约 `size` 字符。补的是普通词，
 * 页面把它们累加进同一条助手消息里（与真实的逐块回复一样）。
 */
export function chunkText(index, stamp, size = 48) {
  const head = `⟦${index}:${stamp}⟧ `;
  let body = "";
  for (let i = 0; body.length + head.length < size; i += 1) {
    body += `${WORDS[(index * 7 + i) % WORDS.length]} `;
  }
  return `${head}${body}`;
}

/** 解析 `chunkText` 的标记；认不出答 `null`。 */
export function parseChunkMarker(text) {
  const match = /⟦(\d+):(\d+)⟧/u.exec(text);
  return match === null
    ? null
    : { index: Number(match[1]), stamp: Number(match[2]) };
}

export function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    rows
      .map((row) => (typeof row === "string" ? row : JSON.stringify(row)))
      .join("\n") + "\n",
    { mode: 0o600 },
  );
}

function main(argv) {
  const [kind, file, ...rest] = argv;
  const flag = (name, fallback) => {
    const at = rest.indexOf(`--${name}`);
    return at === -1 ? fallback : Number(rest[at + 1]);
  };
  if ((kind !== "mirror" && kind !== "transcript") || file === undefined) {
    console.error(
      "用法：acp-session-gen.mjs mirror|transcript <文件> [--turns N | --mib N] [--seed N]",
    );
    process.exit(2);
  }
  if (kind === "mirror") {
    writeJsonl(
      file,
      mirrorRecords({ turns: flag("turns", 300), seed: flag("seed", 1) }),
    );
  } else {
    writeJsonl(
      file,
      claudeTranscriptLines({
        bytes: Math.floor(flag("mib", 5) * 1024 * 1024),
        seed: flag("seed", 1),
      }),
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
