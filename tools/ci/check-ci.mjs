/**
 * CI 静态检查与快速节点单测并行执行器。
 *
 *   node tools/ci/check-ci.mjs [--mode full|platform]
 *
 * 1. 先串行跑 `pnpm libs:build`（其余检查依赖 `@armadra/shared` 构建产物与
 *    `node-pty` 可执行位）。
 * 2. 按模式并行扇出检查步骤，逐条打印耗时，完整输出落盘到
 *    `node_modules/.cache/check-ci/<步骤>.log`，任一步失败时打印尾部日志并以非零退出。
 *
 * 模式：
 * - `full`（Linux CI 与发布 verify）：跑全量契约、格式、lint、类型、仓库规则、
 *   画板预算、跨平台静态扫描、工作流结构、发布版本、第三方声明与三组秒级 node:test。
 * - `platform`（macOS / Windows CI）：只跑与操作系统换行、路径分隔符、平台分支相关的
 *   检查，跳过 Linux 已跑过的纯 AST / 许可证 / 工作流扫描。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_LOG_DIR = join(ROOT, "node_modules/.cache/check-ci");
const isWindows = process.platform === "win32";

export const MODES = ["full", "platform"];

export const FULL_CHECKS = [
  "contract:check",
  "format:check",
  "lint",
  "typecheck",
  "repo:check",
  "board:budget",
  "portability:check",
  "ci:workflows",
  "release:check",
  "notices:check",
  "repo:test",
  "release:test",
  "controller:real:test",
];

export const PLATFORM_CHECKS = [
  "format:check",
  "typecheck",
  "repo:check",
  "portability:check",
  "repo:test",
  "release:test",
  "controller:real:test",
];

export function parseArgs(argv) {
  let mode = "full";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      const next = argv[index + 1];
      if (next === undefined) throw new Error("--mode needs a value");
      mode = next;
      index += 1;
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!MODES.includes(mode)) {
    throw new Error(
      `unknown mode ${mode}; expected one of ${MODES.join(", ")}`,
    );
  }
  return { mode };
}

export function checksForMode(mode) {
  if (mode === "full") return [...FULL_CHECKS];
  if (mode === "platform") return [...PLATFORM_CHECKS];
  throw new Error(`unknown mode ${mode}; expected one of ${MODES.join(", ")}`);
}

function defaultRunStep(
  id,
  args,
  {
    root = ROOT,
    logDir = DEFAULT_LOG_DIR,
    write = (s) => process.stdout.write(s),
  } = {},
) {
  const started = Date.now();
  const logPath = join(logDir, `${id.replace(/[^\w.-]/g, "_")}.log`);
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(isWindows ? "pnpm.cmd" : "pnpm", args, {
      cwd: root,
      shell: isWindows,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    let settled = false;
    const finish = (ok, exitCode) => {
      if (settled) return;
      settled = true;
      const output = Buffer.concat(chunks).toString("utf8");
      writeFileSync(logPath, output);
      const seconds = (Date.now() - started) / 1000;
      write(`${ok ? "  ok  " : "  FAIL"} ${id} ${seconds.toFixed(1)}s\n`);
      resolve({ id, ok, exitCode, seconds, log: logPath, output });
    };
    child.on("error", (error) => {
      chunks.push(Buffer.from(`${error.stack ?? error.message}\n`));
      finish(false, 1);
    });
    child.on("close", (code) => finish(code === 0, code ?? 1));
  });
}

export function tailText(text, lines = 50) {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

function readTail(result, lines = 50) {
  if (typeof result.output === "string") return tailText(result.output, lines);
  if (result.log) return tailText(readFileSync(result.log, "utf8"), lines);
  return "";
}

export async function runCheckCi({
  mode = "full",
  root = ROOT,
  logDir = DEFAULT_LOG_DIR,
  write = (s) => process.stdout.write(s),
  runStep = (id, args) => defaultRunStep(id, args, { root, logDir, write }),
} = {}) {
  const checks = checksForMode(mode);
  mkdirSync(logDir, { recursive: true });
  const started = Date.now();
  const results = [];

  write(`== check-ci (${mode}): libs:build\n`);
  const libs = await runStep("libs:build", ["libs:build"]);
  results.push(libs);
  if (!libs.ok) {
    return summarize(results, started, write);
  }

  write(`== check-ci (${mode}): ${checks.length} checks in parallel\n`);
  const checkResults = await Promise.all(checks.map((id) => runStep(id, [id])));
  results.push(...checkResults);
  return summarize(results, started, write);
}

function summarize(results, started, write) {
  const failed = results.filter((result) => !result.ok);
  for (const result of failed) {
    const location = result.log ? `（完整输出：${result.log}）` : "";
    write(`\n── ${result.id} 失败${location}──\n${readTail(result)}\n`);
  }
  const totalSeconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failed.length === 0) {
    write(`\ncheck-ci 全部通过（${results.length} 步，${totalSeconds}s）\n`);
    return { code: 0, results };
  }
  write(
    `\ncheck-ci 失败：${failed.length} 步未通过（${failed.map((r) => r.id).join("、")}，${totalSeconds}s）\n`,
  );
  return { code: 1, results };
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }
  const { code } = await runCheckCi(options);
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exitCode = 1;
    },
  );
}
