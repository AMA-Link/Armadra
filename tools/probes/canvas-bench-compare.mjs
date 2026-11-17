// 画布基准比较：node tools/probes/canvas-bench-compare.mjs <基线.json> <候选.json>
// 两份都可以是 canvas-stress 的 result.json 或 canvas-bench-aggregate 的产物。
// 任一指标没有严格优于基线（方向与 floor / tie / noise 例外见 canvas-bench-lib.mjs）退出码 1。
import { readFileSync } from "node:fs";

import {
  compareMetrics,
  loadBounds,
  loadMetrics,
  renderComparison,
} from "./canvas-bench-lib.mjs";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  console.error("用法：canvas-bench-compare.mjs <基线.json> <候选.json>");
  process.exit(2);
}
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const baseline = read(baselinePath);
const result = compareMetrics(
  loadMetrics(baseline),
  loadMetrics(read(candidatePath)),
  loadBounds(baseline),
);
console.log(renderComparison(result));
const failed = result.rows.filter((row) => !row.pass);
console.log(
  failed.length === 0
    ? `\n通过：${result.rows.length} 项全部优于基线（floor / 持平 / 波动内的例外见表）`
    : `\n未通过：${failed.length} / ${result.rows.length} 项没有严格优于基线`,
);
process.exit(result.pass ? 0 : 1);
