// node-pty 在 Windows 上 kill() 时 fork 的 conpty_console_list_agent（#670）。
// 跑的是装出来、打过 patches/node-pty@1.1.0.patch 的 lib/ 文件本身；原生的
// getConsoleProcessList 换成桩（经 --require 预加载，fork 出来的 agent 继承
// execArgv 也带着它），所以哪个平台都能跑。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { nodePtyDir } from "./ensure-node-pty.mjs";

const lib = join(nodePtyDir(), "lib");
const work = mkdtempSync(join(tmpdir(), "armadra-console-list-"));
after(() => rmSync(work, { recursive: true, force: true }));

// 桩：ARMADRA_TEST_CONSOLE_LIST 决定原生调用怎么表现。
const stub = join(work, "stub.cjs");
writeFileSync(
  stub,
  `const utils = require(${JSON.stringify(join(lib, "utils.js"))});
const load = utils.loadNativeModule;
utils.loadNativeModule = (name) => {
  if (name !== "conpty_console_list") return load(name);
  const getConsoleProcessList = (pid) => {
    switch (process.env.ARMADRA_TEST_CONSOLE_LIST) {
      case "attach-fails": throw new Error("AttachConsole failed");
      case "crash": process.exit(3);
      case "hang": Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); return [];
      default: return [pid, 7001];
    }
  };
  return { dir: "", module: { getConsoleProcessList } };
};
`,
);

// 驱动：只调 _getConsoleProcessList，记下结果与用时。
const driver = join(work, "driver.cjs");
writeFileSync(
  driver,
  `const { WindowsPtyAgent } = require(${JSON.stringify(join(lib, "windowsPtyAgent.js"))});
const started = Date.now();
WindowsPtyAgent.prototype._getConsoleProcessList
  .call({ _innerPid: Number(process.argv[2]) })
  .then((list) => {
    process.stdout.write(JSON.stringify({ list, ms: Date.now() - started }));
  });
`,
);

function consoleList(behaviour, innerPid = 4242) {
  const result = spawnSync(
    process.execPath,
    ["--require", stub, driver, String(innerPid)],
    {
      encoding: "utf8",
      env: { ...process.env, ARMADRA_TEST_CONSOLE_LIST: behaviour },
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return { ...JSON.parse(result.stdout), stderr: result.stderr };
}

test("agent 拿到列表时原样交回", () => {
  assert.deepEqual(consoleList("list").list, [4242, 7001]);
});

test("AttachConsole 失败：立即回空列表，不留堆栈，不回退到 shell 的 PID", () => {
  const { list, ms, stderr } = consoleList("attach-fails");
  assert.deepEqual(list, []);
  assert.ok(ms < 4_000, `用了 ${ms}ms，等到了 5 秒超时`);
  assert.doesNotMatch(stderr, /AttachConsole/);
});

test("agent 没回消息就退出：立即回空列表", () => {
  const { list, ms } = consoleList("crash");
  assert.deepEqual(list, []);
  assert.ok(ms < 4_000, `用了 ${ms}ms，等到了 5 秒超时`);
});

test("agent 卡住：5 秒后回空列表，不按裸 PID 结束进程", () => {
  const { list, ms } = consoleList("hang");
  assert.deepEqual(list, []);
  assert.ok(ms >= 4_900, `用了 ${ms}ms`);
});

test("shell PID 无效时不起 agent", () => {
  const { list, ms } = consoleList("attach-fails", 0);
  assert.deepEqual(list, []);
  assert.ok(ms < 100, `用了 ${ms}ms`);
});
