/**
 * 受管安装包的识别（issue #288 §2）：这份安装不该由壳自己替换。
 *
 * - macOS 直接从挂载的 dmg 里运行（`/Volumes/…`），或被 Gatekeeper 随机化路径
 *   （`AppTranslocation`）：替换的是一个只读卷或临时副本，替换完什么也没更新。
 * - Linux 的 deb / rpm / pacman：electron-builder 在 `resources/package-type`
 *   里写明了包类型，包归包管理器管，绕过它替换会让系统有两份对不上的安装记录。
 * - Linux 没有 `APPIMAGE` 环境变量、也没有 `package-type`：不是 AppImage，
 *   不知道是谁放的，按便携副本处理。
 * - Windows 便携版：electron-builder 的 portable 目标设 `PORTABLE_EXECUTABLE_DIR`；
 *   我们发布的便携 zip 没有 NSIS 留下的卸载程序 `Uninstall Armadra.exe`。
 *
 * 这些安装报告 `unsupported{managedPackage}`，并给出对应的下载资产名，页面据此
 * 提供「下载新安装包」。
 */

import { posix, win32 } from "node:path";

import { releaseVerdict, type ReleaseQuery } from "./offer";

export type ManagedKind = "dmg" | "deb" | "rpm" | "pacman" | "portable";

/** 判断要用到的这台机器上的事实；测试注入，`main/updates/environment.ts` 读真的。 */
export interface InstallFacts {
  platform: string;
  execPath: string;
  resourcesPath: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  /** 读一个小文本文件；读不到是 `null`。 */
  read: (path: string) => string | null;
}

/** NSIS 安装器放在安装目录里的卸载程序（electron-builder 的默认名）。 */
export const NSIS_UNINSTALLER = "Uninstall Armadra.exe";

/** 这份安装归谁管；`null` 是壳自己能替换的安装。 */
export function detectManagedPackage(facts: InstallFacts): ManagedKind | null {
  if (facts.platform === "darwin") {
    if (facts.execPath.startsWith("/Volumes/")) return "dmg";
    if (facts.execPath.includes("/AppTranslocation/")) return "dmg";
    return null;
  }
  if (facts.platform === "win32") {
    if ((facts.env.PORTABLE_EXECUTABLE_DIR ?? "").length > 0) return "portable";
    const uninstaller = win32.join(
      win32.dirname(facts.execPath),
      NSIS_UNINSTALLER,
    );
    return facts.exists(uninstaller) ? null : "portable";
  }
  if (facts.platform === "linux") {
    if ((facts.env.APPIMAGE ?? "").length > 0) return null;
    const type = facts
      .read(posix.join(facts.resourcesPath, "package-type"))
      ?.trim();
    if (type === "deb" || type === "rpm" || type === "pacman") return type;
    return "portable";
  }
  return null;
}

/**
 * 这种安装该下载的发布资产名（与 `tools/release/artifacts.mjs::desktopAssets`
 * 一致）。Linux 上 pacman 与来历不明的副本给 AppImage——那是唯一能自更新的包。
 */
export function managedAssetName(
  kind: ManagedKind,
  version: string,
  target: string,
): string | null {
  const stem = `Armadra_${version}_${target}`;
  if (target.startsWith("darwin-")) {
    return kind === "dmg" ? `${stem}.dmg` : null;
  }
  if (target.startsWith("windows-")) {
    return kind === "portable" ? `${stem}-portable.zip` : null;
  }
  if (target.startsWith("linux-")) {
    if (kind === "deb") return `${stem}.deb`;
    if (kind === "rpm") return `${stem}.rpm`;
    if (kind === "pacman" || kind === "portable") return `${stem}.AppImage`;
  }
  return null;
}

/** 页面「下载新安装包」用的那一条。 */
export interface ManagedDownload {
  version: string;
  /** 资产的 `browser_download_url`，https。 */
  url: string;
  /** 发布页，https；没有则为空串。 */
  notesUrl: string;
}

/**
 * 从发布索引里取这种安装该下载的那份：按通道最新、且比正在运行的版本新的
 * 发布里、名字对得上的资产。没有更新的版本或发布里没有这个资产是 `null`。
 */
export function managedDownload(
  index: unknown,
  query: ReleaseQuery,
  kind: ManagedKind,
): ManagedDownload | null {
  const verdict = releaseVerdict(index, query);
  if (verdict.state !== "available") return null;
  const name = managedAssetName(kind, verdict.answer.version, query.target);
  if (name === null) return null;
  const artifact = verdict.answer.artifacts.find((each) => {
    try {
      const url = new URL(each.url);
      const last = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      return url.protocol === "https:" && decodeURIComponent(last) === name;
    } catch {
      return false;
    }
  });
  if (artifact === undefined) return null;
  return {
    version: verdict.answer.version,
    url: artifact.url,
    notesUrl: verdict.answer.notesUrl.startsWith("https://")
      ? verdict.answer.notesUrl
      : "",
  };
}
