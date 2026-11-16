// node --test tools/board-budget.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGET, measure } from "./board-budget.mjs";

const script = fileURLToPath(new URL("./board-budget.mjs", import.meta.url));

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "board-budget-"));
  for (const [path, lines] of Object.entries(files)) {
    const file = join(root, "packages/board/src", path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "x\n".repeat(lines));
  }
  return root;
}

test("只数非测试的 ts / tsx，按子入口汇总", () => {
  const root = fixture({
    "core/a.ts": 10,
    "core/deep/b.ts": 5,
    "core/a.test.ts": 999,
    "dom/c.ts": 7,
    "react/d.tsx": 3,
    "react/d.test.tsx": 999,
    "core/readme.md": 999,
  });
  try {
    const { counts, over } = measure(root);
    assert.deepEqual(counts, { core: 15, dom: 7, react: 3, total: 25 });
    assert.deepEqual(over, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("包还不存在时全是 0", () => {
  const root = mkdtempSync(join(tmpdir(), "board-budget-"));
  try {
    assert.deepEqual(measure(root).counts, {
      core: 0,
      dom: 0,
      react: 0,
      total: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("超过子入口上限或合计上限都算超预算", () => {
  const root = fixture({ "core/a.ts": 6, "dom/b.ts": 1, "loose.ts": 4 });
  try {
    const { over } = measure(root, { core: 5, dom: 5, react: 5, total: 10 });
    assert.deepEqual(over, [
      { entry: "core", lines: 6, max: 5 },
      { entry: "total", lines: 11, max: 10 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("命令行：预算内退出 0，超出退出 1 并点名", () => {
  const ok = fixture({ "core/a.ts": 1 });
  const bad = fixture({ "react/a.ts": BUDGET.react + 1 });
  try {
    assert.equal(spawnSync("node", [script, "--root", ok]).status, 0);
    const failed = spawnSync("node", [script, "--root", bad], {
      encoding: "utf8",
    });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /react 共 501 行，超出预算 500/);
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test("预算数字与设计 §5.3 一致", () => {
  assert.deepEqual(BUDGET, { core: 4500, dom: 2750, react: 500, total: 7600 });
});
