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
import {
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
  const watch = startHostWatch({ dir, proc, intervalMs: 3_600_000 });
  assert.equal(watch.sample(), false);
  rmSync(join(proc, "777"), { recursive: true });
  assert.equal(watch.sample(), true);
  await watch.stop();
  assert.match(
    readFileSync(join(dir, "host-watch-gone.log"), "utf8"),
    /模拟器进程不见了/,
  );
  assert.equal(existsSync(join(dir, "host-watch-coredump.log")), true);
});
