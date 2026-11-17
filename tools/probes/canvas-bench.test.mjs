// canvas-bench-lib / canvas-bench-compare 的测试，含 #956 的防回归：
// 探针依赖的 data-slot 必须还在组件源码里。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SCHEMA,
  SELECTORS,
  SEGMENTS,
  aggregate,
  ENGINES,
  buildInkWhiteboardV2,
  buildInkWhiteboardV3,
  compareMetrics,
  diffPerformance,
  flatten,
  loadMetrics,
  median,
  metricList,
  metricsMap,
  renderComparison,
  summarizeFrames,
  summarizeLatency,
} from "./canvas-bench-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function fakeResult(scale = 1, extra = {}) {
  const segment = (fps) => ({
    fps: fps / scale,
    p50Ms: 5 * scale,
    p95Ms: 8 * scale,
    latencyMs: 30 * scale,
    slowestMs: 20 * scale,
    over33: 0,
    longTasks: 0,
    mainThreadMs: 900 * scale,
    taskMs: 1200 * scale,
    heapMb: 100 * scale,
    domNodes: 5000 * scale,
  });
  const segments = {};
  for (const name of SEGMENTS) segments[name] = segment(200);
  return {
    schema: SCHEMA,
    status: "ok",
    segments,
    rerender: { rendered: 5000 * scale, commits: 11 * scale },
    typing: { commits: 100 * scale },
    inkBoard: { whiteboardBytes: 580000 * scale },
    ...extra,
  };
}

test("#956：探针的便签选择器仍是组件输出的 data-slot", () => {
  const source = readFileSync(
    join(root, "apps/web/src/nodes/StickyNode.tsx"),
    "utf8",
  );
  for (const selector of Object.values(SELECTORS)) {
    for (const [, slot] of selector.matchAll(/data-slot="([^"]+)"/g)) {
      assert.ok(
        source.includes(`data-slot="${slot}"`),
        `StickyNode.tsx 不再输出 data-slot="${slot}"`,
      );
    }
  }
  assert.ok(SELECTORS.stickyBody.includes("sticky-markdown"));
  assert.ok(!Object.values(SELECTORS).some((s) => s.includes("role=")));
});

test("summarizeFrames：分位、最慢帧与超 33.4 ms 帧数", () => {
  assert.equal(summarizeFrames([]), null);
  assert.equal(summarizeFrames([1]), null);
  const times = [0];
  for (let i = 0; i < 99; i += 1) times.push(times[times.length - 1] + 5);
  times.push(times[times.length - 1] + 40);
  const out = summarizeFrames(times);
  assert.equal(out.frames, 100);
  assert.equal(out.p50Ms, 5);
  assert.equal(out.slowestMs, 40);
  assert.equal(out.over33, 1);
  assert.ok(out.fps === 186.9);
});

test("diffPerformance：累计量取差、换算成毫秒，Nodes 取结束值", () => {
  const before = metricsMap([
    { name: "ScriptDuration", value: 1 },
    { name: "LayoutDuration", value: 0.5 },
    { name: "RecalcStyleDuration", value: 0.25 },
    { name: "TaskDuration", value: 3 },
    { name: "Nodes", value: 10 },
  ]);
  const after = metricsMap([
    { name: "ScriptDuration", value: 1.4 },
    { name: "LayoutDuration", value: 0.6 },
    { name: "RecalcStyleDuration", value: 0.3 },
    { name: "TaskDuration", value: 3.9 },
    { name: "Nodes", value: 42 },
  ]);
  const diff = diffPerformance(before, after);
  assert.equal(diff.scriptMs, 400);
  assert.equal(diff.mainThreadMs, 550);
  assert.equal(diff.taskMs, 900);
  assert.equal(diff.domNodes, 42);
});

test("墨迹白板样本：同种子逐字节相同，形状符合 v2", () => {
  const a = JSON.stringify(buildInkWhiteboardV2(10, 5, 1));
  assert.equal(a, JSON.stringify(buildInkWhiteboardV2(10, 5, 1)));
  assert.notEqual(a, JSON.stringify(buildInkWhiteboardV2(10, 5, 2)));
  const doc = buildInkWhiteboardV2(300, 40);
  assert.equal(doc.engine, "armadra-flow");
  assert.equal(doc.version, 2);
  assert.equal(doc.items.length, 300);
  assert.equal(doc.items[0].points.length, 40);
  assert.ok(doc.items[0].id.startsWith("wb:"));
  assert.equal(new Set(doc.items.map((item) => item.id)).size, 300);
  const bytes = Buffer.byteLength(JSON.stringify(doc));
  assert.ok(bytes > 400_000 && bytes < 800_000, `字节数 ${bytes}`);
});

test("墨迹白板样本 v3：与 v2 同一配方，逐条逐点等价", () => {
  const v2 = buildInkWhiteboardV2(300, 40, 952);
  const v3 = buildInkWhiteboardV3(300, 40, 952);
  assert.equal(v3.engine, "armadra-board");
  assert.equal(v3.version, 3);
  assert.deepEqual(v3.references, []);
  assert.equal(v3.items.length, v2.items.length);
  for (const [index, item] of v3.items.entries()) {
    const old = v2.items[index];
    assert.equal(item.kind, "ink");
    for (const key of ["id", "x", "y", "w", "h", "z", "style", "points"]) {
      assert.deepEqual(item[key], old[key], `第 ${index} 条的 ${key}`);
    }
    assert.equal(item.points.length, 40);
  }
});

test("两个引擎的页面选择器都齐全", () => {
  for (const name of ["current", "next"]) {
    for (const key of [
      "node",
      "viewport",
      "selected",
      "dragHandle",
      "idAttr",
      "stage",
    ]) {
      assert.equal(typeof ENGINES[name][key], "string", `${name}.${key}`);
    }
  }
});

test("median 与 aggregate：逐项中位数与波动", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const out = aggregate([fakeResult(1), fakeResult(1.1), fakeResult(1.2)]);
  assert.equal(out.runs, 3);
  assert.equal(out.metrics["pan.mainThreadMs"], 990);
  assert.equal(out.range["pan.mainThreadMs"], 0.182);
  assert.equal(out.spread["pan.mainThreadMs"], 0.091);
  assert.equal(out.spread["pan.over33"], 0);
  assert.equal(loadMetrics({ metrics: out.metrics }), out.metrics);
  assert.deepEqual(loadMetrics(fakeResult(1)), flatten(fakeResult(1)));
});

test("每项指标都有方向与标签，键不重复", () => {
  const list = metricList();
  assert.equal(new Set(list.map((m) => m.key)).size, list.length);
  assert.ok(list.every((m) => typeof m.higher === "boolean" && m.label));
  assert.equal(list.find((m) => m.key === "pan.fps").record, true);
  assert.equal(list.find((m) => m.key === "idle.taskMs").noise, true);
  assert.equal(list.find((m) => m.key === "idle.mainThreadMs").higher, false);
  // 空闲与输入段的帧指标由 60 Hz 心跳与固定打字间隔决定，不进比较
  assert.equal(
    list.some((m) => m.key === "idle.fps" || m.key === "typing.p95Ms"),
    false,
  );
  assert.ok(list.some((m) => m.key === "typing.mainThreadMs"));
});

test("compareMetrics：全部严格更优才通过", () => {
  const base = flatten(fakeResult(1));
  const better = flatten(fakeResult(0.8));
  const result = compareMetrics(base, better);
  // over33 与 longTasks 基线为 0、候选为 0：floor 持平算过
  assert.equal(result.pass, true);
  assert.ok(result.rows.some((row) => row.status === "floor"));
  assert.ok(result.rows.filter((row) => row.status === "better").length > 35);
});

test("compareMetrics：越小越好，持平与变差都不过；fps 只记录不比较", () => {
  const base = flatten(fakeResult(1));
  const tweak = (key, value) => ({ ...flatten(fakeResult(0.8)), [key]: value });
  const status = (candidate, key) =>
    compareMetrics(base, candidate).rows.find((row) => row.key === key);
  assert.equal(status(tweak("pan.fps", 1), "pan.fps"), undefined);
  assert.equal(compareMetrics(base, tweak("pan.fps", 1)).pass, true);
  assert.equal(
    status(tweak("pan.latencyMs", 31), "pan.latencyMs").status,
    "worse",
  );
  assert.equal(
    status(tweak("pan.latencyMs", 30), "pan.latencyMs").status,
    "equal",
  );
  assert.equal(
    status(tweak("pan.mainThreadMs", 900), "pan.mainThreadMs").pass,
    false,
  );
  assert.equal(
    status(tweak("pan.mainThreadMs", 950), "pan.mainThreadMs").status,
    "worse",
  );
  assert.equal(status(tweak("pan.over33", 1), "pan.over33").pass, false);
  // 不是 floor 的指标，基线与候选同为 0 不算更优
  assert.equal(
    compareMetrics({ "pan.latencyMs": 0 }, { "pan.latencyMs": 0 }).rows.find(
      (row) => row.key === "pan.latencyMs",
    ).pass,
    false,
  );
  const missing = { ...flatten(fakeResult(0.8)) };
  delete missing["inkPan.latencyMs"];
  const gone = compareMetrics(base, missing);
  assert.equal(gone.pass, false);
  assert.equal(
    gone.rows.find((row) => row.key === "inkPan.latencyMs").status,
    "missing",
  );
  assert.match(renderComparison(gone), /FAIL 缺失/);
});

test("compareMetrics：tie 持平算过；noise 不超过基线最差一次算过", () => {
  const base = flatten(fakeResult(1));
  const good = flatten(fakeResult(0.8));
  const row = (candidate, key, bounds) =>
    compareMetrics(base, candidate, bounds).rows.find((r) => r.key === key);
  const tied = { ...good, "typing.commits": 100 };
  assert.equal(row(tied, "typing.commits").status, "tie");
  assert.equal(row(tied, "typing.commits").pass, true);
  assert.equal(
    row({ ...good, "rerender.commits": 11 }, "rerender.commits").pass,
    false,
  );
  const heavier = { ...good, "pan.heapMb": 104, "idle.taskMs": 1250 };
  // 没有 bounds（单次 result.json 当基线）：照严格规则
  assert.equal(row(heavier, "pan.heapMb").pass, false);
  const bounds = { "pan.heapMb": [96, 105], "idle.taskMs": [1100, 1300] };
  assert.equal(row(heavier, "pan.heapMb", bounds).status, "noise");
  assert.equal(row(heavier, "idle.taskMs", bounds).status, "noise");
  assert.equal(
    row({ ...good, "pan.heapMb": 106 }, "pan.heapMb", bounds).pass,
    false,
  );
  // 延迟与长任务按 noise 判：持平或不超过基线最差一次算过
  const slower = { ...good, "zoom.latencyMs": 32, "zoom.longTasks": 1 };
  const spread = { "zoom.latencyMs": [28, 33], "zoom.longTasks": [0, 1] };
  assert.equal(row(slower, "zoom.latencyMs", spread).status, "noise");
  assert.equal(row(slower, "zoom.longTasks", spread).status, "noise");
  assert.equal(
    row({ ...good, "zoom.latencyMs": 34 }, "zoom.latencyMs", spread).pass,
    false,
  );
  // 主线程耗时不是 noise：在基线波动内也不过
  assert.equal(
    row({ ...good, "pan.mainThreadMs": 950 }, "pan.mainThreadMs", {
      "pan.mainThreadMs": [800, 1000],
    }).pass,
    false,
  );
  assert.match(
    renderComparison(compareMetrics(base, heavier, bounds)),
    /波动内/,
  );
});

test("summarizeLatency：p50 / p95 / 样本数，没有样本返回空", () => {
  assert.deepEqual(summarizeLatency([]), {});
  const out = summarizeLatency([5, 1, 3, 2, 4]);
  assert.equal(out.latencyMs, 3);
  assert.equal(out.latencyP95Ms, 5);
  assert.equal(out.latencyInputs, 5);
});
