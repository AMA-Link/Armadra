// canvas-bench-compare.mjs 的退出码：全部严格更优 0、任一项未更优 1、参数不对 2。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SCHEMA, SEGMENTS } from "./canvas-bench-lib.mjs";

const compareScript = fileURLToPath(
  new URL("./canvas-bench-compare.mjs", import.meta.url),
);

function fakeResult(scale) {
  const segments = {};
  for (const name of SEGMENTS) {
    segments[name] = {
      fps: 200 / scale,
      p50Ms: 5 * scale,
      p95Ms: 8 * scale,
      slowestMs: 20 * scale,
      over33: 0,
      longTasks: 0,
      mainThreadMs: 900 * scale,
      taskMs: 1200 * scale,
      heapMb: 100 * scale,
      domNodes: 5000 * scale,
    };
  }
  return {
    schema: SCHEMA,
    status: "ok",
    segments,
    rerender: { rendered: 5000 * scale, commits: 11 * scale },
    typing: { commits: 100 * scale },
    inkBoard: { whiteboardBytes: 580000 * scale },
  };
}

test("canvas-bench-compare：退出码 0 / 1 / 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-bench-test-"));
  try {
    const write = (name, value) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    const base = write("base.json", fakeResult(1));
    const good = write("good.json", fakeResult(0.8));
    const same = write("same.json", fakeResult(1));
    const run = (...args) =>
      spawnSync(process.execPath, [compareScript, ...args], {
        encoding: "utf8",
      });
    const ok = run(base, good);
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /指标.*方向.*基线.*候选/);
    assert.equal(run(base, same).status, 1);
    assert.equal(run(good, base).status, 1);
    assert.equal(run(base).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
