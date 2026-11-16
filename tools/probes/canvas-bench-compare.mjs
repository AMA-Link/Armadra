// 画布基准比较：node tools/probes/canvas-bench-compare.mjs <基线.json> <候选.json>
// 两份都可以是 canvas-stress 的 result.json 或 canvas-bench-aggregate 的产物。
// 任一指标没有严格优于基线（方向见 canvas-bench-lib.mjs）退出码 1。
import { readFileSync } from "node:fs";

import {
  compareMetrics,
  loadMetrics,
  renderComparison,
} from "./canvas-bench-lib.mjs";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  console.error("用法：canvas-bench-compare.mjs <基线.json> <候选.json>");
  process.exit(2);
}
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const result = compareMetrics(
  loadMetrics(read(baselinePath)),
  loadMetrics(read(candidatePath)),
);
console.log(renderComparison(result));
const failed = result.rows.filter((row) => !row.pass);
console.log(
  failed.length === 0
    ? `\n通过：${result.rows.length} 项全部严格优于基线（floor 项持平已在下限）`
    : `\n未通过：${failed.length} / ${result.rows.length} 项没有严格优于基线`,
);
process.exit(result.pass ? 0 : 1);
