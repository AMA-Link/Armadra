/**
 * 未做平台代码签名时的两条安装路径（issue #288 §2），纯数据部分。
 *
 * - macOS：已验过 sha256 与 minisign 的 zip 解压到临时目录、核对版本；停 core；
 *   分离启动下面这段 shell 脚本，然后退出。脚本等本进程退出后把旧 `.app` 挪到
 *   旁边、`ditto` 新的进去、去掉 `com.apple.quarantine`、重新打开；复制失败就把
 *   旧的挪回来再打开，绝不留下一个没有应用的目录。
 * - Windows（NSIS）：停 core；分离启动已验过的 `setup.exe --updated /S --force-run`
 *   然后退出。`/S` 静默安装到上次的安装目录，`--force-run` 让安装器装完后重新
 *   打开应用（electron-builder 模板 `installSection.nsh` 的 `isForceRun`），
 *   `--updated` 是 electron-updater 自己传的那个标志，告诉安装器这是一次更新。
 *
 * 路径全部经命令行参数传给脚本，脚本正文是固定文本：没有任何路径被拼进脚本，
 * 也就没有引号转义可出错。
 */

import { posix } from "node:path";

/** 辅助脚本正文。参数：`<pid> <已安装的 .app> <新 .app> <工作目录> [打开命令]`。 */
export const MAC_HELPER_SCRIPT = `#!/bin/sh
# Armadra update helper: wait for the app to exit, replace the bundle, relaunch.
# Arguments: <pid> <installed .app> <verified new .app> <work dir> [opener]
set -u
pid="$1"
target="$2"
source="$3"
work="$4"
opener="\${5:-/usr/bin/open}"
log="$work/helper.log"
say() { printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$log"; }

waited=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$waited" -ge 1200 ]; then
    say "the app ($pid) did not exit; nothing was replaced"
    exit 1
  fi
  waited=$((waited + 1))
  sleep 0.1
done

previous="$(dirname "$target")/.$(basename "$target").previous"
rm -rf "$previous"
if ! mv "$target" "$previous"; then
  say "could not move $target aside; nothing was replaced"
  "$opener" "$target"
  exit 1
fi
if /usr/bin/ditto "$source" "$target"; then
  /usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
  rm -rf "$previous"
  say "replaced $target"
  "$opener" "$target"
  rm -rf "$work"
  exit 0
fi
say "copying the new app failed; restoring the previous one"
rm -rf "$target"
mv "$previous" "$target"
"$opener" "$target"
exit 1
`;

/** 脚本在工作目录里的文件名。 */
export const MAC_HELPER_NAME = "update-helper.sh";

/** `/bin/sh <脚本> …` 的参数表。 */
export function macHelperArgs(input: {
  script: string;
  pid: number;
  installed: string;
  replacement: string;
  workDir: string;
  opener?: string;
}): string[] {
  return [
    input.script,
    String(input.pid),
    input.installed,
    input.replacement,
    input.workDir,
    ...(input.opener === undefined ? [] : [input.opener]),
  ];
}

/** 静默更新安装、装完重新打开。 */
export const WINDOWS_INSTALLER_ARGS: readonly string[] = [
  "--updated",
  "/S",
  "--force-run",
];

/**
 * 正在运行的 `.app`：`…/Armadra.app/Contents/MacOS/armadra` → `…/Armadra.app`。
 * 不是这个形状就是 `null`——替换一个猜出来的目录比不更新糟得多。
 */
export function appBundleOf(execPath: string): string | null {
  const macos = posix.dirname(execPath);
  const contents = posix.dirname(macos);
  const bundle = posix.dirname(contents);
  if (posix.basename(macos) !== "MacOS") return null;
  if (posix.basename(contents) !== "Contents") return null;
  if (!bundle.endsWith(".app")) return null;
  return bundle;
}

/** 资产名：URL 最后一段解码后的样子；minisign 的 trusted comment 点名的就是它。 */
export function assetNameOf(packageUrl: string): string {
  try {
    const path = new URL(packageUrl).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  } catch {
    return "";
  }
}

/**
 * 下载到本地时用的文件名：资产名只留安全字符。空了就是 `update.bin`。
 */
export function stagedFileName(packageUrl: string): string {
  const safe = assetNameOf(packageUrl)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "");
  return safe.length > 0 ? safe : "update.bin";
}
