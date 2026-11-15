import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  archiveCrashedAttempt,
  coredumpSignal,
  countCrashes,
  emulatorProcesses,
  memAvailableMb,
  startHostWatch,
} from "./android-host-watch.mjs";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeProc(emulator) {
  dir = mkdtempSync(join(tmpdir(), "armadra-host-watch-"));
  const proc = join(dir, "proc");
  mkdirSync(proc);
  writeFileSync(
    join(proc, "meminfo"),
    "MemTotal: 16000000 kB\nMemAvailable: 8388608 kB\n",
  );
  writeFileSync(join(proc, "loadavg"), "1.50 1.00 0.80 1/200 999\n");
  mkdirSync(join(proc, "4242"));
  writeFileSync(join(proc, "4242", "cmdline"), "node\0server.js\0");
  writeFileSync(join(proc, "4242", "status"), "VmRSS:\t1024 kB\n");
  if (emulator) {
    mkdirSync(join(proc, "777"));
    writeFileSync(
      join(proc, "777", "cmdline"),
      "/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64\0-avd\0test\0",
    );
    writeFileSync(join(proc, "777", "status"), "VmRSS:\t3145728 kB\n");
  }
  return proc;
}

test("读出可用内存，只认模拟器的虚拟机进程", () => {
  assert.equal(memAvailableMb("MemAvailable:  8388608 kB\n"), 8192);
  assert.equal(memAvailableMb("nothing"), null);
  assert.deepEqual(emulatorProcesses(fakeProc(true)), [
    { pid: 777, rssMb: 3072 },
  ]);
});

test("每次采样写一行，模拟器在时不抓现场", async () => {
  const proc = fakeProc(true);
  const watch = startHostWatch({ dir, proc, intervalMs: 3_600_000 });
  await watch.stop();
  const lines = readFileSync(join(dir, "host-watch.log"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 2); // 没有 cpuinfo：只有两次采样
  assert.match(lines[0], /可用内存 8192MB/);
  assert.match(lines[0], /"pid":777/);
  assert.equal(existsSync(join(dir, "host-watch-gone.log")), false);
});

test("模拟器进程消失后抓一次现场，并说它不见了", async () => {
  const proc = fakeProc(true);
  const watch = startHostWatch({
    dir,
    proc,
    intervalMs: 3_600_000,
    settleSeconds: 0,
    coredumpTimeoutMs: 20_000,
  });
  assert.equal(watch.sample(), false);
  rmSync(join(proc, "777"), { recursive: true });
  assert.equal(watch.sample(), true);
  const stopped = await watch.stop();
  assert.equal(stopped.gone, true);
  assert.match(
    readFileSync(join(dir, "host-watch-gone.log"), "utf8"),
    /模拟器进程不见了/,
  );
  assert.equal(existsSync(join(dir, "host-watch-coredump.log")), true);
});

test("模拟器一直在时 stop 说没消失", async () => {
  const proc = fakeProc(true);
  const watch = startHostWatch({ dir, proc, intervalMs: 3_600_000 });
  assert.deepEqual(await watch.stop(), { gone: false, signal: null });
});

test("从转储摘要读出信号名", () => {
  assert.equal(
    coredumpSignal(
      "           PID: 4242 (qemu-system-x86)\n        Signal: 11 (SEGV)\n    Executable: /sdk/qemu\n",
    ),
    "SEGV",
  );
  assert.equal(coredumpSignal("No coredumps found.\n"), null);
});

function outputDir(result) {
  dir = mkdtempSync(join(tmpdir(), "armadra-host-watch-out-"));
  if (result !== undefined)
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(join(dir, "gradle-connected.log"), "log");
  writeFileSync(join(dir, "host-watch.log"), "watch");
  return dir;
}

const crashed = {
  status: "failed",
  emulatorCrashed: true,
  emulatorSignal: "SEGV",
};
const asserted = {
  status: "failed",
  failures: [{ name: "插桩用例", detail: "gradle exit 1" }],
};

test("模拟器崩溃的一轮挪进 attempt-1/，重跑的产物不盖掉现场", () => {
  const out = outputDir(crashed);
  assert.deepEqual(archiveCrashedAttempt(out), { crashed: true, attempt: 1 });
  assert.equal(existsSync(join(out, "result.json")), false);
  assert.equal(existsSync(join(out, "attempt-1", "result.json")), true);
  assert.equal(
    readFileSync(join(out, "attempt-1", "gradle-connected.log"), "utf8"),
    "log",
  );
  // 重跑也崩了：再记一轮。
  writeFileSync(join(out, "result.json"), JSON.stringify(crashed));
  assert.equal(countCrashes(out), 2);
  assert.deepEqual(archiveCrashedAttempt(out), { crashed: true, attempt: 2 });
  assert.equal(countCrashes(out), 2);
});

test("用例断言失败、没有 result.json 都不算崩溃，不挪文件", () => {
  const out = outputDir(asserted);
  assert.deepEqual(archiveCrashedAttempt(out), {
    crashed: false,
    attempt: null,
  });
  assert.equal(existsSync(join(out, "result.json")), true);
  assert.equal(countCrashes(out), 0);
  rmSync(join(out, "result.json"));
  assert.equal(archiveCrashedAttempt(out).crashed, false);
  writeFileSync(join(out, "result.json"), "{ 写了一半");
  assert.equal(archiveCrashedAttempt(out).crashed, false);
  assert.equal(countCrashes(join(out, "missing")), 0);
});

test("命令行输出 GITHUB_OUTPUT 的 key=value 行", () => {
  const out = outputDir(crashed);
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./android-host-watch.mjs", import.meta.url)),
        ...args,
      ],
      { encoding: "utf8" },
    );
  assert.equal(cli("archive", out).stdout, "crashed=true\nattempt=1\n");
  writeFileSync(join(out, "result.json"), JSON.stringify({ status: "ok" }));
  assert.equal(cli("archive", out).stdout, "crashed=false\n");
  assert.equal(cli("tally", out).stdout, "crashes=1\n");
  assert.equal(cli("nope").status, 2);
});
