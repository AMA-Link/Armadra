/**
 * 发布历史（契约 §64）在页面这边的纯函数：版本比较、各平台该下哪个资产、
 * 服务器的升级命令。只读 `updates.releases` 的答案，不访问 GitHub。
 *
 * 只升不降（issue #288）：这里只挑比当前更新的版本作为「可以装」的对象，历史
 * 里更旧的发布只给说明与下载链接。
 */
import type { Release, ReleaseAsset } from "@armadra/shared";

const SEMVER =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Parsed {
  core: [number, number, number];
  pre: string[];
}

function parse(version: string): Parsed | null {
  const match = SEMVER.exec(version.trim());
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split("."),
  };
}

function compareIdentifier(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * semver 优先级：负数 a 低于 b。预发布低于同号正式版。不是 semver 的版本串
 * 排在最低（不会被当成「更新」）。
 */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) {
    return left === right ? 0 : left === null ? -1 : 1;
  }
  for (let index = 0; index < 3; index += 1) {
    const diff = left.core[index]! - right.core[index]!;
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  for (let index = 0; ; index += 1) {
    const l = left.pre[index];
    const r = right.pre[index];
    if (l === undefined && r === undefined) return 0;
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const order = compareIdentifier(l, r);
    if (order !== 0) return order;
  }
}

/** `candidate` 比 `current` 新；`current` 不是 semver 时一律不算。 */
export function isNewer(candidate: string, current: string): boolean {
  return parse(current) !== null && compareVersions(candidate, current) > 0;
}

/** 发布里描述发布本身、不是安装包的文件：清单、签名、摘要。 */
const METADATA = /(\.sig|\.yml|\.blockmap|\.sha256|\.json)$|^SHA256SUMS$/;

/** 可下载的安装包（去掉清单、签名与摘要文件）。 */
export function packageAssets(release: Release): ReleaseAsset[] {
  return release.assets.filter(
    (asset) => !METADATA.test(asset.name) && isHttps(asset.url),
  );
}

export function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** 桌面壳报告的受管安装方式（`unsupported{managedPackage}`）。 */
export type ManagedPackage = "dmg" | "deb" | "rpm" | "pacman" | "portable";

/**
 * 受管安装该下载的资产名，与桌面壳 `managedAssetName`、发布脚本
 * `tools/release/artifacts.mjs::desktopAssets` 同一套命名。
 */
export function managedAssetName(
  kind: ManagedPackage,
  version: string,
  target: string,
): string | null {
  const stem = `Armadra_${version}_${target}`;
  if (target.startsWith("darwin-"))
    return kind === "dmg" ? `${stem}.dmg` : null;
  if (target.startsWith("windows-")) {
    return kind === "portable" ? `${stem}-portable.zip` : null;
  }
  if (target.startsWith("linux-")) {
    if (kind === "deb") return `${stem}.deb`;
    if (kind === "rpm") return `${stem}.rpm`;
    return `${stem}.AppImage`;
  }
  return null;
}

/** 「下载新安装包」指向的那一份。 */
export interface InstallerDownload {
  version: string;
  url: string;
  notesUrl: string;
}

/**
 * 壳没给出下载（还没检查过、或它问不到）时，从 §64 的最新发布里按平台挑。
 * 没有更新的版本、或发布里没有这种安装的资产是 `null`。
 */
export function managedFallback(
  releases: readonly Release[],
  latest: string | null,
  kind: ManagedPackage,
  target: string | null,
): InstallerDownload | null {
  if (latest === null || target === null) return null;
  const release = releases.find((entry) => entry.version === latest);
  if (release === undefined) return null;
  const name = managedAssetName(kind, release.version, target);
  const asset = release.assets.find(
    (entry) => entry.name === name && isHttps(entry.url),
  );
  if (asset === undefined) return null;
  return {
    version: release.version,
    url: asset.url,
    notesUrl: isHttps(release.url) ? release.url : "",
  };
}

/** 发布脚本给签名 APK 起的名字（`tools/release/artifacts.mjs::androidReleaseAsset`）。 */
export function androidApkName(version: string): string {
  return `armadra-mobile_${version}_android.apk`;
}

export interface AndroidUpdate {
  release: Release;
  url: string;
  sha256: string;
}

/**
 * 比 App 新、且带签名 APK 与 sha256 的最高版本。没有 sha256 的不给装：原生侧
 * 要拿它核对下载到的字节。
 */
export function androidUpdate(
  releases: readonly Release[],
  appVersion: string,
): AndroidUpdate | null {
  const candidates = releases
    .filter((release) => isNewer(release.version, appVersion))
    .sort((a, b) => compareVersions(b.version, a.version));
  for (const release of candidates) {
    const asset = release.assets.find(
      (entry) => entry.name === androidApkName(release.version),
    );
    if (asset && asset.sha256 && isHttps(asset.url)) {
      return { release, url: asset.url, sha256: asset.sha256 };
    }
  }
  return null;
}

/** 列表里比 `current` 新的最高版本；没有是 `null`。 */
export function latestAbove(
  releases: readonly Release[],
  current: string,
): string | null {
  let best: string | null = null;
  for (const release of releases) {
    if (!isNewer(release.version, current)) continue;
    if (best === null || compareVersions(release.version, best) > 0) {
      best = release.version;
    }
  }
  return best;
}

/** 服务器壳的镜像（`docs/guides/server-deployment.md`）。 */
export const SERVER_IMAGE = "ghcr.io/ama-link/armadra-server";

/**
 * 服务器升级到 `version` 的两条命令：容器拉新镜像；裸机用
 * `upgrade --binary … --expect-version … --confirm`（`apps/server/src/service/upgrade.ts`），
 * 候选文件的路径沿用部署指南里的示例位置。
 */
export function serverUpgradeCommands(version: string): {
  docker: string;
  binary: string;
} {
  return {
    docker: `docker pull ${SERVER_IMAGE}:${version}`,
    binary: `node apps/server/out/main.js upgrade --binary /opt/armadra/next/main.js --expect-version ${version} --confirm`,
  };
}
