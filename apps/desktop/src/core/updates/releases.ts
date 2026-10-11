/**
 * GitHub 发布列表 → 契约 §64 的发布条目：解析、semver 排序、按通道过滤、算最新。
 *
 * 全是纯函数，不联网；取数与缓存在 `service.ts`。
 */

import type { Release, ReleaseAsset, UpdateChannel } from "@armadra/shared";

/** 一页最多几条：GitHub 的 `per_page`，也是答案的上限。 */
export const MAX_RELEASES = 30;

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** `-` 之后按 `.` 切开的标识；正式版是空数组。 */
  readonly prerelease: readonly string[];
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `v0.6.1`、`0.6.1-beta.2` → semver；不是 semver 的标签是 `null`。 */
export function parseVersion(tag: string): SemVer | null {
  const match = SEMVER.exec(tag.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

/** 去掉前导 `v` 与构建元数据的版本串。 */
export function formatVersion(version: SemVer): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length === 0
    ? core
    : `${core}-${version.prerelease.join(".")}`;
}

const NUMERIC = /^\d+$/;

function compareIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  // 数字标识低于字母数字标识（semver §11.4.3）。
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** semver 优先级：负数 a 低于 b，0 相等，正数 a 高于 b。 */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  // 有预发布标识的低于同号的正式版。
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const order = compareIdentifier(left, right);
    if (order !== 0) return order;
  }
  return 0;
}

/** 缓存里的一条：契约的发布条目，加上排序用的 semver。 */
export interface ParsedRelease {
  readonly semver: SemVer;
  readonly release: Release;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const DIGEST = /^sha256:([0-9a-fA-F]{64})$/;

/** GitHub 资产的 `digest`（`sha256:<hex>`）→ 小写十六进制；没有或不认识是 `null`。 */
export function digestSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DIGEST.exec(value.trim());
  return match === null ? null : (match[1] as string).toLowerCase();
}

function parseAsset(value: unknown): ReleaseAsset | null {
  const asset = record(value);
  if (asset === undefined) return null;
  const name = text(asset.name);
  const url = text(asset.browser_download_url);
  if (name === "" || url === "") return null;
  const size = asset.size;
  return {
    name,
    url,
    size:
      typeof size === "number" && Number.isSafeInteger(size) && size >= 0
        ? size
        : 0,
    sha256: digestSha256(asset.digest),
  };
}

/**
 * GitHub `GET /repos/{owner}/{repo}/releases` 的一项 → 发布条目。草稿、标签不是
 * semver 的跳过（`null`）。标签带 `-` 的一律算预发布，不论 GitHub 上勾没勾。
 */
export function parseRelease(value: unknown): ParsedRelease | null {
  const entry = record(value);
  if (entry === undefined || entry.draft === true) return null;
  const tag = text(entry.tag_name);
  const semver = parseVersion(tag);
  if (semver === null) return null;
  const assets = Array.isArray(entry.assets) ? entry.assets : [];
  return {
    semver,
    release: {
      version: formatVersion(semver),
      tag,
      publishedAt: text(entry.published_at) || text(entry.created_at),
      prerelease: entry.prerelease === true || semver.prerelease.length > 0,
      notes: text(entry.body),
      url: text(entry.html_url),
      assets: assets
        .map(parseAsset)
        .filter((asset): asset is ReleaseAsset => asset !== null),
    },
  };
}

/** 整页 → 发布条目，semver 降序；同一个版本只留第一条。 */
export function parseReleases(document: unknown): ParsedRelease[] {
  if (!Array.isArray(document)) {
    throw new TypeError("发布列表不是数组");
  }
  const seen = new Set<string>();
  const parsed: ParsedRelease[] = [];
  for (const value of document) {
    const release = parseRelease(value);
    if (release === null || seen.has(release.release.version)) continue;
    seen.add(release.release.version);
    parsed.push(release);
  }
  return parsed.sort((a, b) => compareVersions(b.semver, a.semver));
}

/** `stable` 跳过预发布，`beta` 全要。 */
export function filterChannel(
  releases: readonly ParsedRelease[],
  channel: UpdateChannel,
): ParsedRelease[] {
  return channel === "beta"
    ? [...releases]
    : releases.filter((entry) => !entry.release.prerelease);
}

/**
 * 过滤后的列表（已降序）里最高且高于 `current` 的版本。`current` 不是 semver
 * （开发构建报的不是版本号）时说不出谁更新，答 `null`。
 */
export function latestVersion(
  releases: readonly ParsedRelease[],
  current: string,
): string | null {
  const own = parseVersion(current);
  if (own === null) return null;
  const top = releases[0];
  return top !== undefined && compareVersions(top.semver, own) > 0
    ? top.release.version
    : null;
}
