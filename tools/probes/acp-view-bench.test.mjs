// acp-view-bench.mjs 的纯函数、合成数据与脚本化假 Agent：参数、统计、比对规则、输出
// 形状。真正的负载（起 core、Chrome）夜间跑，不进 PR CI。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  METRICS,
  chunkFrame,
  chunkMarkers,
  compare,
  cpuTime,
  isTurnFrame,
  longTaskSummary,
  parseArgs,
  percentile,
  platformKey,
  renderTable,
  summarize,
} from "./acp-view-bench.mjs";
import { parseScript } from "./fixtures/acp-bench-agent.mjs";
import {
  chunkText,
  claudeTranscriptLines,
  markdownBody,
  mirrorRecords,
  parseChunkMarker,
  replayUpdates,
  rng,
  splitChunks,
  turnLabel,
} from "./fixtures/acp-session-gen.mjs";

const agentPath = fileURLToPath(
  new URL("./fixtures/acp-bench-agent.mjs", import.meta.url),
);
const baselinePath = fileURLToPath(
  new URL("./acp-view-bench-baseline.json", import.meta.url),
);

test("parseArgs: 缺省是设计的场景，数字与开关有校验", () => {
  const options = parseArgs([]);
  assert.equal(options.turns, 300);
  assert.equal(options.rate, 50);
  assert.equal(options.chunks, 200);
  assert.equal(options.page, false);
  assert.ok(options.baseline.endsWith("acp-view-bench-baseline.json"));

  const custom = parseArgs([
    "out",
    "--turns=50",
    "--rate",
    "20",
    "--transcript-mib",
    "0.5",
    "--page",
    "--no-baseline",
  ]);
  assert.equal(custom.output, "out");
  assert.equal(custom.turns, 50);
  assert.equal(custom.rate, 20);
  assert.equal(custom.transcriptMib, 0.5);
  assert.equal(custom.page, true);
  assert.equal(custom.baseline, undefined);

  assert.throws(() => parseArgs(["--turns", "0"]), /正整数|正数/);
  assert.throws(() => parseArgs(["--turns", "1.5"]), /正整数/);
  assert.throws(() => parseArgs(["--rate"]), /缺值/);
  assert.throws(() => parseArgs(["--bogus"]), /不认识/);
  assert.throws(() => parseArgs(["a", "b"]), /多余/);
  assert.throws(
    () => parseArgs(["--no-baseline", "--write-baseline"]),
    /不能一起用/,
  );
});

test("percentile 与 summarize", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([4, 1, 3, 2], 100), 4);
  assert.deepEqual(summarize([]), { n: 0, p50: null, p95: null, max: null });
  assert.deepEqual(summarize([10, 20, 30, 40, 50]), {
    n: 5,
    p50: 30,
    p95: 50,
    max: 50,
  });
});

test("longTaskSummary 只算起点落在窗口里的长任务", () => {
  const tasks = [
    { start: 10, duration: 60 },
    { start: 100, duration: 120 },
    { start: 200, duration: 80 },
    { start: 900, duration: 500 },
  ];
  assert.deepEqual(longTaskSummary(tasks, 50, 300), {
    count: 2,
    totalMs: 200,
    maxMs: 120,
  });
  assert.deepEqual(longTaskSummary([], 0, 10), {
    count: 0,
    totalMs: 0,
    maxMs: 0,
  });
});

test("compare: 差 20% 以上且超过绝对容差才算退化，只记录的指标不判", () => {
  const baseline = {
    openTimelineMs: 100,
    streamLatencyP50Ms: 2,
    streamDeliveredRatio: 1,
    openTimelineBytes: 1000,
  };
  const rows = compare(
    {
      openTimelineMs: 160,
      streamLatencyP50Ms: 4,
      streamDeliveredRatio: 0.5,
      openTimelineBytes: 99_999,
    },
    baseline,
  );
  const by = Object.fromEntries(rows.map((row) => [row.metric, row]));
  assert.equal(by.openTimelineMs.regressed, true);
  assert.equal(by.openTimelineMs.change, 60);
  // 2 ms → 4 ms 是 100%，但没超过 10 ms 的容差。
  assert.equal(by.streamLatencyP50Ms.regressed, false);
  // 越高越好的指标：1 → 0.5 是退化。
  assert.equal(by.streamDeliveredRatio.regressed, true);
  assert.equal(by.openTimelineBytes, undefined);
  assert.deepEqual(compare({ openTimelineMs: 1 }, undefined), []);
  // 变好不算退化。
  assert.equal(
    compare({ openTimelineMs: 10 }, { openTimelineMs: 100 })[0].regressed,
    false,
  );
});

test("METRICS: 有方向的指标都有容差与单位字段", () => {
  for (const [name, rule] of Object.entries(METRICS)) {
    assert.ok("unit" in rule, `${name} 缺 unit`);
    if (rule.better !== undefined) {
      assert.ok(["lower", "higher"].includes(rule.better), name);
      assert.equal(typeof rule.slack, "number", `${name} 缺 slack`);
    }
  }
});

test("renderTable 只列有数的指标", () => {
  const table = renderTable({
    openTimelineMs: 12.5,
    openTimelineBytes: 99,
    pageOpenFromNodeMs: null,
  });
  assert.match(table, /\| openTimelineMs \| 12.5 ms \|/);
  assert.match(table, /\| openTimelineBytes \| 99 B \|/);
  assert.doesNotMatch(table, /pageOpenFromNodeMs/);
});

test("cpuTime 与 platformKey", () => {
  assert.equal(cpuTime("0:01.50"), 1.5);
  assert.equal(cpuTime("1:02:03.00"), 3723);
  assert.equal(cpuTime("2-00:00:10.00"), 172_810);
  assert.match(platformKey(), /^[a-z0-9]+-[a-z0-9_]+$/);
});

test("事件流帧：分块标记与回合结束", () => {
  const marker = JSON.stringify({
    type: "timeline.delta",
    timelineId: "s",
    nodeId: "n",
    from: 1,
    to: 2,
    ops: [
      { op: "append", text: chunkText(7, 1234567, 48) },
      { op: "append", text: chunkText(8, 1234999, 48) },
    ],
  });
  assert.deepEqual(chunkFrame(marker), { index: 7, stamp: 1234567 });
  assert.deepEqual(chunkMarkers(marker), [
    { index: 7, stamp: 1234567 },
    { index: 8, stamp: 1234999 },
  ]);
  assert.equal(chunkFrame("{}"), null);
  assert.equal(chunkFrame("not json"), null);
  assert.equal(
    chunkFrame(JSON.stringify({ type: "timeline.delta", ops: [] })),
    null,
  );
  // 旧的 `acp.update` 已下线，不再是分块帧。
  assert.equal(
    chunkFrame(
      JSON.stringify({
        type: "acp.update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunkText(1, 2, 48) },
        },
      }),
    ),
    null,
  );
  assert.equal(isTurnFrame(JSON.stringify({ type: "acp.turn" })), true);
  assert.equal(isTurnFrame(JSON.stringify({ type: "timeline.delta" })), false);
  assert.equal(isTurnFrame("x"), false);
});

test("合成镜像：确定性，回合数、标签、记录形状", () => {
  const a = mirrorRecords({ turns: 12, seed: 3 });
  const b = mirrorRecords({ turns: 12, seed: 3 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, mirrorRecords({ turns: 12, seed: 4 }));
  for (const record of a) {
    assert.ok(record.role === "user" || record.role === "assistant");
    assert.ok(Array.isArray(record.blocks) && record.blocks.length > 0);
    assert.equal(typeof record.at, "string");
  }
  const users = a.filter(
    (r) => r.role === "user" && r.blocks[0].type === "text",
  );
  assert.equal(users.length, 12);
  assert.ok(users[11].blocks[0].text.startsWith(turnLabel(12)));
  // 每隔 3 回合一对工具调用与结果。
  assert.equal(a.filter((r) => r.blocks[0].type === "tool_use").length, 4);
  assert.equal(a.filter((r) => r.blocks[0].type === "tool_result").length, 4);
  const reply = a
    .filter((r) => r.role === "assistant" && r.blocks[0].type === "text")
    .map((r) => r.blocks[0].text);
  assert.ok(reply.length >= 12 * 2, "每个回复被切成多块");
});

test("合成转录：长度够、每行是 Claude 形状的 JSON", () => {
  const lines = claudeTranscriptLines({ bytes: 20_000, seed: 1 });
  const size = lines.reduce(
    (sum, line) => sum + Buffer.byteLength(line) + 1,
    0,
  );
  assert.ok(size >= 20_000);
  for (const line of lines) {
    const value = JSON.parse(line);
    assert.ok(value.type === "user" || value.type === "assistant");
    assert.ok(value.message.content);
  }
});

test("生成器的小件：伪随机稳定、分块无损、标记可逆", () => {
  const first = rng(9);
  const second = rng(9);
  assert.equal(first(), second());
  const text = markdownBody(rng(1), 800);
  assert.ok(text.length >= 800);
  assert.equal(splitChunks(text, 5).join(""), text);
  assert.deepEqual(splitChunks("abc", 1), ["abc"]);
  assert.deepEqual(parseChunkMarker(chunkText(3, 99, 20)), {
    index: 3,
    stamp: 99,
  });
  assert.equal(parseChunkMarker("plain"), null);
});

test("脚本化假 Agent: 按脚本吐带标记的分块，没有脚本回 ok", async () => {
  assert.deepEqual(parseScript("x [bench 4 1000 32] y"), {
    chunks: 4,
    rate: 1000,
    size: 32,
  });
  assert.equal(parseScript("hello"), null);

  const agent = spawn(
    process.execPath,
    [agentPath, "--session-id", "fixed-1"],
    {
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  try {
    const lines = [];
    let buffer = "";
    let wake = () => {};
    agent.stdout.on("data", (chunk) => {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at !== -1) {
        lines.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
      }
      wake();
    });
    const send = (message) =>
      agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const until = async (test) => {
      const deadline = Date.now() + 5000;
      while (!test()) {
        assert.ok(Date.now() < deadline, "等不到应答");
        await new Promise((resume) => {
          wake = resume;
          setTimeout(resume, 50);
        });
      }
    };
    send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
    send({ id: 2, method: "session/new", params: { cwd: "/tmp" } });
    await until(() => lines.some((l) => l.id === 2));
    assert.equal(lines.find((l) => l.id === 2).result.sessionId, "fixed-1");
    send({
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: "fixed-1",
        prompt: [{ type: "text", text: "[bench 5 1000 40]" }],
      },
    });
    await until(() => lines.some((l) => l.id === 3));
    const chunks = lines.filter((l) => l.method === "session/update");
    assert.equal(chunks.length, 5);
    chunks.forEach((line, index) => {
      const marker = parseChunkMarker(line.params.update.content.text);
      assert.equal(marker.index, index);
    });
    assert.equal(lines.find((l) => l.id === 3).result.stopReason, "end_turn");
  } finally {
    agent.kill("SIGKILL");
  }
});

test("基线文件: 每个平台的数字都是已知指标", () => {
  const file = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.equal(typeof file.platforms, "object");
  for (const [platform, entry] of Object.entries(file.platforms)) {
    assert.match(platform, /^[a-z0-9]+-[a-z0-9_]+$/);
    assert.ok(entry.recordedAt);
    for (const name of Object.keys(entry.metrics)) {
      assert.ok(name in METRICS, `${platform} 里有未知指标 ${name}`);
    }
  }
});

test("chunkMarkers: timeline.delta 一帧里的多个标记，其他事件没有", () => {
  const delta = JSON.stringify({
    type: "timeline.delta",
    timelineId: "t",
    nodeId: "n",
    from: 3,
    to: 5,
    ops: [
      { seq: 4, op: "append", itemId: "a", delta: { text: chunkText(1, 100) } },
      { seq: 5, op: "append", itemId: "a", delta: { text: chunkText(2, 120) } },
    ],
  });
  assert.deepEqual(
    chunkMarkers(delta).map((m) => m.index),
    [1, 2],
  );
  assert.deepEqual(
    chunkMarkers(JSON.stringify({ event: JSON.parse(delta) })).map(
      (m) => m.stamp,
    ),
    [100, 120],
  );
  assert.deepEqual(chunkMarkers(JSON.stringify({ type: "acp.turn" })), []);
  assert.deepEqual(chunkMarkers("not json"), []);
});

test("replayUpdates: 镜像记录翻成 session/update 负载", () => {
  const updates = replayUpdates(mirrorRecords({ turns: 3, seed: 1 }));
  const kinds = updates.map((u) => u.sessionUpdate);
  assert.equal(kinds.filter((k) => k === "user_message_chunk").length, 3);
  assert.equal(kinds.filter((k) => k === "tool_call").length, 1);
  assert.equal(kinds.filter((k) => k === "tool_call_update").length, 1);
  assert.ok(kinds.filter((k) => k === "agent_message_chunk").length >= 6);
  const call = updates.find((u) => u.sessionUpdate === "tool_call");
  const result = updates.find((u) => u.sessionUpdate === "tool_call_update");
  assert.equal(call.toolCallId, result.toolCallId);
});

test("脚本化假 Agent: --history 声明 loadSession，session/load 回放 N 回合后答空结果", async () => {
  const agent = spawn(
    process.execPath,
    [agentPath, "--session-id", "hist-1", "--history", "4"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  try {
    const lines = [];
    let buffer = "";
    let wake = () => {};
    agent.stdout.on("data", (chunk) => {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at !== -1) {
        lines.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
      }
      wake();
    });
    const send = (message) =>
      agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const until = async (test) => {
      const deadline = Date.now() + 5000;
      while (!test()) {
        assert.ok(Date.now() < deadline, "等不到应答");
        await new Promise((resume) => {
          wake = resume;
          setTimeout(resume, 50);
        });
      }
    };
    send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await until(() => lines.some((l) => l.id === 1));
    assert.equal(
      lines.find((l) => l.id === 1).result.agentCapabilities.loadSession,
      true,
    );
    send({
      id: 2,
      method: "session/load",
      params: { sessionId: "other", cwd: "/tmp" },
    });
    await until(() => lines.some((l) => l.id === 2));
    assert.ok(lines.find((l) => l.id === 2).error, "不认识的会话报错");
    send({
      id: 3,
      method: "session/load",
      params: { sessionId: "hist-1", cwd: "/tmp" },
    });
    await until(() => lines.some((l) => l.id === 3));
    const replay = lines.filter((l) => l.method === "session/update");
    assert.equal(
      replay.filter(
        (l) => l.params.update.sessionUpdate === "user_message_chunk",
      ).length,
      4,
    );
    assert.deepEqual(lines.find((l) => l.id === 3).result, {});
    // 回放帧都在应答之前。
    assert.ok(
      lines.findIndex((l) => l.id === 3) > lines.indexOf(replay.at(-1)),
    );
  } finally {
    agent.kill("SIGKILL");
  }
});
