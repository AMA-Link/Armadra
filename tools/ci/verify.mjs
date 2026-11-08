/**
 * 本机一条命令跑完与 CI check 作业等价的检查（#870）。
 *
 *   pnpm verify [--full] [--base <ref>] [--no-test]
 *
 * 1. `libs:build`（其余步骤都读 @armadra/shared 的产物）。
 * 2. 静态检查并行：contract、prettier、ESLint、typecheck、仓库规则、workflow、版本、
 *    许可证，加上几组秒级的 node:test。prettier 与 ESLint 带缓存、tsc 是增量的，
 *    第二次起只看改过的文件。
 * 3. 构建：web 与 desktop（不打包），顺序跑。
 * 4. 测试：缺省只跑相对 `--base`（缺省 origin/main）的合并基点受影响的部分——各包
 *    `vitest run --changed <基点>`，未提交与未跟踪的文件也算改动；根配置、锁文件、
 *    `packages/shared/` 变了，或拿不到基点，就全量。`--full` 强制全量。各包逐个跑：
 *    每个 vitest 都按核数开 worker，叠在一起只会互相拖慢。
 *
 * 结尾打印每一步的耗时；任何一步失败，退出码非零，并打印那一步输出的末尾。完整输出
 * 在 node_modules/.cache/verify/<步骤>.log。CI 仍然全量跑，这里只是本机的快路径。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const logDir = join(root, "node_modules/.cache/verify");

/** 这些文件一变，任何包的测试结果都可能变：全量。 */
const GLOBAL_TRIGGERS = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig\.base\.json$/,
  /^\.npmrc$/,
  /^packages\/shared\//,
];

/**
 * 每个包的测试怎么挑。`dir` 下有改动才跑；`full` 命中时整包全量，否则交给
 * `vitest --changed` 按模块图挑。`also` 是会被这个包的测试 import 到的别处源码。
 */
export const PACKAGES = [
  {
    name: "web",
    dir: "apps/web/",
    full: [
      /^apps\/web\/package\.json$/,
      /^apps\/web\/vitest\.config\.ts$/,
      /^apps\/web\/src\/app\/test-setup\.ts$/,
      /^apps\/web\/tsconfig[^/]*\.json$/,
    ],
    runs: [{ id: "web", cmd: ["exec", "vitest", "run"], changed: true }],
  },
  {
    name: "desktop",
    dir: "apps/desktop/",
    full: [
      /^apps\/desktop\/package\.json$/,
      /^apps\/desktop\/vitest[^/]*\.mts$/,
      /^apps\/desktop\/src\/core\/testing\//,
      /^apps\/desktop\/src\/core\/db\/migrations\//,
    ],
    runs: [
      { id: "desktop", cmd: ["exec", "vitest", "run"], changed: true },
      {
        id: "desktop-live",
        cmd: ["exec", "vitest", "run", "--config", "vitest.live.config.mts"],
        changed: true,
      },
      {
        id: "desktop-scripts",
        cmd: ["exec", "node", "--test", "scripts/*.test.mjs"],
        when: /^apps\/desktop\/(scripts\/|electron-builder|build\/|package\.json$)/,
      },
    ],
  },
  {
    // 服务器壳的用例起的是 desktop 里的 core，core 一变就整包跑（只有十来秒）。
    name: "server",
    dir: "apps/server/",
    also: [/^apps\/desktop\/src\/core\//],
    full: [/./],
    runs: [{ id: "server", cmd: ["exec", "vitest", "run"] }],
  },
  {
    name: "mobile",
    dir: "apps/mobile/",
    also: [/^apps\/web\/src\/platform\//],
    full: [/./],
    runs: [{ id: "mobile", cmd: ["exec", "vitest", "run"] }],
  },
  {
    name: "push-relay",
    dir: "apps/push-relay/",
    full: [/./],
    runs: [{ id: "push-relay", cmd: ["exec", "vitest", "run"] }],
  },
];

/**
 * 根据改动的文件列出要跑的测试。`changed` 为 null 表示拿不到基点（当全量处理）。
 * 返回 `{ full, runs: [{ id, pkg, args }] }`；`args` 是在包目录里给 pnpm 的参数。
 */
export function planTests(changed, { full = false, base = null } = {}) {
  const everything =
    full ||
    changed === null ||
    base === null ||
    changed.some((file) => GLOBAL_TRIGGERS.some((re) => re.test(file)));
  const runs = [];
  for (const pkg of PACKAGES) {
    const mine = everything
      ? []
      : changed.filter(
          (file) =>
            file.startsWith(pkg.dir) ||
            (pkg.also ?? []).some((re) => re.test(file)),
        );
    if (!everything && mine.length === 0) continue;
    const whole =
      everything || mine.some((file) => pkg.full.some((re) => re.test(file)));
    for (const run of pkg.runs) {
      if (!everything && run.when && !mine.some((file) => run.when.test(file)))
        continue;
      const args = [...run.cmd];
      if (run.changed && !whole)
        args.push("--changed", base, "--passWithNoTests");
      runs.push({ id: run.id, pkg: `apps/${pkg.name}`, args });
    }
  }
  return { full: everything, runs };
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** 相对 `ref` 的合并基点以来改过的文件（含未提交、未跟踪）。拿不到基点返回 null。 */
function changedFiles(ref) {
  const base = git(["merge-base", ref, "HEAD"]);
  if (!base) return { base: null, files: null };
  const diff = git(["diff", "--name-only", base]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  if (diff === null || untracked === null) return { base, files: null };
  const files = [...diff.split("\n"), ...untracked.split("\n")].filter(Boolean);
  return { base, files: [...new Set(files)] };
}

const isWindows = process.platform === "win32";

/** 跑一步，输出写进日志文件；返回 { id, ok, seconds, log }。 */
function runStep(id, args, cwd = ".") {
  const started = Date.now();
  // Windows 的文件名里不能有冒号。
  const log = join(logDir, `${id.replace(/[^\w.-]/g, "_")}.log`);
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn("pnpm", args, {
      cwd: join(root, cwd),
      shell: isWindows,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      writeFileSync(log, Buffer.concat(chunks));
      const seconds = (Date.now() - started) / 1000;
      process.stdout.write(
        `${ok ? "  ok  " : "  FAIL"} ${id} ${seconds.toFixed(1)}s\n`,
      );
      resolve({ id, ok, seconds, log });
    };
    child.on("error", (error) => {
      chunks.push(Buffer.from(`${error.message}\n`));
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
  });
}

async function sequence(steps) {
  const results = [];
  for (const [id, args, cwd] of steps)
    results.push(await runStep(id, args, cwd));
  return results;
}

function tail(file, lines = 40) {
  return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
}

async function main(argv) {
  const full = argv.includes("--full");
  const noTest = argv.includes("--no-test");
  const baseIndex = argv.indexOf("--base");
  const ref = baseIndex >= 0 ? argv[baseIndex + 1] : "origin/main";
  mkdirSync(logDir, { recursive: true });
  const started = Date.now();
  const results = [];

  console.log("libs");
  results.push(await runStep("libs:build", ["libs:build"]));
  if (!results[0].ok) return report(results, started);

  console.log("静态检查（并行）");
  const statics = [
    "contract:check",
    "format:check",
    "lint",
    "typecheck",
    "repo:check",
    "ci:workflows",
    "release:check",
    "notices:check",
    "repo:test",
    "release:test",
    "plugin:test",
    "controller:real:test",
  ];
  results.push(...(await Promise.all(statics.map((id) => runStep(id, [id])))));

  console.log("构建");
  results.push(
    ...(await sequence([
      ["build:web", ["--filter", "@armadra/web", "build"]],
      ["build:desktop", ["--filter", "@armadra/desktop", "build"]],
    ])),
  );

  if (!noTest) {
    const { base, files } = changedFiles(ref);
    const plan = planTests(files, { full, base });
    console.log(
      plan.full
        ? "测试（全量）"
        : `测试（相对 ${ref} 的合并基点 ${base.slice(0, 9)}，改动 ${files.length} 个文件）`,
    );
    if (plan.runs.length === 0) console.log("  没有受影响的测试");
    results.push(
      ...(await sequence(
        plan.runs.map((run) => [`test:${run.id}`, run.args, run.pkg]),
      )),
    );
  }
  return report(results, started);
}

function report(results, started) {
  const failed = results.filter((result) => !result.ok);
  for (const result of failed) {
    console.log(
      `\n── ${result.id} 失败（完整输出：${result.log}）──\n${tail(result.log)}`,
    );
  }
  const total = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    failed.length === 0
      ? `\n全部通过，用时 ${total}s`
      : `\n${failed.length} 步失败：${failed.map((r) => r.id).join("、")}；用时 ${total}s`,
  );
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
