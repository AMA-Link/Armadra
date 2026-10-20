// ACP 会话加载与流式显示的基线探针（ACP 渐进式展示 B0，总 Issue #422）。
//
// 真 core（`apps/desktop/out/core/main.js`），隔离的数据目录与 HOME；Agent 是脚本化的
// 假 Agent（`fixtures/acp-bench-agent.mjs`），会话内容是合成的（`fixtures/acp-session-gen.mjs`）。
// 不用任何真实账号，不碰真实数据，只结束自己起的进程。
//
// 四项测量（后面各批改动前后各跑一遍对比）：
//
//   open        打开含 N 回合（缺省 300）的会话：`GET /api/acp/sessions/{id}/log?after=0`
//               的耗时、应答字节、条目数，以及页面侧 `JSON.parse` 的耗时；
//   stream      脚本化 Agent 以每秒 R 块（缺省 50）吐 C 块（缺省 200）：每块从 Agent 吐出
//               到工作空间事件流的订阅者收到的延迟（core 一侧）、丢块数，每块多写了几行
//               outbox 与镜像，core 进程的 CPU；
//   reconnect   断开事件流再连：连上的耗时，加上页面重连后做的那件事（整份重读 `…/log`）；
//   transcript  Claude 形状的转录文件：`GET /api/agent-status/{node}/transcript` 读 256 KiB
//               与 5 MiB（上限）两档的耗时；另给一份不经 core 的参照（整读 + 逐行解析 20 MiB，
//               尾读 256 KiB），对应设计文档里的 55 MB / 153 ms 那一行。
//
// `--page` 另外起 Vite 与无头 Chrome，在真页面里量（需要 Chrome，`CHROME_PATH` 可指定）：
//
//   pageOpen    从节点出现到最后一个回合画出来；这段时间主线程的长任务（> 50 ms）；
//   pageChunk   每个流式分块从 Agent 吐出到它的文字出现在 DOM 里的延迟，以及流式期间的长任务。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   pnpm --filter @armadra/desktop build
//   node tools/probes/acp-view-bench.mjs [输出目录] [--turns 300] [--chunks 200] [--rate 50]
//     [--chunk-chars 48] [--runs 5] [--transcript-mib 20] [--page]
//     [--baseline 文件 | --no-baseline] [--write-baseline]
//
// 产物：<输出目录>/result.json（含 `metrics` 平铺的数字）与 table.md，缺省 target/acp-view-bench/。
// 与基线比对：缺省读 `tools/probes/acp-view-bench-baseline.json` 里 `<平台>-<架构>` 那一份，
// 任何一项比基线差 20% 以上（并且超过该项的绝对容差）即失败；没有这台平台的基线时只报告。
// 进 PR CI 的只有 `acp-view-bench.test.mjs`（参数、统计、比对、输出形状）；真正的负载夜间跑。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  claudeTranscriptLines,
  mirrorRecords,
  parseChunkMarker,
  turnLabel,
  writeJsonl,
} from "./fixtures/acp-session-gen.mjs";
import { LOOPBACK_OWNER_ENV } from "./probe-home.mjs";
import {
  child,
  harness,
  killTmux,
  sleep,
  startChrome,
  startVite,
} from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { WebSocket } = createRequire(join(root, "apps/desktop/package.json"))(
  "ws",
);
const BENCH_AGENT = "custom:acp-bench";
const BENCH_SESSION = "bench-session";
const agentScript = join(root, "tools/probes/fixtures/acp-bench-agent.mjs");

/* --------------------------------- 参数 ---------------------------------- */

const NUMERIC = {
  turns: "turns",
  chunks: "chunks",
  rate: "rate",
  "chunk-chars": "chunkChars",
  runs: "runs",
  "transcript-mib": "transcriptMib",
};

export function parseArgs(argv) {
  const options = {
    output: undefined,
    turns: 300,
    chunks: 200,
    rate: 50,
    chunkChars: 48,
    runs: 5,
    transcriptMib: 20,
    page: false,
    baseline: join(root, "tools/probes/acp-view-bench-baseline.json"),
    writeBaseline: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      if (options.output !== undefined) throw new Error(`多余的参数：${arg}`);
      options.output = arg;
      continue;
    }
    const [flag, inline] = arg.slice(2).split("=", 2);
    if (flag === "page") options.page = true;
    else if (flag === "no-baseline") options.baseline = undefined;
    else if (flag === "write-baseline") options.writeBaseline = true;
    else if (flag === "baseline" || flag in NUMERIC) {
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error(`--${flag} 缺值`);
      if (flag === "baseline") options.baseline = value;
      else {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0)
          throw new Error(`--${flag} 要正数：${value}`);
        if (flag !== "transcript-mib" && !Number.isInteger(number))
          throw new Error(`--${flag} 要正整数：${value}`);
        options[NUMERIC[flag]] = number;
      }
    } else throw new Error(`不认识的参数 --${flag}`);
  }
  if (options.writeBaseline && options.baseline === undefined)
    throw new Error("--write-baseline 与 --no-baseline 不能一起用");
  return options;
}

/* --------------------------------- 统计 ---------------------------------- */

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export const round1 = (value) =>
  value === null || value === undefined ? null : Math.round(value * 10) / 10;

/** `{ n, p50, p95, max }`；空数组全是 `null`（n 为 0）。 */
export function summarize(values) {
  return {
    n: values.length,
    p50: round1(percentile(values, 50)),
    p95: round1(percentile(values, 95)),
    max: round1(values.length === 0 ? null : Math.max(...values)),
  };
}

/** 长任务：落在 `[from, to]`（页面 `performance.now()`）里的条数、总时长、最长一条。 */
export function longTaskSummary(tasks, from, to) {
  const inside = tasks.filter((task) => task.start >= from && task.start <= to);
  return {
    count: inside.length,
    totalMs: round1(inside.reduce((sum, task) => sum + task.duration, 0)),
    maxMs: round1(
      inside.reduce((max, task) => Math.max(max, task.duration), 0),
    ),
  };
}

/**
 * 比对用的指标：`better` 是方向，`slack` 是绝对容差（差值不到它的不算退化）。
 * 没有 `better` 的是只记录、不判的数字（规模、字节、比例）。
 */
export const METRICS = {
  openLogMs: { better: "lower", slack: 30, unit: "ms" },
  openLogParseMs: { better: "lower", slack: 15, unit: "ms" },
  openLogBytes: { unit: "B" },
  openLogEntries: { unit: "条" },
  streamLatencyP50Ms: { better: "lower", slack: 10, unit: "ms" },
  streamLatencyP95Ms: { better: "lower", slack: 25, unit: "ms" },
  streamLatencyMaxMs: { better: "lower", slack: 100, unit: "ms" },
  streamDeliveredRatio: { better: "higher", slack: 0.01, unit: "" },
  streamOutboxRowsPerChunk: { better: "lower", slack: 0.2, unit: "行/块" },
  streamMirrorLinesPerChunk: { unit: "行/块" },
  streamCoreCpuPercent: { better: "lower", slack: 10, unit: "%" },
  reconnectOpenMs: { better: "lower", slack: 20, unit: "ms" },
  reconnectSyncMs: { better: "lower", slack: 40, unit: "ms" },
  transcriptRoute256KiBMs: { better: "lower", slack: 20, unit: "ms" },
  transcriptRoute5MiBMs: { better: "lower", slack: 60, unit: "ms" },
  transcriptFullParseMs: { better: "lower", slack: 60, unit: "ms" },
  transcriptTail256KiBMs: { better: "lower", slack: 5, unit: "ms" },
  pageOpenFromNodeMs: { better: "lower", slack: 150, unit: "ms" },
  pageOpenLongTaskMs: { better: "lower", slack: 150, unit: "ms" },
  pageOpenLongTaskMaxMs: { better: "lower", slack: 100, unit: "ms" },
  pageChunkP50Ms: { better: "lower", slack: 25, unit: "ms" },
  pageChunkP95Ms: { better: "lower", slack: 60, unit: "ms" },
  pageChunkRenderedRatio: { better: "higher", slack: 0.02, unit: "" },
  pageStreamLongTaskCount: { better: "lower", slack: 5, unit: "条" },
  pageStreamLongTaskMaxMs: { better: "lower", slack: 100, unit: "ms" },
};

export const REGRESSION = 0.2;

/** 这次的数字对一份基线：每个有方向的指标一行。 */
export function compare(current, baseline) {
  const rows = [];
  for (const [metric, rule] of Object.entries(METRICS)) {
    if (rule.better === undefined) continue;
    const was = baseline?.[metric];
    const now = current[metric];
    if (typeof was !== "number" || typeof now !== "number") continue;
    const worse = rule.better === "lower" ? now - was : was - now;
    const change = was === 0 ? 0 : worse / Math.abs(was);
    rows.push({
      metric,
      baseline: was,
      current: now,
      change: Math.round(change * 1000) / 10,
      regressed: change > REGRESSION && worse > rule.slack,
    });
  }
  return rows;
}

export function platformKey() {
  return `${process.platform}-${process.arch}`;
}

/** 平铺的指标对象 → Markdown 表。 */
export function renderTable(metrics) {
  const rows = Object.entries(METRICS)
    .filter(([name]) => metrics[name] !== undefined && metrics[name] !== null)
    .map(
      ([name, rule]) =>
        `| ${name} | ${metrics[name]}${rule.unit ? ` ${rule.unit}` : ""} |`,
    );
  return `| 指标 | 数值 |\n| --- | --- |\n${rows.join("\n")}\n`;
}

/** `ps -o time=` 的 `[[dd-]hh:]mm:ss.ss` → 秒。 */
export function cpuTime(text) {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  return (
    rest
      .split(":")
      .map(Number)
      .reduce((total, part) => total * 60 + part, 0) +
    Number(days) * 86_400
  );
}

/** 一个进程此刻的 RSS（MiB）与累计 CPU 秒；读不到时 `null`。 */
export function processStats(pid) {
  if (!pid) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[11]) + Number(fields[12]);
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
      return { rssMiB: rssKb / 1024, cpuSeconds: ticks / 100 };
    }
    const out = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    const [rss, time] = out.split(/\s+/);
    return { rssMiB: Number(rss) / 1024, cpuSeconds: cpuTime(time) };
  } catch {
    return null;
  }
}

/* ------------------------------ 事件流帧 ------------------------------ */

/** 事件流的一帧文本 → `acp.update` 里的分块标记（序号、吐出时间）；不是分块答 `null`。 */
export function chunkFrame(text) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  const event = frame?.event ?? frame;
  if (event?.type !== "acp.update") return null;
  if (event.update?.sessionUpdate !== "agent_message_chunk") return null;
  const content = event.update.content;
  return parseChunkMarker(content?.type === "text" ? (content.text ?? "") : "");
}

/** 一帧是不是回合结束（`acp.turn`）。 */
export function isTurnFrame(text) {
  try {
    const frame = JSON.parse(text);
    return (frame?.event ?? frame)?.type === "acp.turn";
  } catch {
    return false;
  }
}

/* --------------------------------- 主线 ---------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = resolve(options.output ?? join(root, "target/acp-view-bench"));
  mkdirSync(output, { recursive: true });
  const h = harness(output);
  const { report, step } = h;
  report.failures = [];
  report.platform = platformKey();
  report.node = process.version;
  report.options = { ...options, output: undefined };
  const metrics = {};
  report.metrics = metrics;
  report.details = {};

  await h.run(async () => {
    for (const file of [
      "apps/desktop/out/core/main.js",
      "tools/probes/fixtures/acp-bench-agent.mjs",
    ]) {
      if (!existsSync(join(root, file)))
        throw new Error(`没有构建：${file}（见文件头的构建命令）`);
    }

    /* -------------------------------- core -------------------------------- */

    const data = h.temp("armadra-acp-bench-");
    const home = h.temp("armadra-acp-bench-home-");
    const projectRoot = h.temp("armadra-acp-bench-project-");
    const files = h.temp("armadra-acp-bench-files-");
    writeFileSync(join(projectRoot, "README.md"), "# bench\n");
    h.cleanups.push(() => killTmux(data));
    const environment = {
      ...process.env,
      HOME: home,
      ARMADRA_DATA_DIR: data,
      ARMADRA_LOG: process.env.ARMADRA_LOG ?? "warn",
      ARMADRA_NO_GLOBAL_WRITES: "1",
      ARMADRA_SECRET_BACKEND: "file",
      ...LOOPBACK_OWNER_ENV,
    };
    const runtime = child(
      h,
      process.execPath,
      [
        join(root, "apps/desktop/out/core/main.js"),
        "--listen",
        "tcp:127.0.0.1:0",
        "--data-dir",
        data,
      ],
      { cwd: root, env: environment },
    );
    let origin = "";
    for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
      if (runtime.process.exitCode !== null)
        throw new Error(`core 退出：${runtime.tail()}`);
      try {
        origin = JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
          .runtime.http;
      } catch {
        await sleep(100);
      }
    }
    if (!origin) throw new Error("core 没有写出 endpoints.json");
    step("core 已启动", origin);

    const api = async (path, init = {}) => {
      const answer = await fetch(new URL(path, origin), {
        method: init.method ?? "GET",
        headers: { "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const text = await answer.text();
      if (!answer.ok)
        throw new Error(
          `${init.method ?? "GET"} ${path} → ${answer.status} ${text.slice(0, 300)}`,
        );
      return text ? JSON.parse(text) : null;
    };
    const query = (sql, ...args) => {
      const db = new DatabaseSync(join(data, "canvas.db"), { readOnly: true });
      try {
        return db.prepare(sql).all(...args);
      } finally {
        db.close();
      }
    };

    await api("/api/settings", {
      method: "PATCH",
      body: {
        agents: {
          custom: [
            {
              id: BENCH_AGENT,
              label: "ACP bench",
              launchCmd: process.execPath,
              args: [agentScript, "--session-id", BENCH_SESSION],
              baseAgent: "opencode",
            },
          ],
        },
        terminal: { ecoMode: false },
      },
    });

    const stamp = () => new Date().toISOString();
    const terminalNode = (boardId, id, title, agent, x = 40) => ({
      id,
      boardId,
      type: "terminal",
      title,
      color: "#0a84ff",
      position: { x, y: 80 },
      size: { width: 560, height: 520 },
      labels: [],
      note: "",
      data: { kind: "terminal", cwd: projectRoot, agent },
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    /** 新工作空间 + 放上给定的节点，答 `{ workspaceId, boardId }`。 */
    const board = async (name, nodes) => {
      const workspace = await api("/api/workspaces", {
        method: "POST",
        body: { name, rootPath: projectRoot },
      });
      const first = (await api(`/api/workspaces/${workspace.id}/boards`))[0];
      const path = `/api/workspaces/${workspace.id}/boards/${first.id}/document`;
      const current = await api(path);
      await api(path, {
        method: "PUT",
        body: {
          expectedUpdatedAt: current.board.updatedAt,
          nodes: nodes(first.id),
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          whiteboard: "",
        },
      });
      return { workspaceId: workspace.id, boardId: first.id };
    };
    const mirrorFile = (nodeId) =>
      join(data, "acp", nodeId, `${BENCH_SESSION}.acp.jsonl`);
    const seedMirror = (nodeId) =>
      writeJsonl(
        mirrorFile(nodeId),
        mirrorRecords({ turns: options.turns, seed: 1 }),
      );
    const lineCount = (file) => {
      const text = readFileSync(file, "utf8");
      let lines = 0;
      for (
        let at = text.indexOf("\n");
        at !== -1;
        at = text.indexOf("\n", at + 1)
      )
        lines += 1;
      return lines;
    };

    /* --------------------------- 1. 打开 N 回合 --------------------------- */

    const nodeA = randomUUID();
    const nodeT = randomUUID();
    const { workspaceId } = await board("bench", (boardId) => [
      terminalNode(boardId, nodeA, "Bench", { id: BENCH_AGENT, driver: "acp" }),
      // 转录那一项要一个以 Claude 为 Agent 的节点（只有状态行，不起会话）。
      terminalNode(
        boardId,
        nodeT,
        "Transcript",
        { id: "claude", driver: "terminal" },
        640,
      ),
    ]);
    seedMirror(nodeA);
    report.details.mirrorBytes = statSync(mirrorFile(nodeA)).size;
    step(
      "合成镜像",
      `${options.turns} 回合，${(report.details.mirrorBytes / 1024).toFixed(0)} KiB`,
    );

    const session = await api("/api/acp/sessions", {
      method: "POST",
      body: {
        workspaceId,
        nodeId: nodeA,
        cwd: projectRoot,
        agentId: BENCH_AGENT,
      },
    });
    const rowId = session.id;
    const sessionPath = `/api/acp/sessions/${rowId}`;

    // 事件流与页面同一条路：控制面 `/api/ws` 上订阅 `workspaces.events`（peer 帧，
    // 契约 §35）。每个事件在订阅里是一帧，`frames[].text` 是它的 JSON。
    const events = () => {
      const socket = new WebSocket(
        `${origin.replace(/^http/u, "ws")}/api/ws`,
        ["armadra-rpc.v1"],
        { origin },
      );
      const frames = [];
      let wake = () => {};
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (message.t !== 3 || message.p?.e !== "message") return;
        frames.push({
          at: Date.now(),
          text: JSON.stringify(message.p.d?.json),
        });
        wake();
      });
      const opened = new Promise((done, failed) => {
        socket.once("open", () => {
          socket.send(
            JSON.stringify({
              i: "1",
              p: { u: "/workspaces/events", b: { json: { workspaceId } } },
            }),
          );
          done(Date.now());
        });
        socket.once("error", (error) => failed(error));
        socket.once("unexpected-response", (_request, response) =>
          failed(new Error(`升级被拒：HTTP ${response.statusCode}`)),
        );
      });
      return {
        socket,
        frames,
        opened,
        async until(test, what, timeout = 30_000) {
          const deadline = Date.now() + timeout;
          while (!test(frames)) {
            const left = deadline - Date.now();
            if (left <= 0) throw new Error(`等不到：${what}`);
            await new Promise((resume) => {
              wake = resume;
              setTimeout(resume, Math.min(left, 100));
            });
          }
        },
      };
    };

    let live = events();
    await live.opened;
    await api(`${sessionPath}/prompt`, {
      method: "POST",
      body: { text: "warm" },
    });
    await live.until(
      (frames) => frames.some((f) => isTurnFrame(f.text)),
      "预热回合",
    );
    step("会话已接上", rowId);

    const openRuns = [];
    for (let run = 0; run < options.runs + 1; run += 1) {
      const started = performance.now();
      const answer = await fetch(new URL(`${sessionPath}/log?after=0`, origin));
      const text = await answer.text();
      const fetched = performance.now();
      const body = JSON.parse(text);
      const parsed = performance.now();
      // 第 0 次是预热（模块热身、文件缓存），不计。
      if (run > 0)
        openRuns.push({
          ms: fetched - started,
          parseMs: parsed - fetched,
          bytes: Buffer.byteLength(text),
          entries: body.entries.length,
        });
    }
    metrics.openLogMs = round1(
      percentile(
        openRuns.map((r) => r.ms),
        50,
      ),
    );
    metrics.openLogParseMs = round1(
      percentile(
        openRuns.map((r) => r.parseMs),
        50,
      ),
    );
    metrics.openLogBytes = openRuns[0].bytes;
    metrics.openLogEntries = openRuns[0].entries;
    report.details.open = {
      ms: summarize(openRuns.map((r) => r.ms)),
      parseMs: summarize(openRuns.map((r) => r.parseMs)),
    };
    step(
      "打开会话（读 log）",
      `${metrics.openLogMs} ms，解析 ${metrics.openLogParseMs} ms，${metrics.openLogBytes} B，${metrics.openLogEntries} 条`,
    );

    /* ------------------------------ 2. 流式 ------------------------------ */

    live.frames.length = 0;
    const count = (sql) => query(sql, workspaceId)[0].count;
    const outboxBefore = count(
      "SELECT count(*) AS count FROM events WHERE workspace_id = ?",
    );
    const mirrorBefore = lineCount(mirrorFile(nodeA));
    const cpuBefore = processStats(runtime.process.pid);
    const streamStarted = performance.now();
    await api(`${sessionPath}/prompt`, {
      method: "POST",
      body: {
        text: `[bench ${options.chunks} ${options.rate} ${options.chunkChars}]`,
      },
    });
    await live.until(
      (frames) => frames.some((f) => isTurnFrame(f.text)),
      "流式回合结束",
      60_000 + (options.chunks / options.rate) * 1000,
    );
    const streamSeconds = (performance.now() - streamStarted) / 1000;
    const cpuAfter = processStats(runtime.process.pid);
    await sleep(300);
    const seen = new Map();
    for (const frame of live.frames) {
      const marker = chunkFrame(frame.text);
      if (marker !== null && !seen.has(marker.index))
        seen.set(marker.index, frame.at - marker.stamp);
    }
    const latencies = [...seen.values()];
    const stream = summarize(latencies);
    metrics.streamLatencyP50Ms = stream.p50;
    metrics.streamLatencyP95Ms = stream.p95;
    metrics.streamLatencyMaxMs = stream.max;
    metrics.streamDeliveredRatio =
      round1((seen.size / options.chunks) * 1000) / 1000;
    metrics.streamOutboxRowsPerChunk =
      Math.round(
        ((count("SELECT count(*) AS count FROM events WHERE workspace_id = ?") -
          outboxBefore) /
          options.chunks) *
          100,
      ) / 100;
    metrics.streamMirrorLinesPerChunk =
      Math.round(
        ((lineCount(mirrorFile(nodeA)) - mirrorBefore) / options.chunks) * 100,
      ) / 100;
    metrics.streamCoreCpuPercent =
      cpuBefore && cpuAfter
        ? round1(
            ((cpuAfter.cpuSeconds - cpuBefore.cpuSeconds) / streamSeconds) *
              100,
          )
        : null;
    report.details.stream = {
      seconds: round1(streamSeconds),
      latencyMs: stream,
    };
    step(
      "流式分块（core → 订阅者）",
      `p50 ${stream.p50} / p95 ${stream.p95} / max ${stream.max} ms，收到 ${seen.size}/${options.chunks}，outbox ${metrics.streamOutboxRowsPerChunk} 行/块，core CPU ${metrics.streamCoreCpuPercent} %`,
    );

    /* ----------------------------- 3. 重连同步 ----------------------------- */

    live.socket.close();
    await sleep(200);
    const reconnectRuns = [];
    for (let run = 0; run < options.runs; run += 1) {
      const started = performance.now();
      const again = events();
      const openedAt = await again.opened;
      void openedAt;
      const connected = performance.now();
      // 页面重连后做的事：整份重读 log 再重建（`SessionView.tsx` 的对账）。
      const answer = await fetch(new URL(`${sessionPath}/log?after=0`, origin));
      JSON.parse(await answer.text());
      const synced = performance.now();
      again.socket.close();
      reconnectRuns.push({ open: connected - started, sync: synced - started });
      await sleep(50);
    }
    metrics.reconnectOpenMs = round1(
      percentile(
        reconnectRuns.map((r) => r.open),
        50,
      ),
    );
    metrics.reconnectSyncMs = round1(
      percentile(
        reconnectRuns.map((r) => r.sync),
        50,
      ),
    );
    report.details.reconnect = {
      openMs: summarize(reconnectRuns.map((r) => r.open)),
      syncMs: summarize(reconnectRuns.map((r) => r.sync)),
    };
    step(
      "重连同步",
      `连上 ${metrics.reconnectOpenMs} ms，连上并重读 log ${metrics.reconnectSyncMs} ms`,
    );

    /* ----------------------------- 4. 转录解析 ----------------------------- */

    const transcript = join(files, "claude-session.jsonl");
    writeJsonl(
      transcript,
      claudeTranscriptLines({
        bytes: Math.floor(options.transcriptMib * 1024 * 1024),
        seed: 2,
      }),
    );
    const transcriptBytes = statSync(transcript).size;
    {
      const db = new DatabaseSync(join(data, "canvas.db"));
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        db.prepare(
          "INSERT OR REPLACE INTO agent_status (node_id, workspace_id, agent_id, state, session_id, transcript_path, updated_at) VALUES (?, ?, 'claude', 'done', 'bench-claude', ?, ?)",
        ).run(nodeT, workspaceId, transcript, stamp());
      } finally {
        db.close();
      }
    }
    const route = async (maxBytes) => {
      const runs = [];
      let rendered = 0;
      for (let run = 0; run < options.runs + 1; run += 1) {
        const started = performance.now();
        const body = await api(
          `/api/agent-status/${nodeT}/transcript?maxBytes=${maxBytes}`,
        );
        const ms = performance.now() - started;
        rendered = body.text.length;
        if (run > 0) runs.push(ms);
      }
      return {
        ms: round1(percentile(runs, 50)),
        runs: summarize(runs),
        rendered,
      };
    };
    const small = await route(256 * 1024);
    const large = await route(5 * 1024 * 1024);
    metrics.transcriptRoute256KiBMs = small.ms;
    metrics.transcriptRoute5MiBMs = large.ms;
    // 参照：不经 core，整读 + 逐行 JSON.parse，对尾读 256 KiB。
    const fullRuns = [];
    const tailRuns = [];
    for (let run = 0; run < options.runs + 1; run += 1) {
      let started = performance.now();
      let parsed = 0;
      for (const line of readFileSync(transcript, "utf8").split("\n")) {
        if (line !== "") {
          JSON.parse(line);
          parsed += 1;
        }
      }
      if (run > 0) fullRuns.push(performance.now() - started);
      started = performance.now();
      const text = readFileSync(transcript, "utf8").slice(-256 * 1024);
      for (const line of text.slice(text.indexOf("\n") + 1).split("\n")) {
        if (line !== "") JSON.parse(line);
      }
      if (run > 0) tailRuns.push(performance.now() - started);
      report.details.transcriptLines = parsed;
    }
    metrics.transcriptFullParseMs = round1(percentile(fullRuns, 50));
    metrics.transcriptTail256KiBMs = round1(percentile(tailRuns, 50));
    report.details.transcript = {
      bytes: transcriptBytes,
      route256KiB: small,
      route5MiB: large,
      fullParse: summarize(fullRuns),
      tail256KiB: summarize(tailRuns),
    };
    step(
      "转录解析",
      `经 core 256 KiB ${small.ms} ms / 5 MiB ${large.ms} ms；参照整读 ${(transcriptBytes / 1048576).toFixed(0)} MiB ${metrics.transcriptFullParseMs} ms、尾读 ${metrics.transcriptTail256KiBMs} ms`,
    );

    /* ------------------------------- 5. 页面 ------------------------------- */

    if (options.page) await pageTier();

    async function pageTier() {
      const pageNode = randomUUID();
      const target = await board("bench-page", (boardId) => [
        terminalNode(boardId, pageNode, "Bench page", {
          id: BENCH_AGENT,
          driver: "acp",
        }),
      ]);
      seedMirror(pageNode);
      const web = await startVite(h, root, environment);
      const chrome = await startChrome(h);
      const page = await chrome.open({
        name: "page",
        width: 1600,
        height: 1000,
      });
      const lastTurn = turnLabel(options.turns);
      // 导航前装好：长任务观察、节点出现与最后一个回合画出来的时刻、分块出现在 DOM 里的时刻。
      await page.call("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
          const bench = (window.__bench = { long: [], chunks: {} });
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              bench.long.push({ start: entry.startTime, duration: entry.duration });
          }).observe({ type: "longtask", buffered: true });
          const marker = /⟦(\\d+):(\\d+)⟧/g;
          const scan = () => {
            const node = document.querySelector('.react-flow__node[data-id="${pageNode}"]');
            if (node && bench.node === undefined) bench.node = performance.now();
            const list = node?.querySelector('[data-slot="acp-messages"]');
            if (!list) return;
            const replies = list.querySelectorAll('[data-role="assistant"]');
            const last = replies[replies.length - 1];
            if (!last) return;
            const text = last.textContent ?? "";
            if (bench.open === undefined && text.startsWith(${JSON.stringify(`${lastTurn} reply`)}))
              bench.open = performance.now();
            const tail = text.slice(-600);
            marker.lastIndex = 0;
            for (let m = marker.exec(tail); m; m = marker.exec(tail)) {
              if (bench.chunks[m[1]] === undefined)
                bench.chunks[m[1]] = performance.timeOrigin + performance.now() - Number(m[2]);
            }
          };
          new MutationObserver(scan).observe(document, {
            subtree: true,
            childList: true,
            characterData: true,
          });
          const frame = () => {
            scan();
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        })();`,
      });
      await page.navigate(
        `${web}/?workspace=${target.workspaceId}&board=${target.boardId}`,
      );
      await page.waitFor(`return window.__bench.open !== undefined;`, {
        timeout: 120_000,
        what: `最后一个回合（${lastTurn}）画出来`,
      });
      await sleep(1000);
      const opened = await page.evaluate(`return window.__bench;`);
      const openTasks = longTaskSummary(opened.long, opened.node, opened.open);
      metrics.pageOpenFromNodeMs = round1(opened.open - opened.node);
      metrics.pageOpenLongTaskMs = openTasks.totalMs;
      metrics.pageOpenLongTaskMaxMs = openTasks.maxMs;
      report.details.pageOpen = {
        nodeAtMs: round1(opened.node),
        lastTurnAtMs: round1(opened.open),
        longTasks: openTasks,
      };
      step(
        "页面打开会话",
        `节点出现到最后回合 ${metrics.pageOpenFromNodeMs} ms，长任务 ${openTasks.count} 条共 ${openTasks.totalMs} ms（最长 ${openTasks.maxMs} ms）`,
      );

      const row = query(
        "SELECT id FROM terminal_sessions WHERE owner_node_id = ? AND status = 'running' ORDER BY generation DESC LIMIT 1",
        pageNode,
      ).at(0);
      if (row === undefined) throw new Error("页面没有起出会话行");
      const before = await page.evaluate(`return performance.now();`);
      await api(`/api/acp/sessions/${row.id}/prompt`, {
        method: "POST",
        body: {
          text: `[bench ${options.chunks} ${options.rate} ${options.chunkChars}]`,
        },
      });
      await page
        .waitFor(
          `return Object.keys(window.__bench.chunks).length >= ${options.chunks};`,
          {
            timeout: 60_000 + (options.chunks / options.rate) * 1000,
            what: "全部分块出现在 DOM 里",
          },
        )
        .catch(() => {});
      await sleep(500);
      const done = await page.evaluate(`return window.__bench;`);
      const delays = Object.values(done.chunks);
      const chunk = summarize(delays);
      const streamTasks = longTaskSummary(done.long, before, Number.MAX_VALUE);
      metrics.pageChunkP50Ms = chunk.p50;
      metrics.pageChunkP95Ms = chunk.p95;
      metrics.pageChunkRenderedRatio =
        Math.round((delays.length / options.chunks) * 1000) / 1000;
      metrics.pageStreamLongTaskCount = streamTasks.count;
      metrics.pageStreamLongTaskMaxMs = streamTasks.maxMs;
      report.details.pageStream = {
        chunkMs: chunk,
        rendered: delays.length,
        longTasks: streamTasks,
      };
      step(
        "页面流式分块（吐出 → 出现在 DOM）",
        `p50 ${chunk.p50} / p95 ${chunk.p95} / max ${chunk.max} ms，看到 ${delays.length}/${options.chunks}，长任务 ${streamTasks.count} 条（最长 ${streamTasks.maxMs} ms）`,
      );
      if (page.errors?.length > 0) report.details.pageErrors = page.errors;
    }

    /* ------------------------------- 收尾 ------------------------------- */

    const key = platformKey();
    report.table = renderTable(metrics);
    writeFileSync(join(output, "table.md"), report.table);
    if (options.baseline !== undefined) {
      const file = existsSync(options.baseline)
        ? JSON.parse(readFileSync(options.baseline, "utf8"))
        : { platforms: {} };
      if (options.writeBaseline) {
        file.platforms ??= {};
        file.platforms[key] = {
          recordedAt: new Date().toISOString().slice(0, 10),
          machine: `${process.platform}-${process.arch}，Node ${process.version}`,
          options: {
            turns: options.turns,
            chunks: options.chunks,
            rate: options.rate,
            chunkChars: options.chunkChars,
            runs: options.runs,
            transcriptMib: options.transcriptMib,
            page: options.page,
          },
          metrics: Object.fromEntries(
            Object.entries(metrics).filter(([, value]) => value !== null),
          ),
        };
        writeFileSync(options.baseline, `${JSON.stringify(file, null, 2)}\n`);
        step("基线已写入", `${options.baseline}（${key}）`);
      } else {
        const rows = compare(metrics, file.platforms?.[key]?.metrics);
        report.comparison = rows;
        for (const row of rows.filter((r) => r.regressed))
          report.failures.push({
            name: `${row.metric} 退化`,
            detail: `${row.baseline} → ${row.current}（${row.change}%）`,
          });
        step(
          "与基线比对",
          rows.length === 0
            ? `没有 ${key} 的基线，只报告`
            : `${rows.filter((r) => r.regressed).length} 项退化 / ${rows.length} 项`,
        );
      }
    }
    console.log(`\n${report.table}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
