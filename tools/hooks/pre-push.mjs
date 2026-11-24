/**
 * 推送前本地把关（#953）。`.githooks/pre-push` 调用，`pnpm install` 时由
 * `tools/hooks/install.mjs` 把 `core.hooksPath` 指到 `.githooks`。
 *
 * 只查这次推送带上的改动，规则与 CI（.github/workflows/ci.yml）对齐：
 *
 * - 改动按推送的 ref 范围算：已有的远端分支是「远端旧值..本地新值」，新分支是相对
 *   远端缺省分支的合并基点。删除分支、只推 tag 时什么都不做。
 * - 只改文档（与 CI 的 `changes` 作业同一个判定）：改动文件的 prettier 与 `repo:check`。
 * - 有代码改动：`libs:build` 后并行跑 `pnpm check` 的各项（prettier 与 ESLint 只看改动文件，
 *   配置变了就全量）加 `portability:check`；再按路径挑 node:test 组、web / desktop 构建，
 *   最后用 `tools/ci/verify.mjs` 的 `planTests` 跑受影响包的单测（`vitest --changed <基点>`）。
 * - A 档探针（30 分钟级）不在这里跑：按 `probe-map.mjs` 列出相关的几条与命令；
 *   `ARMADRA_PREPUSH_E2E=1` 时构建后真跑它们，数据目录用临时的 ARMADRA_DATA_DIR。
 *
 * 失败就拦下推送（退出码 1）。临时跳过：`git push --no-verify`，或
 * `ARMADRA_SKIP_PREPUSH=1`（全部）/ `ARMADRA_SKIP_PREPUSH=lint,test:desktop`（指定步骤）。
 * 每步完整输出在 node_modules/.cache/pre-push/<步骤>.log。
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { planTests } from "../ci/verify.mjs";
import { mapProbes } from "./probe-map.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOG_DIR = join(ROOT, "node_modules/.cache/pre-push");
const ZERO = /^0+$/;
const isWindows = process.platform === "win32";

/** 命令行一次传多少个文件；再多就改跑全量，免得撞上 Windows 的命令行长度上限。 */
const MAX_FILE_ARGS = 200;

/** CI 的 `changes` 作业：只有这些改动时只跑 docs 作业。 */
export function isDocsOnly(files) {
  return (
    files.length > 0 &&
    files.every(
      (file) =>
        file !== "THIRD_PARTY_NOTICES.md" &&
        !file.startsWith("docs/contracts/") &&
        (file.endsWith(".md") ||
          file.startsWith("docs/") ||
          file.startsWith(".github/ISSUE_TEMPLATE/")),
    )
  );
}

/** 这些一变，prettier / ESLint 的结论可能对任何文件都变：全量。 */
const FORMAT_GLOBAL = [
  /^\.prettierrc/,
  /^\.prettierignore$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
];
const LINT_GLOBAL = [
  /^eslint\.config\.js$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig/,
  /(^|\/)tsconfig[^/]*\.json$/,
];
const LINTABLE = /\.(c|m)?(j|t)sx?$/;
/** 未跟踪时会被类型检查、lint 或测试读到的源码。 */
const SOURCE = /\.(tsx?|mjs|js)$/;
const TEST_SOURCE = /\.(test|spec)\.[cm]?[jt]sx?$|\/test-setup\.ts$/;

/** node:test 组：改了 `when` 里的路径才跑（根 package.json 与锁文件变了全跑）。 */
export const NODE_SUITES = [
  {
    id: "repo:test",
    when: /^(tools\/(repo-check|lint-config|portability-check)|tools\/contract\/|tools\/hooks\/|repo\.rules\.json$|eslint\.config\.js$)/,
  },
  {
    id: "release:test",
    // stage-desktop.test.mjs 读 apps/desktop/electron-builder.yml。
    when: /^(tools\/(release|ci|dev-stack|probes)\/|tools\/notices|\.github\/workflows\/|apps\/desktop\/electron-builder)/,
  },
  { id: "plugin:test", when: /^tools\/plugins\// },
  {
    id: "controller:real:test",
    when: /^tools\/probes\/controller-real/,
  },
];

const BUILDS = [
  {
    id: "build:web",
    args: ["--filter", "@armadra/web", "build"],
    when: /^(apps\/web\/|packages\/shared\/)/,
  },
  {
    id: "build:desktop",
    args: ["--filter", "@armadra/desktop", "build"],
    when: /^(apps\/desktop\/|packages\/shared\/)/,
  },
];

const ROOT_TRIGGERS = [/^package\.json$/, /^pnpm-lock\.yaml$/];

/**
 * 按改动的文件排出要跑的步骤。`exists(file)` 判断文件还在不在（删掉的文件不交给
 * prettier / ESLint）。返回 `{ docsOnly, libs, statics, builds, tests }`，每步是
 * `{ id, args, cwd? }`（给 pnpm 的参数）。
 */
export function planChecks(files, { base, exists = () => true } = {}) {
  const present = files.filter(exists);
  const formatFiles = present;
  const format =
    files.some((file) => FORMAT_GLOBAL.some((re) => re.test(file))) ||
    formatFiles.length > MAX_FILE_ARGS
      ? { id: "format", args: ["format:check"] }
      : formatFiles.length > 0
        ? {
            id: "format",
            args: [
              "exec",
              "prettier",
              "--check",
              "--ignore-unknown",
              "--cache",
              "--cache-location",
              "node_modules/.cache/prettier/.prettier-cache",
              ...formatFiles,
            ],
          }
        : null;
  const repoCheck = { id: "repo:check", args: ["repo:check"] };
  if (isDocsOnly(files))
    return {
      docsOnly: true,
      libs: null,
      statics: [format, repoCheck].filter(Boolean),
      builds: [],
      tests: [],
    };

  const lintFiles = present.filter((file) => LINTABLE.test(file));
  const lint =
    files.some((file) => LINT_GLOBAL.some((re) => re.test(file))) ||
    lintFiles.length > MAX_FILE_ARGS
      ? { id: "lint", args: ["lint"] }
      : lintFiles.length > 0
        ? {
            id: "lint",
            args: [
              "exec",
              "eslint",
              "--cache",
              "--cache-location",
              "node_modules/.cache/eslint/",
              "--no-warn-ignored",
              ...lintFiles,
            ],
          }
        : null;
  const statics = [
    format,
    lint,
    ...[
      "typecheck",
      "repo:check",
      "contract:check",
      "ci:workflows",
      "release:check",
      "notices:check",
      "portability:check",
    ].map((id) => ({ id, args: [id] })),
  ].filter(Boolean);
  const everything = files.some((file) =>
    ROOT_TRIGGERS.some((re) => re.test(file)),
  );
  for (const suite of NODE_SUITES)
    if (everything || files.some((file) => suite.when.test(file)))
      statics.push({ id: suite.id, args: [suite.id] });

  const selectedBuilds = BUILDS.filter(
    (build) =>
      everything ||
      files.some((file) => build.when.test(file) && !TEST_SOURCE.test(file)),
  );
  const buildsWeb = selectedBuilds.some((build) => build.id === "build:web");
  const builds = selectedBuilds.map(({ id, args }) => ({
    id,
    args,
    ...(id === "build:desktop" && buildsWeb
      ? { env: { ARMADRA_REUSE_WEB_DIST: "1" } }
      : {}),
  }));

  const tests = planTests(files, { base }).runs.map((run) => ({
    id: `test:${run.id}`,
    args: run.args,
    cwd: run.pkg,
  }));
  return {
    docsOnly: false,
    libs: { id: "libs:build", args: ["libs:build"] },
    statics,
    builds,
    tests,
  };
}

/** pre-push 的标准输入：每行「本地 ref 本地 sha 远端 ref 远端 sha」。 */
export function parsePushLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
    }));
}

/** 要查的 ref：删除（本地 sha 全 0）与非分支（tag 等）都不查。 */
export function refsToCheck(updates) {
  return updates.filter(
    (update) =>
      !ZERO.test(update.localSha) && update.remoteRef.startsWith("refs/heads/"),
  );
}

/** 解析 `ARMADRA_SKIP_PREPUSH`：`{ all }` 或要跳过的步骤名集合。 */
export function parseSkip(value) {
  const text = (value ?? "").trim();
  if (text === "") return { all: false, steps: new Set() };
  if (text === "1" || text === "true" || text === "all")
    return { all: true, steps: new Set() };
  return {
    all: false,
    steps: new Set(
      text
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  };
}

/**
 * 去掉 GIT_* 的环境。git 给钩子设的 GIT_DIR、GIT_INDEX_FILE 等会被子进程继承：
 * 测试在临时目录里起的 git 会改到本仓库（曾把 core.bare 写成 true）。
 */
export function cleanEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("GIT_")),
  );
}

function gitRaw(args) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: cleanEnv(),
  });
  return result.status === 0 ? result.stdout : null;
}

function git(args) {
  return gitRaw(args)?.trim() ?? null;
}

/** `git status --porcelain -z` 的条目：`{ code, path }`；改名只取新路径。 */
export function parseStatus(text) {
  const entries = [];
  const parts = text.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.length < 4) continue;
    const code = part.slice(0, 2);
    entries.push({ code, path: part.slice(3) });
    // 改名、复制的下一段是原路径。
    if (code[0] === "R" || code[0] === "C") index += 1;
  }
  return entries;
}

/**
 * 工作区里推送范围之外的东西：未跟踪的源码（`code`，默认拦）、其它未跟踪文件、
 * 范围外与范围内的未提交修改。检查跑在工作区上，这些都会让结果与 CI 不同。
 */
export function workingTreeReport(entries, changed, sourcePattern = SOURCE) {
  const report = {
    untrackedCode: [],
    untrackedOther: [],
    outside: [],
    inside: [],
  };
  for (const { code, path } of entries) {
    if (code === "??") {
      (sourcePattern.test(path)
        ? report.untrackedCode
        : report.untrackedOther
      ).push(path);
    } else if (code !== "!!") {
      (changed.has(path) ? report.inside : report.outside).push(path);
    }
  }
  return report;
}

function hasCommit(sha) {
  return git(["cat-file", "-e", `${sha}^{commit}`]) !== null;
}

/** 远端的缺省分支：refs/remotes/<远端>/HEAD 指向的那个，没有就 <远端>/main。 */
function defaultBranch(remote) {
  const head = git(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  if (head) return head.replace(/^refs\/remotes\//, "");
  for (const candidate of [`${remote}/main`, "origin/main"])
    if (git(["rev-parse", "--verify", "--quiet", candidate])) return candidate;
  return null;
}

/**
 * 一个 ref 的基点：远端旧值与本地新值的合并基点、缺省分支与本地新值的合并基点，
 * 取更靠近本地新值的那个。新分支只有后者；变基后强推时前者落在很早的地方，后者才对。
 */
function baseOf(update, remote) {
  const branch = defaultBranch(remote);
  const candidates = [
    !ZERO.test(update.remoteSha) && hasCommit(update.remoteSha)
      ? git(["merge-base", update.remoteSha, update.localSha])
      : null,
    branch ? git(["merge-base", branch, update.localSha]) : null,
  ].filter(Boolean);
  if (candidates.length < 2) return candidates[0] ?? null;
  const [fromRemote, fromBranch] = candidates;
  // fromRemote 是 fromBranch 的祖先：fromBranch 更近。
  return isAncestor(fromRemote, fromBranch) ? fromBranch : fromRemote;
}

function isAncestor(older, newer) {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", older, newer], {
      cwd: ROOT,
      env: cleanEnv(),
    }).status === 0
  );
}

function runStep(step, env) {
  const started = Date.now();
  const log = join(LOG_DIR, `${step.id.replace(/[^\w.-]/g, "_")}.log`);
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn("pnpm", step.args, {
      cwd: join(ROOT, step.cwd ?? "."),
      shell: isWindows,
      env: { ...cleanEnv(), FORCE_COLOR: "0", ...step.env, ...env },
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      writeFileSync(log, Buffer.concat(chunks));
      const seconds = (Date.now() - started) / 1000;
      console.log(
        `  ${ok ? "ok  " : "FAIL"} ${step.id} ${seconds.toFixed(1)}s`,
      );
      resolve({ id: step.id, ok, log });
    };
    child.on("error", (error) => {
      chunks.push(Buffer.from(`${error.message}\n`));
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
  });
}

async function sequence(steps, env) {
  const results = [];
  for (const step of steps) {
    const result = await runStep(step, env);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

function tail(file, lines = 30) {
  return readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .join("\n");
}

function loadEntries() {
  const directory = join(ROOT, "tools/ci/e2e.d");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json") && !file.startsWith("."))
    .map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")));
}

/** 相关探针：打印出来；`ARMADRA_PREPUSH_E2E=1` 时构建后真跑。 */
async function probes(files) {
  const { probes: related, webChanged } = mapProbes({
    root: ROOT,
    entries: loadEntries(),
    changed: files,
  });
  if (related.length === 0) {
    if (webChanged)
      console.log(
        "探针：改了界面源码，没对上任何探针的选择器或文案；界面行为变了时自己挑（node tools/ci/e2e.mjs --tier a --list）",
      );
    return [];
  }
  const ids = related.map((probe) => probe.id);
  console.log("可能相关的 A 档探针：");
  for (const probe of related)
    console.log(`  ${probe.id}：${probe.reasons.slice(0, 3).join("；")}`);
  const command = `node tools/ci/e2e.mjs --tier a --only ${ids.join(",")}`;
  if (process.env.ARMADRA_PREPUSH_E2E !== "1") {
    console.log(
      `  要跑：先构建（见 tools/ci/e2e.mjs 开头），再 ${command}；或 ARMADRA_PREPUSH_E2E=1 git push`,
    );
    return [];
  }
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-prepush-e2e-"));
  try {
    const env = { ARMADRA_DATA_DIR: dataDir };
    const results = await sequence(
      [
        { id: "e2e:build:web", args: ["--filter", "@armadra/web", "build"] },
        {
          id: "e2e:build:desktop",
          args: ["--filter", "@armadra/desktop", "build"],
          env: { ARMADRA_REUSE_WEB_DIST: "1" },
        },
        {
          id: "e2e:build:server",
          args: ["--filter", "@armadra/server", "build"],
        },
        {
          id: "e2e:build:push-relay",
          args: ["--filter", "@armadra/push-relay", "build"],
        },
        {
          id: "e2e",
          args: [
            "exec",
            "node",
            "tools/ci/e2e.mjs",
            "--tier",
            "a",
            "--only",
            ids.join(","),
            "--out",
            "target/e2e/pre-push",
          ],
        },
      ],
      env,
    );
    return results;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main(argv, input) {
  // 子进程一律不带 GIT_*（见 cleanEnv）。
  for (const name of Object.keys(process.env))
    if (name.startsWith("GIT_")) delete process.env[name];
  const skip = parseSkip(process.env.ARMADRA_SKIP_PREPUSH);
  if (skip.all) return 0;
  const remote = argv[0] && !argv[0].includes("/") ? argv[0] : "origin";
  const refs = refsToCheck(parsePushLines(input));
  if (refs.length === 0) return 0;

  const head = git(["rev-parse", "HEAD"]);
  const elsewhere = refs.find((ref) => ref.localSha !== head);
  if (elsewhere) {
    // 检查只能跑在工作区上；推的不是当前检出，跑了也说明不了推上去的内容。
    console.log(
      `pre-push：未检查：推送的提交不是当前检出（${elsewhere.localRef} ${elsewhere.localSha.slice(0, 9)}，HEAD ${head?.slice(0, 9) ?? "无"}）`,
    );
    return 0;
  }
  const files = new Set();
  let base = null;
  let unknownBase = false;
  for (const ref of refs) {
    const refBase = baseOf(ref, remote);
    if (!refBase) {
      unknownBase = true;
      continue;
    }
    if (ref.localSha === head || base === null) base = refBase;
    const diff = git(["diff", "--name-only", refBase, ref.localSha]);
    for (const file of (diff ?? "").split("\n").filter(Boolean))
      files.add(file);
  }
  const changed = [...files].sort();
  if (changed.length === 0 && !unknownBase) return 0;
  if (!existsSync(join(ROOT, "node_modules"))) {
    console.error(
      "pre-push：没装依赖，先 pnpm install（或 git push --no-verify 跳过检查）",
    );
    return 1;
  }
  mkdirSync(LOG_DIR, { recursive: true });

  const plan = planChecks(
    unknownBase ? ["package.json", ...changed] : changed,
    {
      base: unknownBase ? null : base,
      exists: (file) => existsSync(join(ROOT, file)),
    },
  );
  console.log(
    `pre-push：${unknownBase ? "拿不到基点，按全量" : `相对 ${base.slice(0, 9)} 改了 ${changed.length} 个文件`}${plan.docsOnly ? "（只有文档）" : ""}`,
  );
  const tree = workingTreeReport(
    parseStatus(
      gitRaw(["status", "--porcelain", "-z", "--untracked-files=all"]) ?? "",
    ),
    files,
  );
  const list = (paths) =>
    `${paths.slice(0, 8).join("、")}${paths.length > 8 ? ` 等 ${paths.length} 个` : ""}`;
  if (tree.inside.length > 0)
    console.log(
      `  注意：推送范围内的文件还有未提交的修改：${list(tree.inside)}`,
    );
  if (!plan.docsOnly && tree.outside.length > 0)
    console.log(
      `  注意：范围外有未提交的修改，检查会看到它们：${list(tree.outside)}`,
    );
  if (!plan.docsOnly && tree.untrackedOther.length > 0)
    console.log(`  注意：有未跟踪的文件：${list(tree.untrackedOther)}`);

  const keep = (step) => {
    if (!skip.steps.has(step.id)) return true;
    console.log(`  skip ${step.id}`);
    return false;
  };
  const results = [];
  // 未跟踪的源码会被类型检查、lint、测试读到，CI 上却没有：先拦下。
  if (
    !plan.docsOnly &&
    tree.untrackedCode.length > 0 &&
    keep({ id: "untracked" })
  ) {
    const log = join(LOG_DIR, "untracked.log");
    writeFileSync(
      log,
      `未跟踪的源码（提交、删除或加进 .gitignore）：\n${tree.untrackedCode.join("\n")}\n`,
    );
    console.log("  FAIL untracked");
    results.push({ id: "untracked", ok: false, log });
  }
  if (plan.libs && keep(plan.libs) && results.every((result) => result.ok))
    results.push(await runStep(plan.libs));
  if (results.every((result) => result.ok)) {
    results.push(
      ...(await Promise.all(
        plan.statics.filter(keep).map((step) => runStep(step)),
      )),
    );
  }
  if (results.every((result) => result.ok)) {
    const activeBuilds = plan.builds.filter(keep);
    const hasWebBuild = activeBuilds.some((step) => step.id === "build:web");
    results.push(
      ...(await sequence(
        activeBuilds.map((step) =>
          step.id === "build:desktop" && !hasWebBuild
            ? { ...step, env: undefined }
            : step,
        ),
      )),
    );
  }
  if (results.every((result) => result.ok))
    results.push(...(await sequence(plan.tests.filter(keep))));
  if (results.every((result) => result.ok) && !plan.docsOnly)
    results.push(...(await probes(changed)));

  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return 0;
  for (const result of failed)
    console.log(
      `\n── ${result.id} 失败（完整输出：${result.log}）──\n${tail(result.log)}`,
    );
  console.log(
    [
      "",
      `推送已拦下：${failed.map((result) => result.id).join("、")} 失败。修好、提交后再推。`,
      "  格式：pnpm format；lint 与类型：按上面的报错改；单测：进对应包 pnpm exec vitest run <文件>。",
      `  确需先推：git push --no-verify，或 ARMADRA_SKIP_PREPUSH=${failed[0].id} git push 只跳过这一步。`,
    ].join("\n"),
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(
    process.argv.slice(2),
    readFileSync(process.stdin.fd, "utf8"),
  );
}
