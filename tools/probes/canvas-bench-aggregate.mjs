// 多次 canvas-stress 运行取逐项中位数，写成基线文件：
//   node tools/probes/canvas-bench-aggregate.mjs <输出.json> <result1.json> <result2.json> ...
// 同时记下机器、内存、Chrome 版本、提交号与每项波动。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

import { SCHEMA, aggregate } from "./canvas-bench-lib.mjs";

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length === 0) {
  console.error(
    "用法：canvas-bench-aggregate.mjs <输出.json> <result.json>...",
  );
  process.exit(2);
}
const results = inputs.map((path) => JSON.parse(readFileSync(path, "utf8")));
for (const [index, result] of results.entries()) {
  if (result.status !== "ok")
    throw new Error(`${inputs[index]} 不是成功的运行`);
}
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const { metrics, spread, runs } = aggregate(results);
const file = {
  schema: SCHEMA,
  commit: run("git", ["rev-parse", "HEAD"]),
  machine:
    run("sysctl", ["-n", "machdep.cpu.brand_string"]) || os.cpus()[0]?.model,
  memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  os: `${os.type()} ${os.release()}`,
  chrome: results[0].chrome,
  terminals: results[0].terminals,
  runs,
  metrics,
  spread,
};
writeFileSync(output, `${JSON.stringify(file, null, 2)}\n`);
console.log(
  `已写 ${output}：${runs} 次取中位数，${Object.keys(metrics).length} 项指标`,
);
