// 本机探测：PowerShell、进程树、会话宿主管道、已登记的安装、Authenticode、空闲宿主。
// 从 windows-acceptance.mjs 拆出（#573 第 4 项）；主文件重新导出 machineInfo，导入方不用改。
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { IDLE_HOST_ENV, readText } from "./windows-acceptance-lib.mjs";

/* ------------------------------ machine probes ----------------------------- */

export const isWindows = process.platform === "win32";

/**
 * Windows PowerShell 5.1：从 pwsh 7 里起它要去掉 PSModulePath（G3-3 的结论）。
 * 只有终止错误算失败：一条非终止错误（某个注册表路径不在）也会让 `-Command`
 * 的退出码变 1，而 stderr 是空的。
 */
export function powershell(command, { timeout = 60_000 } = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.toUpperCase() === "PSMODULEPATH") delete env[name];
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(
        `$ProgressPreference='SilentlyContinue'; try { ${command} } catch { [Console]::Error.WriteLine($_); exit 1 }; exit 0`,
        "utf16le",
      ).toString("base64"),
    ],
    { env, encoding: "utf8", timeout, windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `powershell 失败（${result.status}）：${result.stderr.trim().slice(0, 500)}`,
    );
  return result.stdout.trim();
}

export function powershellJson(command, options) {
  const text = powershell(
    `${command} | ConvertTo-Json -Depth 4 -Compress`,
    options,
  );
  if (text === "") return [];
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

export function where(program) {
  if (!isWindows) {
    const found = spawnSync("which", [program], { encoding: "utf8" });
    return found.status === 0 ? found.stdout.trim().split("\n")[0] : null;
  }
  const found = spawnSync("where.exe", [program], {
    encoding: "utf8",
    windowsHide: true,
  });
  return found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : null;
}

export function powershellVersion(program) {
  if (program === null) return null;
  const probe = spawnSync(
    program,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name.toUpperCase() !== "PSMODULEPATH",
        ),
      ),
    },
  );
  return probe.status === 0 ? probe.stdout.trim() : null;
}

export function findCsc() {
  if (!isWindows) return null;
  const windir = process.env.WINDIR ?? "C:\\Windows";
  for (const framework of ["Framework64", "Framework"]) {
    const candidate = join(
      windir,
      "Microsoft.NET",
      framework,
      "v4.0.30319",
      "csc.exe",
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function machineInfo() {
  const pwsh = where("pwsh");
  const legacy = isWindows ? where("powershell") : null;
  return {
    platform: process.platform,
    release: os.release(),
    version: typeof os.version === "function" ? os.version() : null,
    arch: process.arch,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? null,
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    shells: {
      cmd: isWindows ? (process.env.ComSpec ?? where("cmd")) : null,
      pwsh,
      pwshVersion: powershellVersion(pwsh),
      powershell: legacy,
      powershellVersion: powershellVersion(legacy),
    },
    csc: findCsc(),
    clis: Object.fromEntries(
      ["claude", "codex", "copilot", "opencode", "pi", "omp", "ama", "git"].map(
        (name) => [name, where(name)],
      ),
    ),
  };
}

/** 注册表里登记的 Armadra 安装（HKCU 与 HKLM 的卸载项）。 */
export function registeredInstalls() {
  return powershellJson(
    "$paths = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; " +
      "Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Armadra*' } | Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString,PSPath",
  );
}

export function authenticode(path) {
  const [row] = powershellJson(
    `Get-AuthenticodeSignature -LiteralPath '${path.replaceAll("'", "''")}' | Select-Object @{n='status';e={$_.Status.ToString()}},@{n='subject';e={$_.SignerCertificate.Subject}},@{n='message';e={$_.StatusMessage}}`,
  );
  return row ?? { status: "Unknown" };
}

/** Armadra.exe 的每个进程：pid、父 pid、命令行、工作集（MB）、句柄数。 */
export function appProcesses(exe) {
  const escaped = exe.replaceAll("\\", "\\\\").replaceAll("'", "''");
  return powershellJson(
    `Get-CimInstance Win32_Process -Filter "ExecutablePath='${escaped}'" | Select-Object ProcessId,ParentProcessId,CommandLine,WorkingSetSize,HandleCount`,
  ).map((row) => ({
    pid: row.ProcessId,
    parent: row.ParentProcessId,
    commandLine: row.CommandLine ?? "",
    rssMb: Math.round((Number(row.WorkingSetSize) / 1024 ** 2) * 10) / 10,
    handles: row.HandleCount,
  }));
}

export function processesById(pids) {
  if (pids.length === 0) return [];
  return powershellJson(
    `Get-CimInstance Win32_Process -Filter "${pids.map((pid) => `ProcessId=${Number(pid)}`).join(" OR ")}" | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,HandleCount`,
  ).map((row) => ({
    pid: row.ProcessId,
    parent: row.ParentProcessId,
    name: row.Name,
    rssMb: Math.round((Number(row.WorkingSetSize) / 1024 ** 2) * 10) / 10,
    handles: row.HandleCount,
  }));
}

export function childrenOf(pid) {
  return powershellJson(
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | Select-Object ProcessId,Name`,
  ).map((row) => ({ pid: row.ProcessId, name: row.Name }));
}

/** 会话宿主名下的控制台宿主进程（每个 ConPTY 一个，外加它自己的）。 */
export function consolesOf(pid) {
  return childrenOf(pid).filter((row) =>
    /^(conhost|OpenConsole)\.exe$/i.test(row.name),
  );
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sessionPipes() {
  try {
    return readdirSync("\\\\.\\pipe\\").filter((name) =>
      name.startsWith("armadra-session-"),
    );
  } catch {
    return [];
  }
}

/** 起一个空闲的会话宿主，跟 core 起它的方式一样，日志写进文件（lib 的 IDLE_HOST_ENV）。 */
export function startIdleHost(exe, dataDir, logFile) {
  const bundle = join(
    dirname(exe ?? "."),
    "resources",
    "session-host",
    "host.cjs",
  );
  const log = () => readText(logFile);
  if (!isWindows || !exe || !dataDir || !existsSync(bundle))
    return { started: false, pid: undefined, log };
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(exe, [bundle, dataDir], {
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: { ...process.env, ...IDLE_HOST_ENV },
    });
    child.unref();
    return { started: true, pid: child.pid, log };
  } finally {
    closeSync(fd);
  }
}
