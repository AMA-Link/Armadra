/**
 * 发布历史的取数与缓存（契约 §64）。
 *
 *   * 6 小时内复用缓存；过期后带 `If-None-Match` 条件请求，304 只刷新时刻。
 *   * `refresh` 绕过缓存，但任何两次真的联网之间至少隔一分钟（失败后同样）。
 *   * 被 GitHub 限流时，在它说的时刻之前不再问。
 *   * 失败不抛：答上次缓存的那份，带 `error`。
 *   * 同一时刻只有一趟请求在路上，并发的读等同一趟。
 *
 * 只在有人读的时候联网（没有后台轮询）；缓存只在内存里，core 重启后第一次读
 * 再问一次。
 */

import type {
  UpdateChannel,
  UpdateCheckError,
  UpdateReleases,
} from "@armadra/shared";

import { OUTBOUND } from "../net/outbound";
import type { CoreLog } from "../platform";
import {
  MAX_RELEASES,
  type ParsedRelease,
  filterChannel,
  latestVersion,
  parseReleases,
} from "./releases";

/** 发布从哪个仓库来（`owner/name`）。 */
export const RELEASES_REPO = "AMA-Link/Armadra";
/** 缓存多久之内不再问。 */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** 两次真的联网之间至少隔多久：强制刷新的节流，也是失败后的退避。 */
export const MIN_FETCH_INTERVAL_MS = 60 * 1000;
/** 一趟请求的上限。 */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * 发布列表的地址。缺省就是登记的 `OUTBOUND.githubReleases`；给了仓库或 API 根
 * （测试、探针）时按 GitHub 的路径拼。
 */
export function releasesUrl(repo?: string, apiBase?: string): string {
  const base =
    repo === undefined && apiBase === undefined
      ? OUTBOUND.githubReleases.url
      : `${apiBase ?? OUTBOUND.githubApi.url}/repos/${repo ?? RELEASES_REPO}/releases`;
  return `${base}?per_page=${MAX_RELEASES}`;
}

export interface ReleaseServiceOptions {
  /** 这台 core 自己的版本。 */
  readonly current: string;
  /** 现在的 `updates.channel`；每次读时问。 */
  readonly channel: () => UpdateChannel;
  /** 注入点：测试给一个假的，生产用 `globalThis.fetch`。 */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** `owner/name`；缺省 {@link RELEASES_REPO}。 */
  readonly repo?: string;
  /** API 根；缺省 GitHub。 */
  readonly apiBase?: string;
  readonly timeoutMs?: number;
  readonly log?: Pick<CoreLog, "warn">;
}

interface Cache {
  readonly releases: readonly ParsedRelease[];
  readonly etag: string | undefined;
  checkedAt: number;
}

type Failure =
  | { readonly code: "unreachable"; readonly message: string }
  | { readonly code: "rateLimited"; readonly message: string };

/** 限流时 GitHub 说的「多久之后再来」；说不出来按一分钟。 */
function retryAfter(response: Response, now: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(reset * 1000 - now, MIN_FETCH_INTERVAL_MS);
  }
  return MIN_FETCH_INTERVAL_MS;
}

function limited(response: Response): boolean {
  if (response.status === 429) return true;
  return (
    response.status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after"))
  );
}

export class ReleaseService {
  private readonly options: ReleaseServiceOptions;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private cache: Cache | undefined;
  private failure: Failure | undefined;
  private lastAttemptAt: number | undefined;
  private blockedUntil = 0;
  private inflight: Promise<void> | undefined;

  constructor(options: ReleaseServiceOptions) {
    this.options = options;
    this.fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? Date.now;
  }

  /** §64 的答案；`refresh` 绕过 6 小时缓存（仍受一分钟节流）。 */
  async releases(refresh = false): Promise<UpdateReleases> {
    if (this.inflight === undefined && this.due(refresh)) {
      this.inflight = this.fetchOnce().finally(() => {
        this.inflight = undefined;
      });
    }
    if (this.inflight !== undefined) await this.inflight;
    return this.document();
  }

  /** 这一次读要不要真的联网。 */
  private due(refresh: boolean): boolean {
    const now = this.now();
    if (now < this.blockedUntil) return false;
    if (
      this.lastAttemptAt !== undefined &&
      now - this.lastAttemptAt < MIN_FETCH_INTERVAL_MS
    ) {
      return false;
    }
    if (refresh || this.cache === undefined) return true;
    return now - this.cache.checkedAt >= CACHE_TTL_MS;
  }

  private async fetchOnce(): Promise<void> {
    const started = this.now();
    this.lastAttemptAt = started;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": `Armadra/${this.options.current}`,
    };
    const etag = this.cache?.etag;
    if (etag !== undefined) headers["if-none-match"] = etag;
    try {
      const response = await this.fetcher(
        releasesUrl(this.options.repo, this.options.apiBase),
        {
          headers,
          signal: AbortSignal.timeout(
            this.options.timeoutMs ?? FETCH_TIMEOUT_MS,
          ),
        },
      );
      if (response.status === 304 && this.cache !== undefined) {
        this.cache.checkedAt = this.now();
        this.failure = undefined;
        return;
      }
      if (limited(response)) {
        this.blockedUntil = started + retryAfter(response, started);
        this.fail({
          code: "rateLimited",
          message: `GitHub 限流（${response.status}）`,
        });
        return;
      }
      if (!response.ok) {
        this.fail({
          code: "unreachable",
          message: `GitHub 答 ${response.status}`,
        });
        return;
      }
      const releases = parseReleases(await response.json());
      this.cache = {
        releases,
        etag: response.headers.get("etag") ?? undefined,
        checkedAt: this.now(),
      };
      this.failure = undefined;
    } catch (error) {
      this.fail({
        code: "unreachable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private fail(failure: Failure): void {
    this.failure = failure;
    this.options.log?.warn("updates: release check failed", {
      code: failure.code,
      message: failure.message,
    });
  }

  private error(): UpdateCheckError | null {
    if (this.failure === undefined) return null;
    const now = this.now();
    const next = Math.max(
      this.blockedUntil,
      (this.lastAttemptAt ?? now) + MIN_FETCH_INTERVAL_MS,
    );
    return {
      code: this.failure.code,
      message: this.failure.message,
      retryAfterMs: Math.max(0, Math.round(next - now)),
    };
  }

  private document(): UpdateReleases {
    const channel = this.options.channel();
    const visible = filterChannel(this.cache?.releases ?? [], channel).slice(
      0,
      MAX_RELEASES,
    );
    return {
      current: this.options.current,
      channel,
      checkedAt: this.cache?.checkedAt ?? null,
      latest: latestVersion(visible, this.options.current),
      releases: visible.map((entry) => entry.release),
      error: this.error(),
    };
  }
}
