// Antigravity（agy）的漂移探针：不登录、不发模型请求、不写用户目录。
//
// agy 走 daily 通道，几乎每天一版。Armadra 依赖它的几处表面，这里把它们记成一份
// 快照（`agy-surface.json`），CLI 升级后先跑这个探针看哪一处变了：
//
//   * 主程序与 `agy acp` 的旗标集（`--help`）：启动行与 ACP 起会话用到的旗标必须
//     都在；
//   * `agy plugin validate` 认的 hook 事件集（六个原生事件）：`UserPromptSubmit` /
//     `Notification` 不在其中；
//   * ACP `initialize` 的答复形状（不需要登录）：能力键、认证方法 id、协议版本。
//
// 用法：node tools/probes/agent-e2e/agy-drift.mjs [--update]
// 没有 agy 时记 skipped 并以 0 退出；有漂移时列出差异并以 1 退出。`--update` 把当前
// 表面写回快照（升级后确认过再用）。所有探测都跑在一个临时 HOME 里。
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_FILE = join(HERE, "agy-surface.json");

/** Armadra 的启动行与 ACP 起会话实际用到的旗标；缺一个就是真漂移。 */
export const USED_FLAGS = {
  main: [
    "--prompt-interactive",
    "--mode",
    "--dangerously-skip-permissions",
    "--model",
    "--conversation",
    "--add-dir",
    "--settings",
  ],
  acp: ["--dangerously-skip-permissions", "--add-dir"],
};

/** `agy --help` / `agy help acp` 里的长旗标名，排序去重。 */
export function parseFlags(help) {
  const flags = new Set();
  for (const line of String(help).split("\n")) {
    const match = /^\s{1,4}(?:-\w,?\s+)?(--[a-z][a-z0-9_-]*)\b/.exec(line);
    if (match) flags.add(match[1]);
  }
  return [...flags].sort();
}

/** 「Available subcommands:」下的子命令名。 */
export function parseSubcommands(help) {
  const names = [];
  let inside = false;
  for (const line of String(help).split("\n")) {
    if (/^Available subcommands:/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    const match = /^\s{2}([a-z][a-z-]*)\s{2,}\S/.exec(line);
    if (match) names.push(match[1]);
    else if (line.trim() === "") break;
  }
  return names.sort();
}

/** `agy plugin validate` 的警告里 `(events: A, B, …)` 那一串。 */
export function parseHookEvents(report) {
  const match = /\(events:\s*([^)]+)\)/.exec(String(report));
  if (!match) return [];
  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
}

/** `initialize` 的答复里 Armadra 读的那几处形状。 */
export function initializeShape(result) {
  const caps = result?.agentCapabilities ?? {};
  return {
    protocolVersion: result?.protocolVersion ?? null,
    loadSession: caps.loadSession === true,
    sessionCapabilities: Object.keys(caps.sessionCapabilities ?? {}).sort(),
    promptCapabilities: Object.keys(caps.promptCapabilities ?? {}).sort(),
    hasMcpCapabilities: caps.mcpCapabilities !== undefined,
    systemPromptAppend: caps._meta?.antigravity?.systemPrompt?.append === true,
    authMethods: (result?.authMethods ?? []).map((method) => method.id).sort(),
  };
}

/** 两份快照的差异（人读的几行）；相同答空数组。 */
export function diffSurface(expected, actual) {
  const out = [];
  const list = (label, before, after) => {
    const lost = before.filter((item) => !after.includes(item));
    const gained = after.filter((item) => !before.includes(item));
    if (lost.length) out.push(`${label}：少了 ${lost.join(", ")}`);
    if (gained.length) out.push(`${label}：多了 ${gained.join(", ")}`);
  };
  list("主程序旗标", expected.mainFlags, actual.mainFlags);
  list("子命令", expected.subcommands, actual.subcommands);
  list("agy acp 旗标", expected.acpFlags, actual.acpFlags);
  list("hook 事件", expected.hookEvents, actual.hookEvents);
  for (const key of Object.keys(expected.initialize)) {
    const before = expected.initialize[key];
    const after = actual.initialize[key];
    if (JSON.stringify(before) !== JSON.stringify(after))
      out.push(
        `initialize.${key}：${JSON.stringify(before)} → ${JSON.stringify(after)}`,
      );
  }
  return out;
}

/** 我们用到的旗标是不是都还在（独立于快照：快照更新也不能放过它）。 */
export function missingUsedFlags(actual) {
  return [
    ...USED_FLAGS.main.filter((flag) => !actual.mainFlags.includes(flag)),
    ...USED_FLAGS.acp
      .filter((flag) => !actual.acpFlags.includes(flag))
      .map((flag) => `acp ${flag}`),
  ];
}

function run(program, args, env) {
  const result = spawnSync(program, args, {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function acpInitialize(program, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(program, ["acp"], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    const finish = (value) => {
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), 15_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        try {
          const message = JSON.parse(line);
          if (message.id === 1) return finish(message.result);
        } catch {
          // 半行，等下一块
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      })}\n`,
    );
  });
}

/** 在临时 HOME 里量出 agy 现在的表面。 */
export async function measure(program) {
  const home = mkdtempSync(join(tmpdir(), "armadra-agy-drift-"));
  try {
    const env = { ...process.env, HOME: home };
    const plugin = join(home, "probe-plugin");
    mkdirSync(plugin);
    writeFileSync(
      join(plugin, "plugin.json"),
      JSON.stringify({ name: "probe", version: "1.0.0" }),
    );
    // 一个不存在的事件名逼它把认得的事件集打印出来。
    writeFileSync(
      join(plugin, "hooks.json"),
      JSON.stringify({ probe: { UserPromptSubmit: [{ command: "./x.sh" }] } }),
    );
    const initialize = await acpInitialize(program, env, home);
    return {
      version: run(program, ["--version"], env).trim(),
      mainFlags: parseFlags(run(program, ["--help"], env)),
      subcommands: parseSubcommands(run(program, ["--help"], env)),
      acpFlags: parseFlags(run(program, ["help", "acp"], env)),
      hookEvents: parseHookEvents(
        run(program, ["plugin", "validate", plugin], env),
      ),
      initialize: initializeShape(initialize),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const which = spawnSync("sh", ["-c", "command -v agy"], { encoding: "utf8" });
  const program = which.stdout.trim();
  if (program === "") {
    console.log("agy：没有安装，跳过（skipped）");
    return 0;
  }
  const actual = await measure(program);
  if (actual.initialize.protocolVersion === null) {
    console.log("agy：ACP initialize 没有答复（15 秒），无法比对");
    return 1;
  }
  const { version, ...surface } = actual;
  if (argv.includes("--update")) {
    writeFileSync(
      SNAPSHOT_FILE,
      `${JSON.stringify({ measuredWith: version, ...surface }, null, 2)}\n`,
    );
    console.log(`agy ${version}：快照已更新 ${SNAPSHOT_FILE}`);
    return 0;
  }
  const expected = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"));
  const missing = missingUsedFlags(surface);
  const differences = diffSurface(expected, surface);
  console.log(`agy ${version}（快照量自 ${expected.measuredWith}）`);
  for (const line of missing) console.log(`  FAIL 用到的旗标没了：${line}`);
  for (const line of differences) console.log(`  漂移  ${line}`);
  if (missing.length === 0 && differences.length === 0)
    console.log("  表面与快照一致");
  return missing.length === 0 && differences.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
