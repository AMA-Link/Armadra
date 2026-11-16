// node tools/board-budget.mjs [--root <目录>]
//
// 画板引擎的行数预算（docs/design/board-engine.md §5.3）：统计 packages/board/src
// 各子入口的非测试行数，超过上限就失败，防止引擎膨胀。超预算要先在 PR 里说明，
// 再改这里的数字。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 子入口目录 → 行数上限；`total` 是整包上限。 */
export const BUDGET = {
  core: 4500,
  // B5 起 2740 → 2750：createBoard 加 `image` / `invalidate` 与「置顶对象先于 DOM 命中」。
  // B6 起 2750 → 2760：框选边拖边发 select（与旧画布一致，松手一次提交整批选区会卡出长任务）。
  // 再到 2850：Canvas 层离屏位图缓存，只平移时贴图不重画（300 条墨迹板平移的主线程耗时）。
  dom: 2850,
  react: 500,
  total: 7600,
};

const SOURCE = /\.(ts|tsx)$/;
const TEST = /\.test\.(ts|tsx)$/;

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE.test(name) && !TEST.test(name)) files.push(path);
  }
  return files;
}

function countLines(file) {
  const text = readFileSync(file, "utf8");
  if (text === "") return 0;
  return text.endsWith("\n")
    ? text.split("\n").length - 1
    : text.split("\n").length;
}

/** 返回 `{ counts, over }`：各子入口与合计的行数，以及超出预算的条目。 */
export function measure(root, budget = BUDGET) {
  const src = join(root, "packages/board/src");
  const counts = {};
  let total = 0;
  for (const entry of Object.keys(budget)) {
    if (entry === "total") continue;
    counts[entry] = sourceFiles(join(src, entry)).reduce(
      (sum, file) => sum + countLines(file),
      0,
    );
    total += counts[entry];
  }
  // 子入口之外直接放在 src/ 下的文件也算进合计，不能靠它绕开预算。
  const loose = existsSync(src)
    ? readdirSync(src)
        .filter((name) => SOURCE.test(name) && !TEST.test(name))
        .reduce((sum, name) => sum + countLines(join(src, name)), 0)
    : 0;
  counts.total = total + loose;
  const over = Object.keys(budget)
    .filter((entry) => counts[entry] > budget[entry])
    .map((entry) => ({ entry, lines: counts[entry], max: budget[entry] }));
  return { counts, over };
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0
      ? argv[rootIndex + 1]
      : fileURLToPath(new URL("../", import.meta.url));
  const { counts, over } = measure(root);
  for (const entry of Object.keys(BUDGET)) {
    console.log(
      `${entry.padEnd(6)} ${String(counts[entry]).padStart(5)} / ${BUDGET[entry]}`,
    );
  }
  if (over.length > 0) {
    for (const { entry, lines, max } of over) {
      console.error(
        `board-budget：${entry} 共 ${lines} 行，超出预算 ${max}（设计 §5.3）。`,
      );
    }
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
