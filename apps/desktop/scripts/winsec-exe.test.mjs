import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WINSEC_EXE_RESOURCE,
  WINSEC_EXE_SOURCE,
  buildWinsecExe,
  compileWinsecExe,
} from "./winsec-exe.mjs";

test("the helper lives beside the other Windows programs", () => {
  assert.ok(WINSEC_EXE_SOURCE.endsWith("armadra-winsec/winsec.cs"));
  assert.equal(WINSEC_EXE_RESOURCE, "cli/armadra-winsec.exe");
});

test("the build compiles the helper only on a Windows host", () => {
  const built = [];
  const logs = [];
  const compile = (output) => (built.push(output), output);
  const log = (line) => logs.push(line);
  assert.equal(
    buildWinsecExe(["--if-windows"], { host: "darwin", compile, log }),
    undefined,
  );
  assert.equal(
    buildWinsecExe(["--if-windows"], {
      host: "win32",
      env: { WINDIR: join(tmpdir(), "no-windows-here") },
      compile,
      log,
    }),
    undefined,
  );
  assert.match(logs[0], /WARNING no csc\.exe.*PowerShell/);
  assert.deepEqual(built, []);
  assert.equal(buildWinsecExe(["x.exe"], { compile, log }), "x.exe");
  assert.ok(
    buildWinsecExe([], { compile, log }).endsWith(
      join("out", "cli", "armadra-winsec.exe"),
    ),
  );
});

test(
  "the helper's C# source compiles with the csc every Windows ships",
  { skip: process.platform !== "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "armadra-winsec-exe-"));
    try {
      const output = compileWinsecExe(join(dir, "armadra-winsec.exe"));
      assert.ok(existsSync(output));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
