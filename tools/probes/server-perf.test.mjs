// server-perf.mjs 的纯函数：参数、分位数、`ps` 时间、与基线的比对规则。
// 真正的负载在 B 档跑（tools/ci/e2e.d/server-perf.json）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  METRICS,
  bestOf,
  compare,
  confirmArgs,
  cpuTime,
  parseArgs,
  percentile,
  processStats,
  renderTable,
} from "./server-perf.mjs";

test("parseArgs: 缺省是架构 §11 的规模，数字要正整数", () => {
  const options = parseArgs([]);
  assert.equal(options.sessions, 30);
  assert.equal(options.subscribers, 6);
  assert.equal(options.objects, 2000);
  assert.ok(options.baseline.endsWith("server-perf-baseline.json"));
  const custom = parseArgs([
    "out",
    "--sessions",
    "4",
    "--burst-kib=8",
    "--no-baseline",
    "--write-baseline",
  ]);
  assert.equal(custom.output, "out");
  assert.equal(custom.sessions, 4);
  assert.equal(custom.burstKib, 8);
  assert.equal(custom.baseline, undefined);
  assert.equal(custom.writeBaseline, true);
  assert.throws(() => parseArgs(["--sessions", "0"]), /正整数/);
  assert.throws(() => parseArgs(["--bogus"]), /不认识/);
});

test("percentile: 最近秩", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(percentile([7], 95), 7);
});

test("cpuTime: ps 的累计 CPU 时间", () => {
  assert.equal(cpuTime("0:01.50"), 1.5);
  assert.equal(cpuTime("1:02:03.00"), 3723);
  assert.equal(cpuTime("1-00:00:01"), 86_401);
});

test("processStats: 读得到自己，读不到的进程号给 null", () => {
  const mine = processStats(process.pid);
  if (process.platform === "linux" || process.platform === "darwin") {
    assert.ok(mine.rssMiB > 1);
    assert.ok(mine.cpuSeconds >= 0);
  }
  assert.equal(processStats(undefined), null);
});

test("compare: 差 20% 以上且超过绝对容差才算退化，方向按指标", () => {
  const rows = compare(
    {
      fanoutP95Ms: 30,
      realtimeUpdateP95Ms: 1.5,
      terminalThroughputMiBs: 10,
      rssSteadyMiB: 110,
    },
    {
      fanoutP95Ms: 10,
      realtimeUpdateP95Ms: 0.6,
      terminalThroughputMiBs: 20,
      rssSteadyMiB: 100,
    },
  );
  const by = Object.fromEntries(rows.map((row) => [row.metric, row]));
  // 慢了 200%，差 20 ms 超过 10 ms 容差。
  assert.equal(by.fanoutP95Ms.regressed, true);
  assert.equal(by.fanoutP95Ms.change, 200);
  // 慢了 150%，但只差 0.9 ms：噪声。
  assert.equal(by.realtimeUpdateP95Ms.regressed, false);
  // 吞吐越高越好：掉一半是退化。
  assert.equal(by.terminalThroughputMiBs.regressed, true);
  // 多 10%：不到 20%。
  assert.equal(by.rssSteadyMiB.regressed, false);
  // 基线里没有的指标不比。
  assert.equal(compare({ fanoutP95Ms: 1 }, {}).length, 0);
});

test("提交的基线只含比对用的指标，数字齐全", () => {
  const baselines = JSON.parse(
    readFileSync(
      new URL("./server-perf-baseline.json", import.meta.url),
      "utf8",
    ),
  );
  const platforms = Object.values(baselines.platforms);
  assert.ok(platforms.length > 0);
  for (const platform of platforms) {
    assert.deepEqual(
      Object.keys(platform.metrics).sort(),
      Object.keys(METRICS).sort(),
    );
    for (const value of Object.values(platform.metrics))
      assert.equal(typeof value, "number");
  }
});

test("renderTable: 一张两列的 Markdown 表", () => {
  const table = renderTable({ fanoutP50Ms: 1 });
  assert.match(table, /^\| 指标 \| 数值 \|/);
  assert.match(table, /事件扇出/);
});

test("parseArgs: --confirm 缺省关", () => {
  assert.equal(parseArgs([]).confirm, false);
  assert.equal(parseArgs(["--confirm"]).confirm, true);
});

test("bestOf: 每项按方向取较优，单边是数字时取那一边", () => {
  const merged = bestOf(
    {
      closeStallMaxMs: 700,
      sessionCreateP95Ms: 40,
      terminalThroughputMiBs: 20,
      closeAllMs: 3000,
      rssPeakMiB: null,
    },
    {
      closeStallMaxMs: 210,
      sessionCreateP95Ms: 90,
      terminalThroughputMiBs: 25,
      closeAllMs: 2500,
      rssPeakMiB: 300,
    },
  );
  assert.equal(merged.closeStallMaxMs, 210);
  assert.equal(merged.sessionCreateP95Ms, 40);
  assert.equal(merged.terminalThroughputMiBs, 25);
  // 不在 METRICS 里的项沿用第一次。
  assert.equal(merged.closeAllMs, 3000);
  assert.equal(merged.rssPeakMiB, 300);
});

test("confirmArgs: 同一个场景，不再复测、不写基线、不比基线", () => {
  const options = parseArgs([
    "out",
    "--sessions",
    "4",
    "--burst-kib",
    "8",
    "--confirm",
    "--write-baseline",
  ]);
  const args = confirmArgs(options, "out/confirm");
  assert.equal(args[0], "out/confirm");
  const again = parseArgs(args);
  assert.equal(again.sessions, 4);
  assert.equal(again.burstKib, 8);
  assert.equal(again.subscribers, options.subscribers);
  assert.equal(again.confirm, false);
  assert.equal(again.writeBaseline, false);
  assert.equal(again.baseline, undefined);
});
