import { execFile, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  MAC_HELPER_NAME,
  MAC_HELPER_SCRIPT,
  WINDOWS_INSTALLER_ARGS,
  macHelperArgs,
} from "../../shell-core/updates/install-plan";
import {
  normalizeVersion,
  type Resolved,
} from "../../shell-core/updates/offer";

/**
 * 未签名包的两条安装路径落到操作系统上的那几步（issue #288 §2）。规则与脚本
 * 正文在 `shell-core/updates/install-plan.ts`；这里只有进程与文件系统。
 *
 * 每一步都有能注入的替身（`Installers`），`updater.ts` 只经它们动手，测试不用
 * 真的解压、真的拉起安装器、真的退出。
 */

const run = promisify(execFile);

/** 一条命令，等它结束；失败抛错。 */
export type Exec = (command: string, args: readonly string[]) => Promise<void>;
/** 一条命令，取它的标准输出；失败抛错。 */
export type Capture = (
  command: string,
  args: readonly string[],
) => Promise<string>;
/** 分离启动一个进程，不等它，也不让它拖住本进程退出。 */
export type SpawnDetached = (command: string, args: readonly string[]) => void;

const exec: Exec = async (command, args) => {
  await run(command, [...args], { timeout: 300_000 });
};

const capture: Capture = async (command, args) =>
  (await run(command, [...args], { timeout: 30_000, encoding: "utf8" })).stdout;

export const spawnDetached: SpawnDetached = (command, args) => {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
};

/**
 * 把校验过的 zip 解到 `workDir/new/`，确认里面恰好一个 `.app`、它的
 * `CFBundleShortVersionString` 就是发布的版本，返回它的路径。
 *
 * `ditto -x -k` 是 macOS 自己解 zip 的方式，保留权限、符号链接与扩展属性；
 * 版本用 `plutil` 读，不解析 plist。
 */
export async function stageMacBundle(
  zip: string,
  version: string,
  workDir: string,
  tools: { exec?: Exec; capture?: Capture } = {},
): Promise<Resolved<string>> {
  const target = join(workDir, "new");
  try {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    await (tools.exec ?? exec)("/usr/bin/ditto", ["-x", "-k", zip, target]);
  } catch {
    return { ok: false, reason: "installFailed" };
  }
  const apps = readdirSync(target).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) return { ok: false, reason: "sourceMalformed" };
  const bundle = join(target, apps[0]!);
  let found: string;
  try {
    found = (
      await (tools.capture ?? capture)("/usr/bin/plutil", [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        join(bundle, "Contents", "Info.plist"),
      ])
    ).trim();
  } catch {
    return { ok: false, reason: "sourceMalformed" };
  }
  if (normalizeVersion(found) !== normalizeVersion(version)) {
    return { ok: false, reason: "sourceMalformed" };
  }
  return { ok: true, value: bundle };
}

/**
 * 这个 `.app` 能不能由当前用户替换：它所在的目录可写（挪开、放进新的），
 * 它自己也可写（挪动一个目录要改它的 `..`）。标准用户装在 `/Applications`
 * 里、却没有写权限的情况在这里就拒绝，不先停 core。
 */
export function replaceable(appBundle: string): boolean {
  try {
    accessSync(join(appBundle, ".."), constants.W_OK);
    accessSync(appBundle, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 写出辅助脚本并分离启动它；它等 `pid` 退出后才动手。 */
export function launchMacHelper(
  input: {
    pid: number;
    installed: string;
    replacement: string;
    workDir: string;
    opener?: string;
  },
  spawnIt: SpawnDetached = spawnDetached,
): Resolved<void> {
  const script = join(input.workDir, MAC_HELPER_NAME);
  try {
    writeFileSync(script, MAC_HELPER_SCRIPT, { mode: 0o700 });
    spawnIt("/bin/sh", macHelperArgs({ ...input, script }));
  } catch {
    return { ok: false, reason: "installFailed" };
  }
  return { ok: true, value: undefined };
}

/** 分离启动校验过的 NSIS 安装器，静默安装、装完重新打开应用。 */
export function launchWindowsInstaller(
  installer: string,
  spawnIt: SpawnDetached = spawnDetached,
): Resolved<void> {
  if (!existsSync(installer)) return { ok: false, reason: "installFailed" };
  try {
    spawnIt(installer, WINDOWS_INSTALLER_ARGS);
  } catch {
    return { ok: false, reason: "installFailed" };
  }
  return { ok: true, value: undefined };
}

/** `updater.ts` 经它们动手的那几步；测试注入替身。 */
export interface Installers {
  stageMacBundle: (
    zip: string,
    version: string,
    workDir: string,
  ) => Promise<Resolved<string>>;
  replaceable: (appBundle: string) => boolean;
  launchMacHelper: (input: {
    pid: number;
    installed: string;
    replacement: string;
    workDir: string;
  }) => Resolved<void>;
  launchWindowsInstaller: (installer: string) => Resolved<void>;
  /** 退出本进程（`app.quit()`）；辅助脚本 / 安装器在它退出后接手。 */
  quit: () => void;
}

export function defaultInstallers(quit: () => void): Installers {
  return {
    stageMacBundle: (zip, version, workDir) =>
      stageMacBundle(zip, version, workDir),
    replaceable,
    launchMacHelper: (input) => launchMacHelper(input),
    launchWindowsInstaller: (installer) => launchWindowsInstaller(installer),
    quit,
  };
}
