// windows-acceptance.mjs 不依赖 Windows 的一半（补全计划 G3-2）：检查项表、参数、结果
// 文件、用户配置快照、各 shell 的启动行与探针自己的 `.launch`、页内工具、调试端口与
// CDP、干跑的自检。不起进程，任何平台都能导入；测试（windows-acceptance.test.mjs）
// 与探针共用它。
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const SCHEMA = "armadra-windows-acceptance/1";

/**
 * 每一项检查：id 稳定（贴回来的结果按它对照），title 是给人看的一句话。
 * 顺序就是执行顺序。
 */
export const CHECKS = [
  ["preflight.platform", "在 Windows 上运行，Node 22+"],
  ["preflight.existing", "--installer 模式下机器上没有已登记的 Armadra 安装"],
  ["install.silent", "NSIS 安装包 /S 静默装进临时目录"],
  [
    "install.layout",
    "包里有 armadra-hook.exe / armadra-launch.exe / 会话宿主 / ConPTY 原生模块",
  ],
  [
    "install.signature",
    "安装包、Armadra.exe、armadra-launch.exe 的 Authenticode 状态",
  ],
  ["app.start", "临时数据目录与临时 HOME 起应用，页面与 core 应答"],
  ["app.updater", "更新器状态（签名、是否本地构建）读得出"],
  ["terminal.backend", "终端后端是 sessionHost"],
  [
    "terminal.shells",
    "cmd / pwsh 7 / Windows PowerShell 5.1 各起一个终端，输入有回显，capture 读得到",
  ],
  ["sessionHost.process", "会话宿主进程在，命名管道 armadra-session-* 在"],
  [
    "sessionHost.replies",
    "会话宿主与查询应答（#565）：附着回放里的旧查询不算待答，实时查询只答一份，每次查询至多一份应答；ConPTY 转出查询时宿主在没有可写附着时代答、有可写附着时不答、附着离开后接着答，控制台自己答时宿主不答",
  ],
  [
    "launcher.dialects",
    "armadra-launch.exe 在三种 shell 里：参数原样、注入在后、门关时不注入",
  ],
  ["launcher.credential", "armadra-launch.exe 兑换节点凭据：变量只进 CLI 进程"],
  ["credentials.status", "GET /api/credentials：DPAPI 后端且可用"],
  ["gateway.loopback", "Gateway 开在回环上能握 TLS，关掉后停止监听"],
  ["files.watch", "文件监听：外部改文件后收到 file.changed"],
  ["agent.codex", "经页面起 Codex，画面出现 Codex 的界面（--with-codex）"],
  ["soak", "保活：终端持续输出，进程都在，资源采样"],
  [
    "restart.survives",
    "应用主进程被杀后会话宿主与 shell 都在，重启后接回同一会话",
  ],
  [
    "sessionHost.closeMany",
    "同时终止多个终端、同时往其它终端输入：会话宿主还是原来那个进程，其它终端照常应答（#659）",
  ],
  [
    "conpty.close",
    "终止会话后 shell 进程与它的控制台宿主都退出，会话宿主还是原来那个进程",
  ],
  [
    "sessionHost.leaves",
    "应用退出后会话宿主没有会话、没有 core 连着，自己退出（不用结束进程）",
  ],
  ["app.logs", "数据目录日志里的 error / fatal 行"],
  [
    "uninstall.silent",
    "卸载程序 /S 后安装目录、注册表卸载项与快捷方式都不在；卸载前起的空闲会话宿主经 shutdownIfIdle 自己退出，卸载后没有残留 Armadra.exe",
  ],
  ["userConfig.untouched", "操作员真实用户配置在开始前与结束后逐字节相同"],
].map(([id, title]) => ({ id, title }));

const CHECK_IDS = new Set(CHECKS.map((check) => check.id));

/** 中途放弃时也要做的收尾项：日志、卸载、用户配置比对。 */
export const TEARDOWN_CHECKS = [
  "sessionHost.leaves",
  "app.logs",
  "uninstall.silent",
  "userConfig.untouched",
];

/* ------------------------------ session host ------------------------------ */

/** 命令行是不是会话宿主（`ELECTRON_RUN_AS_NODE=1 Armadra.exe …\session-host\host.cjs <data>`）。 */
export function isSessionHost(commandLine) {
  return /session-host[\\/]host\.cjs/i.test(commandLine ?? "");
}

/**
 * 卸载前探针自己起的那个空闲会话宿主的环境：没有会话、没人连着时宿主本该十秒后
 * 自己走（R-68），这里放宽到十分钟，留给卸载程序去请它。
 */
export const IDLE_HOST_ENV = {
  ELECTRON_RUN_AS_NODE: "1",
  ARMADRA_SESSION_HOST_ORPHAN_EXIT_MS: "600000",
};

export function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * 那个宿主的结论：开始监听过、日志里是 `shutdownIfIdle` 让它走的（卸载程序经
 * `shutdown-if-idle.cjs` 请走；按进程名结束不会留下这一行）、进程已不在。
 */
export function idleHostVerdict({
  started = true,
  pid,
  log = "",
  alive = false,
}) {
  const listening = log.includes("listening on");
  const releasedByRequest = log.includes(
    "session host leaving: shutdownIfIdle",
  );
  return {
    ok: started && listening && releasedByRequest && !alive,
    started,
    listening,
    releasedByRequest,
    alive,
    pid: pid ?? null,
    logTail: log.slice(-800),
  };
}

/* --------------------------------- options -------------------------------- */

export function parseArgs(argv) {
  const options = {
    installer: undefined,
    app: undefined,
    out: undefined,
    soakMinutes: 30,
    withCodex: false,
    requireSigned: false,
    keep: false,
    dryRun: false,
  };
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--"))
      throw new Error(`${flag} 需要一个值`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--installer":
        options.installer = resolve(value(index, arg));
        index += 1;
        break;
      case "--app":
        options.app = resolve(value(index, arg));
        index += 1;
        break;
      case "--out":
        options.out = resolve(value(index, arg));
        index += 1;
        break;
      case "--soak-minutes": {
        const minutes = Number(value(index, arg));
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60)
          throw new Error("--soak-minutes 是 0 到 1440 之间的数");
        options.soakMinutes = minutes;
        index += 1;
        break;
      }
      case "--with-codex":
        options.withCodex = true;
        break;
      case "--require-signed":
        options.requireSigned = true;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`不认识的参数：${arg}`);
    }
  }
  if (!options.dryRun && !options.help) {
    if ((options.installer === undefined) === (options.app === undefined))
      throw new Error(
        "--installer 与 --app 必须给且只给一个（或用 --dry-run）",
      );
  }
  return options;
}

/* --------------------------------- result --------------------------------- */

export function newResult(options) {
  return {
    schema: SCHEMA,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationSeconds: null,
    options: {
      mode: options.dryRun ? "dryRun" : options.installer ? "installer" : "app",
      installer: options.installer ? basename(options.installer) : null,
      app: options.app ?? null,
      soakMinutes: options.soakMinutes,
      withCodex: options.withCodex,
      requireSigned: options.requireSigned,
    },
    machine: null,
    app: null,
    checks: CHECKS.map(({ id, title }) => ({
      id,
      title,
      status: "pending",
      detail: null,
      seconds: null,
    })),
    samples: [],
    selfTest: [],
    failures: [],
  };
}

/**
 * 整体结论：有 fail 就是 failed；干跑是 dryRun（自检失败也算 failed）；还有
 * pending 的项（中途退出）是 incomplete；否则 passed（skip 与 warn 不拉低）。
 */
export function summarize(result) {
  const failed = result.checks.filter((check) => check.status === "fail");
  const selfFailed = result.selfTest.filter((test) => !test.ok);
  result.failures = [
    ...failed.map((check) => check.id),
    ...selfFailed.map((test) => `selfTest.${test.name}`),
  ];
  // 脚本自己中途抛错：后面的项都成了 skip，不能因此算通过。
  if (result.error) result.failures.push("probe.error");
  if (result.failures.length > 0) return "failed";
  if (result.options.mode === "dryRun") return "dryRun";
  if (result.checks.some((check) => check.status === "pending"))
    return "incomplete";
  return "passed";
}

/** 结果文件的形状自检：贴回来的文件先过这一关。答问题列表，空 = 合格。 */
export function validateResult(result) {
  const problems = [];
  if (result?.schema !== SCHEMA) problems.push(`schema 不是 ${SCHEMA}`);
  if (!["passed", "failed", "incomplete", "dryRun"].includes(result?.status))
    problems.push(`status 不认识：${result?.status}`);
  const ids = (result?.checks ?? []).map((check) => check.id);
  for (const id of CHECK_IDS)
    if (!ids.includes(id)) problems.push(`缺检查项 ${id}`);
  for (const check of result?.checks ?? []) {
    if (!CHECK_IDS.has(check.id)) problems.push(`多出的检查项 ${check.id}`);
    if (!["pass", "fail", "warn", "skip", "pending"].includes(check.status))
      problems.push(`${check.id} 的 status 不认识：${check.status}`);
  }
  if (!Array.isArray(result?.samples)) problems.push("samples 不是数组");
  return problems;
}

export class Recorder {
  constructor(result, log = console.log) {
    this.result = result;
    this.log = log;
  }

  entry(id) {
    const entry = this.result.checks.find((check) => check.id === id);
    if (entry === undefined) throw new Error(`没有登记的检查项 ${id}`);
    return entry;
  }

  set(id, status, detail, seconds = null) {
    const entry = this.entry(id);
    entry.status = status;
    entry.detail = detail ?? null;
    entry.seconds = seconds;
    const mark = { pass: "ok  ", fail: "FAIL", warn: "warn", skip: "skip" }[
      status
    ];
    this.log(
      `  ${mark} ${id}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`,
    );
  }

  skip(id, reason) {
    this.set(id, "skip", { reason });
  }

  /**
   * 跑一项：`run` 答 `{ ok, detail, warn? }`；抛错记 fail。答 `ok`，让调用方决定
   * 后面依赖它的项还跑不跑。
   */
  async check(id, run) {
    const started = Date.now();
    this.log(`  …    ${id}`);
    try {
      const outcome = await run();
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const status = outcome.ok ? (outcome.warn ? "warn" : "pass") : "fail";
      this.set(id, status, outcome.detail, seconds);
      return outcome.ok;
    } catch (error) {
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      this.set(
        id,
        "fail",
        { error: error instanceof Error ? error.message : String(error) },
        seconds,
      );
      return false;
    }
  }

  /** 还没跑的项都记 skip；`keep` 里的留给收尾去做。 */
  skipRest(reason, keep = []) {
    for (const check of this.result.checks)
      if (check.status === "pending" && !keep.includes(check.id))
        this.skip(check.id, reason);
  }
}

/* ------------------------------ user config -------------------------------- */

/**
 * 操作员真实用户配置里，Armadra 或它的安装 / 卸载程序可能写到的地方。
 * 只读：拍快照前后比较，从不打开写。
 */
export function userConfigTargets({ home, appData, localAppData }) {
  const targets = [
    join(home, ".claude", "settings.json"),
    join(home, ".claude", "settings.local.json"),
    join(home, ".claude.json"),
    join(home, ".claude", "skills", "armadra"),
    join(home, ".codex", "config.toml"),
    join(home, ".codex", "hooks.json"),
    join(home, ".codex", "skills", "armadra"),
    join(home, ".copilot", "hooks"),
    join(home, ".copilot", "config.json"),
    join(home, ".config", "opencode"),
    join(home, ".pi"),
    join(home, ".omp"),
    join(home, ".gitconfig"),
  ];
  if (appData) {
    targets.push(join(appData, "Armadra"));
    targets.push(join(appData, "npm", "armadra-hook.cmd"));
  }
  // 只看更新器的下载目录：NSIS 安装包按 electron-builder 的设计把自己复制成
  // `armadra-updater\installer.exe`（差分更新的基准，卸载也不删），那是安装这一步
  // 的产物，不是应用写进了操作员的目录。
  if (localAppData)
    targets.push(join(localAppData, "armadra-updater", "pending"));
  return targets;
}

const MAX_HASHED_FILES = 2_000;

function hashFile(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    return `unreadable:${error.code ?? "error"}`;
  }
}

function describePath(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { exists: false };
  }
  if (stat.isFile())
    return { exists: true, kind: "file", sha256: hashFile(path) };
  if (!stat.isDirectory()) return { exists: true, kind: "other" };
  const entries = [];
  const walk = (directory, prefix) => {
    let names;
    try {
      names = readdirSync(directory, { withFileTypes: true });
    } catch {
      entries.push(`${prefix}<unreadable>`);
      return;
    }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= MAX_HASHED_FILES) return;
      const full = join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        entries.push(`${name}/`);
        walk(full, `${name}/`);
      } else if (entry.isFile()) {
        entries.push(`${name}:${hashFile(full)}`);
      } else {
        entries.push(`${name}@`);
      }
    }
  };
  walk(path, "");
  return {
    exists: true,
    kind: "directory",
    entries: entries.length,
    sha256: createHash("sha256").update(entries.join("\n")).digest("hex"),
  };
}

/** `{ 路径: 描述 }`：文件是内容的 SHA-256，目录是逐个条目名与内容的摘要。 */
export function snapshot(paths) {
  return Object.fromEntries(paths.map((path) => [path, describePath(path)]));
}

/** 两次快照不同的路径。 */
export function diffSnapshots(before, after) {
  const changed = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[path]) !== JSON.stringify(after[path]))
      changed.push({
        path,
        before: before[path] ?? null,
        after: after[path] ?? null,
      });
  }
  return changed;
}

/* ------------------------------- launch lines ------------------------------ */

/** 调用者给的值：空格、`&`、`|` 都要原样到达。没有 `"` 与 `%`（cmd 交互读不了）。 */
export const CALLER_VALUES = ["a b", "c&d", "x|y", "plain"];
/** 注入的词与变量：写在 `.launch` 里，不经任何 shell。 */
export const INJECTED_ARGS = ["--injected", 'say "hi" & 100% ^ | <x>'];
export const INJECTED_ENV = ["ARMADRA_PROBE_ENV", "a b & c | d <e> 100% ^f"];

/**
 * 节点 shell 里敲的那一行：启动器、程序、程序的参数。`cmd` 用双引号；两种
 * PowerShell 用 `&` 加单引号（单引号里只有 `'` 要写成两个）。值里不许有 `"`、`%`
 * ——那是 cmd 交互读不了的，脚本自己的值没有。
 */
export function launchLine(dialect, launcher, words) {
  for (const word of [launcher, ...words]) {
    if (/["%\r\n]/.test(word))
      throw new Error(`启动行的值不能含 " % 或换行：${word}`);
  }
  if (dialect === "cmd")
    return [launcher, ...words].map((word) => `"${word}"`).join(" ");
  if (dialect === "pwsh" || dialect === "powershell")
    return `& ${[launcher, ...words].map((word) => `'${word.replaceAll("'", "''")}'`).join(" ")}`;
  throw new Error(`不认识的 shell：${dialect}`);
}

/** 设一个环境变量的那一行。 */
export function setEnvLine(dialect, name, value) {
  if (dialect === "cmd")
    return value === "" ? `set ${name}=` : `set ${name}=${value}`;
  return value === ""
    ? `Remove-Item Env:${name} -ErrorAction SilentlyContinue`
    : `$env:${name}='${value.replaceAll("'", "''")}'`;
}

/**
 * 打印一个记号的那一行：源码里没有连续的记号文本，所以 shell 回显输入时不会
 * 误判——只有命令真的执行了，输出里才出现完整的记号。
 */
export function markerLine(dialect, marker) {
  const [head, tail] = [marker.slice(0, -2), marker.slice(-2)];
  if (dialect === "cmd") return `echo ${head}^${tail[0]}^${tail[1]}`;
  return `Write-Output ('${head}' + '${tail}')`;
}

/** 一直打印的循环（保活）；Ctrl+C 停。 */
export function loopLine(dialect) {
  if (dialect === "cmd")
    return "for /L %i in (1,0,2) do @(echo tick-^O^K & ping -n 2 127.0.0.1 >nul)";
  return "while ($true) { 'tick-' + 'OK'; Start-Sleep -Seconds 1 }";
}

/**
 * 保活之后的回显判定。Ctrl+C 停循环后先等输出静下来（提示符回来了），再敲记号；
 * 记号没回来就整行重敲，最多 `attempts` 次。Windows PowerShell 5.1 在忙的
 * runner 上停管线、回到提示符可以超过固定的两秒，这期间敲进去的字会被 Ctrl+C
 * 的处理清掉（nightly 37906434287：5.1 无回显，同一会话重启后立刻有回显）。
 * 不改用户 shell 的启动方式，只让探针不在提示符回来之前计时。
 *
 * `terminal(lines, waitFor, timeoutMs)` 是绑定了会话的 `app.terminal`。
 */
export async function responsiveAfterLoop(
  terminal,
  dialect,
  marker,
  { settleMs = 30_000, quietMs = 3_000, attempts = 3, attemptMs = 20_000 } = {},
) {
  let settled = await terminal(["\u0003"], { quietMs }, settleMs);
  if (!settled.ok) settled = await terminal(["\u0003"], { quietMs }, settleMs);
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await terminal(
      ["\r", `${markerLine(dialect, marker)}\r`],
      marker,
      attemptMs,
    );
    if (last.ok)
      return { ok: true, attempts: attempt, settled: settled.reason };
  }
  return {
    ok: false,
    attempts,
    settled: settled.reason,
    reason: last?.reason ?? null,
    tail: (last?.tail ?? "").slice(-600),
  };
}

export const ECHO_SCRIPT = [
  "const fs = require('node:fs');",
  "const [out, ...argv] = process.argv.slice(2);",
  "const pick = (name) => process.env[name] ?? null;",
  `fs.writeFileSync(out, JSON.stringify({ argv, env: pick(${JSON.stringify(INJECTED_ENV[0])}), token: pick('ARMADRA_PROBE_TOKEN') }));`,
].join("\n");

export const FAKE_CLIENT_SCRIPT = [
  "if (process.argv[2] !== 'credential') process.exit(9);",
  "process.stdout.write('ARMADRA_PROBE_TOKEN=probe-' + 'token & 100%');",
].join("\n");

export const PROBE_TOKEN = "probe-token & 100%";

/** 探针自己的启动器：安装包里的 armadra-launch.exe 拷一份，旁边一份 `.launch`。 */
export function probeLaunchConfig({ client }) {
  return [
    "armadra-launch 1",
    "# windows-acceptance probe",
    "gate=ARMADRA_NODE_ID",
    `env=${INJECTED_ENV[0]}=${INJECTED_ENV[1]}`,
    ...INJECTED_ARGS.map((word) => `arg=${word}`),
    `credential=${client}`,
    "credential-var=ARMADRA_PROBE_TOKEN",
    "",
  ].join("\r\n");
}

/* ------------------------------ app & install ---------------------------- */

/**
 * 装进页面的小工具：经页面自己的地址与身份调 core（core 判的就是这个来源），
 * 终端经 WebSocket 附着、输入、等输出。
 *
 * 0.2.0 起回环上每条 `/api/` 与每条流都要会话（`core/identity/loopback.ts`，
 * 契约 §3.2）：和页面自己一样，经壳的桥取一张票、`POST /api/identity/pair`
 * 换 Bearer，HTTP 带 `Authorization`，WebSocket 先换一次性票放进
 * `Sec-WebSocket-Protocol`。Bearer 只在页面内存里，不回传给探针。
 */
export const PAGE_HELPERS = `(() => {
  const bridge = globalThis.window?.armadra;
  if (!bridge?.transport) throw new Error("window.armadra 上没有壳的桥");
  const { httpBase, wsBase } = bridge.transport.endpointsSync();
  let access = "";
  let pairing = null;
  async function pair() {
    const answer = await bridge.identity.ticket();
    if (!answer?.ok) throw new Error("壳没签出票：" + JSON.stringify(answer?.error ?? null));
    const response = await fetch(httpBase + "/api/identity/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: answer.ticket.ticket }),
    });
    const session = await response.json().catch(() => null);
    if (!response.ok || !session?.native?.accessToken)
      throw new Error("配对失败：" + response.status);
    access = session.native.accessToken;
    return access;
  }
  async function bearer(rejected) {
    if (access && access !== rejected) return access;
    pairing ??= pair().finally(() => { pairing = null; });
    return await pairing;
  }
  async function send(method, path, body, token) {
    const headers = { authorization: "Bearer " + token };
    if (body !== undefined) headers["content-type"] = "application/json";
    return await fetch(httpBase + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function api(method, path, body) {
    const used = await bearer();
    let response = await send(method, path, body, used);
    if (response.status === 401) response = await send(method, path, body, await bearer(used));
    const text = await response.text();
    let json = null;
    try { json = text === "" ? null : JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
    return { status: response.status, body: json };
  }
  async function wsProtocols() {
    const answer = await api("POST", "/api/identity/ws-ticket");
    if (answer.status !== 200 || !answer.body?.ticket) throw new Error("ws-ticket " + answer.status);
    return ["armadra-ticket." + answer.body.ticket];
  }
  async function terminal(sessionId, writer, lines, waitFor, timeoutMs) {
    const protocols = await wsProtocols();
    return await new Promise((done) => {
      const socket = new WebSocket(wsBase + "/api/terminals/" + sessionId + "/ws?writer=" + writer, protocols);
      let output = "";
      let hello = null;
      let inputId = 0;
      const finish = (ok, reason) => {
        clearTimeout(timer);
        clearTimeout(quiet);
        try { socket.close(); } catch {}
        done({ ok, reason, hello, tail: output.slice(-2000) });
      };
      // waitFor：null 只管发；字符串等它出现；{ quietMs } 等输出停够这么久（快照不算）。
      const quietMs = typeof waitFor === "object" && waitFor !== null ? waitFor.quietMs : null;
      let quiet = null;
      const hush = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(true, "quiet"), quietMs);
      };
      const timer = setTimeout(() => finish(waitFor === null, "timeout"), timeoutMs);
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === "hello") {
          hello = frame;
          for (const line of lines) {
            inputId += 1;
            socket.send(JSON.stringify({ type: "input", data: line, inputId }));
          }
          if (waitFor === null) setTimeout(() => finish(true, "sent"), 500);
          if (quietMs !== null) hush();
          return;
        }
        if (frame.type === "output" || frame.type === "snapshot") {
          output += frame.data;
          if (quietMs !== null) {
            if (frame.type === "output" && hello !== null) hush();
          } else if (waitFor !== null && output.includes(waitFor)) finish(true, "matched");
        }
      };
      socket.onerror = () => finish(false, "socket error");
    });
  }
  async function events(workspaceId, type, trigger, timeoutMs) {
    const protocols = await wsProtocols();
    return await new Promise((done) => {
      const socket = new WebSocket(wsBase + "/api/workspaces/" + workspaceId + "/events", protocols);
      const timer = setTimeout(() => { try { socket.close(); } catch {} done({ ok: false, reason: "timeout" }); }, timeoutMs);
      socket.onopen = () => { setTimeout(() => trigger(), 300); };
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === type) { clearTimeout(timer); socket.close(); done({ ok: true, event: frame }); }
      };
      socket.onerror = () => { clearTimeout(timer); done({ ok: false, reason: "socket error" }); };
    });
  }
  // 长开的附着（#565）：探针自己当一个页面，声明 replies=1，只在被告知时才发应答，
  // 这样「谁在答查询」完全由探针决定。
  const watchers = new Map();
  async function watchOpen(key, sessionId) {
    const protocols = await wsProtocols();
    return await new Promise((done) => {
      const socket = new WebSocket(wsBase + "/api/terminals/" + sessionId + "/ws?writer=acceptance-" + key + "&replies=1", protocols);
      const state = { socket, hello: null, seen: "" };
      watchers.set(key, state);
      const timer = setTimeout(() => done({ ok: false, reason: "timeout" }), 20000);
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === "hello") {
          state.hello = frame;
          clearTimeout(timer);
          done({ ok: true });
        } else if (frame.type === "output" || frame.type === "snapshot") {
          state.seen += frame.data;
        }
      };
      socket.onerror = () => { clearTimeout(timer); done({ ok: false, reason: "socket error" }); };
    });
  }
  function watchRead(key) {
    const state = watchers.get(key);
    return state ? { seen: state.seen.slice(-8000), open: state.socket.readyState === 1 } : null;
  }
  function watchSend(key, frame) {
    const state = watchers.get(key);
    if (!state || state.socket.readyState !== 1) return false;
    state.socket.send(JSON.stringify(frame));
    return true;
  }
  function watchClose(key) {
    const state = watchers.get(key);
    watchers.delete(key);
    try { state?.socket.close(); } catch {}
    return true;
  }
  globalThis.__acceptance = { httpBase, wsBase, api, terminal, events, watchOpen, watchRead, watchSend, watchClose };
  return { httpBase, wsBase };
})()`;

/**
 * 会话宿主代答验收的被测程序（#565）：往终端里发查询，把收到的每一段输入原样记成
 * `GOT:<阶段>:<十六进制>`，所以「谁答了查询」读 capture 就知道。
 *
 *   * `replay`：先发一次 DA1（`ESC [ c`）和 `REPLAYSENT`，6 秒后再发一次 DA1 和
 *     `SECONDQUERY`，此后的输入记在阶段 `live` 下，之前的记在 `replay` 下；
 *   * `loop`：每秒发一次 DA1 和 `TICK:<n>`，输入记在当时的 n 下。用 DA1 而不是 DSR 5n：
 *     三方对 DA1 的应答字节各不相同（{@link PROBE_DA1}、{@link HOST_DA1}、控制台自己的），
 *     读输入就分得出是谁答的。
 */
export const QUERY_SCRIPT = [
  "const mode = process.argv[2];",
  "let phase = mode === 'replay' ? 'replay' : 0;",
  "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
  "process.stdin.resume();",
  "process.stdin.on('data', (chunk) => process.stdout.write('\\r\\nGOT:' + phase + ':' + chunk.toString('hex') + '\\r\\n'));",
  "if (mode === 'replay') {",
  "  process.stdout.write('\\x1b[c\\r\\nREPLAYSENT\\r\\n');",
  "  setTimeout(() => { phase = 'live'; process.stdout.write('\\x1b[c\\r\\nSECONDQUERY\\r\\n'); }, 6000);",
  "  setTimeout(() => process.exit(0), 40000);",
  "} else {",
  "  const timer = setInterval(() => {",
  "    phase += 1;",
  "    process.stdout.write('\\x1b[c\\r\\nTICK:' + phase + '\\r\\n');",
  "    if (phase >= 90) { clearInterval(timer); process.exit(0); }",
  "  }, 1000);",
  "}",
].join("\n");

/** 探针扮演的页面终端对 DA1 的应答（只在探针决定时发）。 */
export const PROBE_DA1 = "\u001b[?1;2c";
/** 会话宿主代答 DA1 的字节（`session-host/replay.ts` 的 `answerFor`）。 */
export const HOST_DA1 = "\u001b[?1;0c";

/** capture 文本里程序记下的输入：`{ phase, hex }`。 */
export function receivedInputs(text) {
  return [...String(text).matchAll(/GOT:(\w+):([0-9a-f]+)/g)].map((match) => ({
    phase: /^\d+$/.test(match[1]) ? Number(match[1]) : match[1],
    hex: match[2],
  }));
}

/**
 * 一段输入里的 DA1 应答各是谁发的：`probe`、`host`，其余的 DA1 应答是 `console`
 * （ConPTY 背后的控制台自己答的）；一段里认不出 DA1 应答就记一个 `unknown`。
 */
export function answerSources(hex) {
  const text = Buffer.from(hex, "hex").toString("latin1");
  const found = [...text.matchAll(/\u001b\[\?[0-9;]*c/g)].map(([answer]) =>
    answer === PROBE_DA1 ? "probe" : answer === HOST_DA1 ? "host" : "console",
  );
  return found.length > 0 ? found : ["unknown"];
}

/** 一组输入里按来源计数。 */
export function countSources(inputs) {
  const counts = { probe: 0, host: 0, console: 0, unknown: 0 };
  for (const row of inputs)
    for (const source of answerSources(row.hex)) counts[source] += 1;
  return counts;
}

/** 程序打到第几个 TICK 了。 */
export function lastTick(text) {
  let last = 0;
  for (const match of String(text).matchAll(/TICK:(\d+)/g))
    last = Math.max(last, Number(match[1]));
  return last;
}

/**
 * 宿主代答三段的判定：`inputs` 是 `receivedInputs` 的结果，三个区间都是 [from, to]
 * 的 TICK 号（两头已经留出附着与断开的时延）。每个 TICK 至多一份应答（多了就是重复
 * 输入，#518）。`forwarded` 是 ConPTY 有没有把查询转给外面：
 *
 *   * 转了：没有可写附着的头尾两段每个 TICK 都该有一份宿主的应答；有可写附着（而它
 *     不答）的中间一段一份都不该有；
 *   * 没转（控制台自己答了，宿主与页面都看不到查询）：三段都是每个 TICK 一份控制台的
 *     应答，宿主一份都不该答。
 */
export function hostAnswerVerdict(
  inputs,
  { before, during, after },
  forwarded,
) {
  const ticks = inputs.filter((row) => typeof row.phase === "number");
  const within = ([from, to]) =>
    ticks.filter((row) => row.phase >= from && row.phase <= to);
  const counts = {
    before: countSources(within(before)),
    during: countSources(within(during)),
    after: countSources(within(after)),
  };
  const perTick = new Map();
  for (const row of ticks)
    perTick.set(
      row.phase,
      (perTick.get(row.phase) ?? 0) + answerSources(row.hex).length,
    );
  const duplicated = [...perTick]
    .filter(([, count]) => count > 1)
    .map(([tick]) => tick);
  const span = (range) => range[1] - range[0] + 1;
  const total = (phase) =>
    Object.values(counts[phase]).reduce((sum, count) => sum + count, 0);
  const full = (phase, source) =>
    counts[phase][source] >= span({ before, during, after }[phase]) - 1;
  const ok =
    duplicated.length === 0 &&
    (forwarded
      ? full("before", "host") && total("during") === 0 && full("after", "host")
      : ["before", "during", "after"].every(
          (phase) => full(phase, "console") && counts[phase].host === 0,
        ));
  return { ok, counts, duplicated };
}

/**
 * 回放一段的判定（`stale` / `live` 是阶段 `replay` / `live` 的输入）。两种情形都要求：
 * 探针替回放里旧查询发的应答不到程序，实时查询只到一份应答。
 *
 *   * ConPTY 转了查询：回放里看得到旧查询；没有人答旧查询（附着着的探针不答，宿主见
 *     可写附着也不答），实时查询的那一份是探针的；
 *   * 没转（控制台自己答）：两次查询各有一份控制台的应答，探针与宿主的都不到。
 */
export function replayVerdict({ stale, live, replayed, sawSecond }, forwarded) {
  const before = countSources(stale);
  const after = countSources(live);
  const sum = (counts) =>
    Object.values(counts).reduce((total, count) => total + count, 0);
  const ok =
    sawSecond &&
    before.probe === 0 &&
    sum(after) === 1 &&
    (forwarded
      ? replayed && sum(before) === 0 && after.probe === 1
      : before.console === 1 && sum(before) === 1 && after.console === 1);
  return { ok, stale: before, live: after };
}

/**
 * `sessionHost.replies`（#565）：见 CHECKS 里的说明与 `QUERY_SCRIPT`。`app` 要有
 * `api`、`terminal`、`evaluate`；长开的附着经页面里的 `watch*` 助手。
 */
export async function sessionHostReplies(record, app, result, dirs) {
  const shell = result.machine.shells.cmd;
  if (!shell) return record.skip("sessionHost.replies", "没有 cmd.exe");
  const work = dirname(dirs.wsDir);
  return await record.check("sessionHost.replies", () =>
    runSessionHostReplies({ app, shell, work, ...dirs }),
  );
}

async function runSessionHostReplies({ app, work, workspaceId, wsDir, shell }) {
  const watch = (action, ...args) =>
    app.evaluate(
      `(globalThis.__acceptance).watch${action}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`,
    );
  const script = join(work, "query-program.js");
  writeFileSync(script, QUERY_SCRIPT);
  const start = async (mode, wanted) => {
    const response = await app.api("POST", "/api/terminals", {
      workspaceId,
      cwd: wsDir,
      shell,
    });
    const id = response.body?.id;
    if (typeof id !== "string") return { error: response };
    const typed = await app.terminal(
      id,
      [`"${process.execPath}" "${script}" ${mode}\r`],
      wanted,
      60_000,
    );
    return { id, typed };
  };
  // capture 读的是 core 按附着收到的字节排出的屏幕（契约 §53）：没人附着时它停在最后
  // 一个附着离开的那一刻。所以下面每次读 capture 都在某个附着开着的时候读。
  const screen = async (id) => {
    const capture = await app.api(
      "GET",
      `/api/terminals/${id}/capture?lines=500`,
    );
    return typeof capture.body?.data === "string" ? capture.body.data : "";
  };
  const finish = (id) =>
    app.api("POST", `/api/terminals/${id}/terminate`, {
      mode: "session",
    });
  const detail = {};
  const sample = (inputs) =>
    [...new Set(inputs.map((row) => row.hex))].slice(0, 4);

  // 一、附着回放里带着查询：回放是过去，视图对它的应答没有人在等，不能变成输入；
  // 随后程序发的实时查询，只放行一份。
  const replay = await start("replay", "REPLAYSENT");
  if (replay.id === undefined) {
    return { ok: false, detail: { replay } };
  }
  const opened = await watch("Open", "late", replay.id);
  await sleep(500);
  const late = await watch("Read", "late");
  const replayed = (late?.seen ?? "").includes("\u001b[c");
  // 回放里那次查询的应答（页面的终端会这么答）：不该到达程序。
  await watch("Send", "late", {
    type: "input",
    data: PROBE_DA1,
    reply: true,
  });
  let sawSecond = false;
  let liveSeen = "";
  for (let waited = 0; waited < 20_000; waited += 250) {
    const now = await watch("Read", "late");
    liveSeen = now?.seen ?? "";
    if (liveSeen.includes("SECONDQUERY")) {
      sawSecond = true;
      break;
    }
    await sleep(250);
  }
  if (sawSecond) {
    // 同一条实时查询两份应答（两个视图都会答）：只该有一份到程序。这里用同一条
    // socket 连发两份，账上第二份已经没有待答查询，必须被丢掉。
    for (let copy = 0; copy < 2; copy += 1) {
      await watch("Send", "late", {
        type: "input",
        data: PROBE_DA1,
        reply: true,
      });
    }
  }
  await sleep(2_000);
  const inputs = receivedInputs(await screen(replay.id));
  await watch("Close", "late");
  await finish(replay.id);
  const stale = inputs.filter((row) => row.phase === "replay");
  const live = inputs.filter((row) => row.phase === "live");
  // ConPTY 把程序的 DA1 转给外面没有：转了的话附着的视图在实时输出里看得到
  // `ESC [ c`。没转就是控制台自己答了，宿主与页面都不会见到这条查询。
  const forwardedReplay = replayed || liveSeen.includes("\u001b[c");
  const replayCheck = replayVerdict(
    { stale, live, replayed, sawSecond },
    forwardedReplay,
  );
  detail.replay = {
    attached: opened?.ok === true,
    queriesForwarded: forwardedReplay,
    replayHadQuery: replayed,
    sawSecondQuery: sawSecond,
    staleAnswers: replayCheck.stale,
    liveAnswers: replayCheck.live,
    inputs: sample([...stale, ...live]),
  };
  const replayOk = opened?.ok === true && replayCheck.ok;

  // 二、宿主代答的切换：没有附着时宿主答；有可写附着（页面的终端负责答，这里它
  // 故意不答）时宿主不答；附着离开后宿主接着答。TICK 号两头各留两格余量。
  const loop = await start("loop", "TICK:1");
  if (loop.id === undefined) {
    detail.replay.ok = replayOk;
    return { ok: false, detail: { ...detail, loop } };
  }
  // 没人附着的这段 capture 不动，读不到 TICK 走到几：按程序每秒一个 TICK 等够，
  // 区间的边界都按附着之后读到的 TICK 号算，不按这里的时长。
  await sleep(8_000);
  const watching = await watch("Open", "quiet", loop.id);
  const attachedAt = lastTick(await screen(loop.id));
  await sleep(6_000);
  const leftAt = lastTick(await screen(loop.id));
  const quietSeen = (await watch("Read", "quiet"))?.seen ?? "";
  await watch("Close", "quiet");
  await sleep(7_000);
  // 再附着一次，capture 换成宿主的整段回放：附着之前的输入都在里面。这次附着本身
  // 也是可写的，所以只看它之前两格的 TICK。
  const reopened = await watch("Open", "after", loop.id);
  const text = await screen(loop.id);
  await watch("Close", "after");
  await finish(loop.id);
  const reattachedAt = lastTick(text);
  const forwardedLoop = quietSeen.includes("\u001b[c");
  const loopInputs = receivedInputs(text);
  const verdict = hostAnswerVerdict(
    loopInputs,
    {
      before: [2, Math.max(2, attachedAt - 2)],
      during: [attachedAt + 2, Math.max(attachedAt + 2, leftAt - 2)],
      after: [leftAt + 2, Math.max(leftAt + 2, reattachedAt - 2)],
    },
    forwardedLoop,
  );
  detail.hostAnswers = {
    attached: watching?.ok === true,
    reattached: reopened?.ok === true,
    queriesForwarded: forwardedLoop,
    attachedAtTick: attachedAt,
    leftAtTick: leftAt,
    reattachedAtTick: reattachedAt,
    counts: verdict.counts,
    duplicated: verdict.duplicated,
    inputs: sample(loopInputs),
  };
  return {
    ok:
      replayOk &&
      watching?.ok === true &&
      reopened?.ok === true &&
      forwardedLoop === forwardedReplay &&
      verdict.ok,
    detail,
  };
}

export function newestUninstaller(installDir) {
  try {
    return readdirSync(installDir)
      .filter((name) => /^Uninstall .*\.exe$/i.test(name))
      .map((name) => join(installDir, name))[0];
  } catch {
    return undefined;
  }
}

export function findFile(root, name, depth = 6) {
  if (depth < 0) return undefined;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries)
    if (entry.isFile() && entry.name.toLowerCase() === name)
      return join(root, entry.name);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFile(join(root, entry.name), name, depth - 1);
    if (found) return found;
  }
  return undefined;
}

export function logFindings(dataDir) {
  const files = [];
  const walk = (directory, depth) => {
    if (depth < 0) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full, depth - 1);
      else if (entry.isFile() && /\.(log|jsonl)$/i.test(entry.name))
        files.push(full);
    }
  };
  walk(dataDir, 3);
  const findings = [];
  let bytes = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    bytes += Buffer.byteLength(text);
    for (const line of text.split(/\r?\n/))
      if (/\b(error|fatal|uncaught|unhandled)\b/i.test(line))
        findings.push(`${basename(file)}: ${line.slice(0, 300)}`);
  }
  return { files: files.map((file) => basename(file)), bytes, findings };
}

/** 对一个 https 来源发一次请求：握得上 TLS、拿到状态码就算到了（证书不在这里验）。 */
export function httpsProbe(origin) {
  return new Promise((done) => {
    const url = new URL("/api/identity/hello", origin);
    const req = httpsRequest(
      url,
      { rejectUnauthorized: false, timeout: 10_000 },
      (response) => {
        const certificate = response.socket.getPeerCertificate?.();
        response.resume();
        done({
          ok: true,
          status: response.statusCode,
          subject: certificate?.subject?.CN ?? null,
        });
      },
    );
    req.on("error", (error) => done({ ok: false, error: error.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

/* ------------------------------- ports & CDP ------------------------------ */

export async function freePort() {
  return await new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/**
 * 重启后等终端路由经页面答 200（nightly 37235828235：第一个问的 cmd 拿不到行、
 * 附着也失败，后两个正常）。`/api/health` 不验身份，答 200 不代表这一页已经向壳
 * 要到票、终端路由认它（推断，现场没留答复码）。等不到不抛：后面的核对照样判失败；
 * 首个答复码与等了多久记进结果。
 */
export async function waitForTerminalRoute(get, sessionId, timeout = 30_000) {
  const started = Date.now();
  let firstAnswer;
  await waitFor(
    "重启后终端路由经页面答 200",
    async () => {
      const row = await get(`/api/terminals/${sessionId}`);
      firstAnswer ??= row.status;
      return row.status === 200 ? true : undefined;
    },
    { timeout, interval: 500 },
  ).catch(() => undefined);
  return { firstAnswer, readyAfterMs: Date.now() - started };
}

export async function waitFor(
  what,
  test,
  { timeout = 60_000, interval = 500 } = {},
) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await test();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时（${Math.round(timeout / 1000)}s）：${what}`);
}

/* ----------------------------------- CDP ----------------------------------- */

/**
 * 调试端口上应用自己的回环页面。应用退了、或 core 起不来（壳会弹一个模态错误框，
 * 页面永远不出现）时立刻放弃，原因来自 `dead()`。
 */
export async function attachToRenderer(port, dead = () => undefined) {
  let seen = [];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const reason = dead();
    if (reason !== undefined) throw new Error(reason);
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(5_000),
        })
      ).json();
      seen = targets.map((target) => `${target.type} ${target.url}`);
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          target.webSocketDebuggerUrl &&
          /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(target.url ?? ""),
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // 应用还在起。
    }
    await sleep(500);
  }
  throw new Error(
    `调试端口 ${port} 上没有回环页面；看到 ${JSON.stringify(seen)}`,
  );
}

/** 页面里最长的一次等待（起 Codex 九十秒）再留余量。 */
const CDP_TIMEOUT_MS = 180_000;

export async function cdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let next = 1;
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", () => fail(new Error("CDP 连不上")), {
      once: true,
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error) waiter.fail(new Error(JSON.stringify(message.error)));
    else waiter.done(message.result);
  });
  // 应用退出或页面卡住时不能一直等：每次调用都有上限，连接断了全部失败。
  socket.addEventListener("close", () => {
    for (const waiter of pending.values())
      waiter.fail(new Error("CDP 连接断了"));
    pending.clear();
  });
  const send = (method, params) =>
    new Promise((done, fail) => {
      const id = next;
      next += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(
          new Error(`CDP ${method} 在 ${CDP_TIMEOUT_MS / 1000}s 内没有回答`),
        );
      }, CDP_TIMEOUT_MS);
      pending.set(id, {
        done: (value) => {
          clearTimeout(timer);
          done(value);
        },
        fail: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          `页面里抛错：${JSON.stringify(result.exceptionDetails).slice(0, 500)}`,
        );
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

/* --------------------------------- dry run --------------------------------- */

export function selfTests() {
  const tests = [];
  const test = (name, run) => {
    try {
      const detail = run();
      tests.push({ name, ok: true, detail: detail ?? null });
    } catch (error) {
      tests.push({ name, ok: false, detail: error.message });
    }
  };
  const equal = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}：${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  };
  test("snapshot", () => {
    const root = mkdtempSync(join(os.tmpdir(), "armadra-acceptance-dry-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), "model = 'x'\n");
      const targets = userConfigTargets({
        home,
        appData: join(root, "appdata"),
      });
      const first = snapshot(targets);
      equal(diffSnapshots(first, snapshot(targets)), [], "没改时两次快照不同");
      writeFileSync(join(home, ".codex", "config.toml"), "model = 'y'\n");
      mkdirSync(join(root, "appdata", "Armadra"), { recursive: true });
      const changed = diffSnapshots(first, snapshot(targets)).map((row) =>
        basename(row.path),
      );
      equal(changed.sort(), ["Armadra", "config.toml"], "改动没被发现");
      return { targets: targets.length };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("hostAnswers", () => {
    const hex = (text) => Buffer.from(text, "latin1").toString("hex");
    const host = hex(HOST_DA1);
    const conhost = hex("\u001b[?61;4;6;7;14;21;22;23;24;28;32;42c");
    const text = [
      "TICK:1",
      `GOT:3:${host}`,
      `GOT:4:${host}`,
      "TICK:7",
      `GOT:12:${host}`,
      `GOT:13:${host}`,
      `GOT:replay:${conhost}`,
      `GOT:live:${hex(PROBE_DA1)}`,
    ].join("\r\n");
    const inputs = receivedInputs(text);
    equal(
      inputs.map((row) => row.phase),
      [3, 4, 12, 13, "replay", "live"],
      "输入记录",
    );
    equal(lastTick(text), 7, "最后的 TICK");
    equal(
      answerSources(hex(PROBE_DA1 + HOST_DA1)),
      ["probe", "host"],
      "一段里两份应答",
    );
    equal(answerSources("41"), ["unknown"], "认不出的输入");
    const ranges = { before: [3, 4], during: [6, 11], after: [12, 13] };
    const forwarded = hostAnswerVerdict(inputs, ranges, true);
    equal(forwarded.ok, true, "转发时三段判定");
    equal(forwarded.counts.before.host, 2, "头一段宿主的应答");
    equal(
      hostAnswerVerdict(inputs, { ...ranges, during: [3, 4] }, true).ok,
      false,
      "中间一段有应答要判失败",
    );
    equal(
      hostAnswerVerdict(inputs, ranges, false).ok,
      false,
      "控制台自己答时宿主的应答要判失败",
    );
    const byConsole = receivedInputs(
      [3, 4, 7, 8, 12, 13].map((tick) => `GOT:${tick}:${conhost}`).join("\r\n"),
    );
    equal(
      hostAnswerVerdict(byConsole, { ...ranges, during: [7, 8] }, false).ok,
      true,
      "控制台自己答、每格一份",
    );
    equal(
      hostAnswerVerdict(
        [...byConsole, { phase: 7, hex: host }],
        { ...ranges, during: [7, 8] },
        false,
      ).duplicated,
      [7],
      "同一格两份应答",
    );
    const stale = inputs.filter((row) => row.phase === "replay");
    const live = inputs.filter((row) => row.phase === "live");
    equal(
      replayVerdict({ stale: [], live, replayed: true, sawSecond: true }, true)
        .ok,
      true,
      "转发时回放一段",
    );
    equal(
      replayVerdict({ stale, live, replayed: false, sawSecond: true }, false)
        .ok,
      false,
      "控制台自己答时探针的应答到了程序要判失败",
    );
    equal(
      replayVerdict(
        {
          stale,
          live: [{ phase: "live", hex: conhost }],
          replayed: false,
          sawSecond: true,
        },
        false,
      ).ok,
      true,
      "控制台自己答时回放一段",
    );
  });
  test("launchLines", () => {
    const exe = "C:\\data dir\\run\\probe.exe";
    equal(
      launchLine("cmd", exe, ["C:\\node.exe", "c&d"]),
      '"C:\\data dir\\run\\probe.exe" "C:\\node.exe" "c&d"',
      "cmd 行",
    );
    equal(
      launchLine("pwsh", exe, ["it's", "x|y"]),
      "& 'C:\\data dir\\run\\probe.exe' 'it''s' 'x|y'",
      "pwsh 行",
    );
    let refused = false;
    try {
      launchLine("cmd", exe, ["100%"]);
    } catch {
      refused = true;
    }
    equal(refused, true, "带 % 的值没被拒绝");
    for (const dialect of ["cmd", "pwsh", "powershell"]) {
      const line = markerLine(dialect, "ACC-x-OK");
      if (line.includes("ACC-x-OK"))
        throw new Error(`${dialect} 的记号行含完整记号`);
    }
  });
  test("launchConfig", () => {
    const text = probeLaunchConfig({ client: "C:\\x\\armadra-hook.cmd" });
    const lines = text.split("\r\n");
    equal(lines[0], "armadra-launch 1", "首行");
    if (!lines.includes("credential=C:\\x\\armadra-hook.cmd"))
      throw new Error("没有 credential= 行");
    if (lines.some((line) => /[\r\n]/.test(line)))
      throw new Error("值里有换行");
  });
  test("resultShape", () => {
    const result = newResult(parseArgs(["--dry-run"]));
    result.status = summarize(result);
    equal(validateResult(result), [], "空结果的形状");
  });
  test("parseArgs", () => {
    let refused = false;
    try {
      parseArgs(["--installer", "a.exe", "--app", "b.exe"]);
    } catch {
      refused = true;
    }
    equal(refused, true, "--installer 与 --app 同时给没被拒绝");
    equal(
      parseArgs(["--app", "x.exe", "--soak-minutes", "2"]).soakMinutes,
      2,
      "保活时长",
    );
  });
  return tests;
}

/** 跑完在终端上打一份勾选表。 */
export function printSummary(result, file) {
  console.log("\n结果：");
  for (const check of result.checks) {
    const mark = { pass: "✓", fail: "✗", warn: "!", skip: "-", pending: "?" }[
      check.status
    ];
    console.log(`  ${mark} ${check.id.padEnd(22)} ${check.title}`);
  }
  console.log(`\n${result.status}；结果文件：${file}`);
  console.log(
    "把 result.json 整个贴回来即可（不含凭据、终端原始输出只有失败时的尾部）。",
  );
}
