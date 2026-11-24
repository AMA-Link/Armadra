import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FULL_CHECKS,
  PLATFORM_CHECKS,
  checksForMode,
  parseArgs,
  runCheckCi,
} from "./check-ci.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("parseArgs defaults to full and validates --mode", () => {
  assert.deepEqual(parseArgs([]), { mode: "full" });
  assert.deepEqual(parseArgs(["--mode", "full"]), { mode: "full" });
  assert.deepEqual(parseArgs(["--mode=platform"]), { mode: "platform" });
  assert.throws(() => parseArgs(["--mode"]), /needs a value/);
  assert.throws(() => parseArgs(["--mode", "fast"]), /unknown mode fast/);
  assert.throws(() => parseArgs(["--other"]), /unknown argument --other/);
});

test("every check id in full and platform modes exists in root package.json scripts", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const id of ["libs:build", ...FULL_CHECKS, ...PLATFORM_CHECKS]) {
    assert.ok(
      typeof pkg.scripts[id] === "string" && pkg.scripts[id].length > 0,
      `missing root script: ${id}`,
    );
  }
  // Platform mode is a strict subset of full mode and omits OS-agnostic scans.
  for (const id of PLATFORM_CHECKS) {
    assert.ok(FULL_CHECKS.includes(id), `${id} should be in FULL_CHECKS`);
  }
  for (const skipped of [
    "lint",
    "notices:check",
    "contract:check",
    "board:budget",
    "ci:workflows",
  ]) {
    assert.ok(FULL_CHECKS.includes(skipped), `${skipped} in full`);
    assert.ok(!PLATFORM_CHECKS.includes(skipped), `${skipped} not in platform`);
  }
  assert.deepEqual(checksForMode("full"), FULL_CHECKS);
  assert.deepEqual(checksForMode("platform"), PLATFORM_CHECKS);
});

test("runCheckCi runs libs:build before fanning out checks concurrently", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "armadra-check-ci-"));
  try {
    const events = [];
    let activeParallel = 0;
    let peakParallel = 0;
    const logs = [];

    const { code, results } = await runCheckCi({
      mode: "platform",
      logDir,
      write: (chunk) => logs.push(chunk),
      runStep: async (id) => {
        events.push(`start:${id}`);
        if (id !== "libs:build") {
          activeParallel += 1;
          peakParallel = Math.max(peakParallel, activeParallel);
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (id !== "libs:build") activeParallel -= 1;
        events.push(`end:${id}`);
        return { id, ok: true, seconds: 0.015, output: `${id} ok\n` };
      },
    });

    assert.equal(code, 0);
    assert.equal(events[0], "start:libs:build");
    assert.equal(events[1], "end:libs:build");
    assert.equal(peakParallel, PLATFORM_CHECKS.length);
    assert.equal(results.length, 1 + PLATFORM_CHECKS.length);
    assert.match(logs.join(""), /全部通过/);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("runCheckCi stops immediately if libs:build fails and prints tail output on failure", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "armadra-check-ci-fail-"));
  try {
    const called = [];
    const logs = [];
    const libsFail = await runCheckCi({
      mode: "full",
      logDir,
      write: (chunk) => logs.push(chunk),
      runStep: async (id) => {
        called.push(id);
        return {
          id,
          ok: false,
          seconds: 0.1,
          output: "tsc build error: broken shared type\n",
        };
      },
    });
    assert.equal(libsFail.code, 1);
    assert.deepEqual(called, ["libs:build"]);
    assert.match(logs.join(""), /broken shared type/);

    const checkLogs = [];
    const checkFail = await runCheckCi({
      mode: "platform",
      logDir,
      write: (chunk) => checkLogs.push(chunk),
      runStep: async (id) => ({
        id,
        ok: id !== "typecheck" && id !== "repo:check",
        seconds: 0.05,
        output: id === "typecheck" ? "TS2322: bad type\n" : "problem in repo\n",
      }),
    });
    assert.equal(checkFail.code, 1);
    const rendered = checkLogs.join("");
    assert.match(rendered, /typecheck 失败/);
    assert.match(rendered, /TS2322: bad type/);
    assert.match(rendered, /repo:check 失败/);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
