import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TIMED_OUT, boundedRun } from "./bounded-run.mjs";

const node = process.execPath;
const sandbox = () => mkdtempSync(join(tmpdir(), "armadra-bounded-run-"));

test("正常结束：返回退出码，输出已落盘", async () => {
  const dir = sandbox();
  try {
    const log = join(dir, "ok.log");
    const code = await boundedRun({
      command: node,
      args: [
        "-e",
        "console.log('hello'); console.error('warn'); process.exit(3)",
      ],
      log,
      timeoutMs: 10_000,
      heartbeatMs: 0,
    });
    assert.equal(code, 3);
    const text = readFileSync(log, "utf8");
    assert.match(text, /hello/);
    assert.match(text, /warn/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("超时：先抓现场、再杀，返回 TIMED_OUT，日志留着已有输出", async () => {
  const dir = sandbox();
  const said = [];
  let snapshots = 0;
  try {
    const log = join(dir, "hang.log");
    const started = Date.now();
    const code = await boundedRun({
      command: node,
      args: ["-e", "console.log('before hang'); setInterval(() => {}, 1000)"],
      log,
      timeoutMs: 800,
      heartbeatMs: 0,
      killGraceMs: 200,
      onTimeout: () => {
        snapshots += 1;
      },
      say: (line) => said.push(line),
    });
    assert.equal(code, TIMED_OUT);
    assert.equal(snapshots, 1);
    assert.ok(Date.now() - started < 8_000, "超时后应很快结束");
    assert.match(readFileSync(log, "utf8"), /before hang/);
    assert.ok(
      said.some((line) => /超过 1 秒/.test(line)),
      said.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "超时会连子进程一起杀掉，抓现场抛错也不影响",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const dir = sandbox();
    try {
      const log = join(dir, "tree.log");
      const pidFile = join(dir, "grandchild.pid");
      const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
      const code = await boundedRun({
        command: "sh",
        args: [
          "-c",
          `${node} -e "${grandchild.replaceAll('"', '\\"')}" & wait`,
        ],
        log,
        timeoutMs: 500,
        heartbeatMs: 0,
        killGraceMs: 200,
        onTimeout: () => {
          throw new Error("snapshot broke");
        },
        say: () => {},
      });
      assert.equal(code, TIMED_OUT);
      const pid = Number(readFileSync(pidFile, "utf8"));
      await new Promise((r) => setTimeout(r, 300));
      assert.throws(() => process.kill(pid, 0), /ESRCH/, "孙进程应已被杀");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("心跳：长命令运行期间在控制台打印进度", async () => {
  const dir = sandbox();
  const said = [];
  try {
    const code = await boundedRun({
      command: node,
      args: ["-e", "console.log('step one'); setTimeout(() => {}, 700)"],
      log: join(dir, "beat.log"),
      timeoutMs: 10_000,
      heartbeatMs: 200,
      name: "demo",
      say: (line) => said.push(line),
    });
    assert.equal(code, 0);
    assert.ok(said.length >= 1, "至少一次心跳");
    assert.match(said[0], /demo 已运行 \d+ 秒，日志 \d+ 字节，末行：/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("命令不存在：返回 -1 而不是抛", async () => {
  const dir = sandbox();
  try {
    const code = await boundedRun({
      command: join(dir, "no-such-binary"),
      args: [],
      log: join(dir, "x.log"),
      timeoutMs: 5_000,
      heartbeatMs: 0,
    });
    assert.equal(code, -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
