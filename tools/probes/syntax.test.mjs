// 所有探针脚本都要能解析：夜间才跑的探针里一个重复导入之类的语法错误，
// 平时的单测碰不到，到了夜间整条探针加载不了。这里对 tools/probes 下每个
// .mjs / .cjs（含子目录，测试文件除外）跑 `node --check`，只解析不执行。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

function scripts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return scripts(path);
    return /\.(mjs|cjs)$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)
      ? [path]
      : [];
  });
}

test("tools/probes 下每个脚本都能解析（node --check）", () => {
  const files = scripts(here);
  assert.ok(files.length > 20, `只找到 ${files.length} 个脚本`);
  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (error) {
      broken.push(
        `${file}\n${String(error.stderr).split("\n").slice(0, 4).join("\n")}`,
      );
    }
  }
  assert.deepEqual(broken, []);
});
