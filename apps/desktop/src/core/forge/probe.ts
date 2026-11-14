/**
 * 平台探测：用户 remote 里出现、又不认识的主机，用 HTTPS 问三个公开端点认出平台
 * （契约 §111.3）。只探 remote 里的主机；按主机缓存；不带任何凭据。
 *
 *   `/api/v3/meta`     200 且是 JSON 对象        → GitHub 企业版
 *   `/api/v1/version`  200 且有 `version`        → Gitea / Forgejo
 *   `/api/v4/version`  200 有 `version`，或 401   → GitLab
 */

import type { ForgeKind } from "./types";

export const KNOWN_FORGE_HOSTS: Readonly<Record<string, ForgeKind>> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "gitea.com": "gitea",
  "codeberg.org": "gitea",
};

export interface Probed {
  readonly forge: ForgeKind;
  /** 这个主机上 API 的根。 */
  readonly apiBase: string;
}

const TIMEOUT_MS = 5_000;
const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 2 * 60_000;
const MAX_BODY = 64 << 10;
const CACHE_MAX = 256;

export interface PlatformProbeOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

interface Entry {
  readonly value: Probed | null;
  readonly expiresMs: number;
}

export function apiBaseFor(host: string, forge: ForgeKind): string {
  switch (forge) {
    case "github":
      return host === "github.com"
        ? "https://api.github.com"
        : `https://${host}/api/v3`;
    case "gitlab":
      return `https://${host}/api/v4`;
    default:
      return `https://${host}/api/v1`;
  }
}

export class PlatformProbe {
  private readonly doFetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Probed | null>>();

  constructor(options: PlatformProbeOptions = {}) {
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
  }

  /** 已知主机或缓存里有的结果，不联网；没探过是 `undefined`。 */
  peek(host: string): Probed | null | undefined {
    const known = KNOWN_FORGE_HOSTS[host];
    if (known !== undefined) {
      return { forge: known, apiBase: apiBaseFor(host, known) };
    }
    const entry = this.cache.get(host);
    if (entry === undefined || entry.expiresMs <= this.now()) return undefined;
    return entry.value;
  }

  /** 探一个主机（没探过或缓存过期才联网）。不会抛。 */
  async probe(host: string): Promise<Probed | null> {
    const cached = this.peek(host);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(host);
    if (pending !== undefined) return pending;
    const work = this.detect(host)
      .catch(() => null)
      .then((value) => {
        if (this.cache.size >= CACHE_MAX) this.cache.clear();
        this.cache.set(host, {
          value,
          expiresMs:
            this.now() + (value === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS),
        });
        this.inflight.delete(host);
        return value;
      });
    this.inflight.set(host, work);
    return work;
  }

  /** 缓存里的结果清掉（重试时用）。 */
  forget(host?: string): void {
    if (host === undefined) this.cache.clear();
    else this.cache.delete(host);
  }

  private async get(
    host: string,
    path: string,
  ): Promise<{ status: number; json: unknown }> {
    // 外呼登记见 `OUTBOUND.forgeProbe`：只发往用户 remote 里的主机，不带凭据，不跟重定向。
    const response = await this.doFetch(`https://${host}${path}`, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": "Armadra" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json: unknown = null;
    if (response.status === 200) {
      try {
        const text = (await response.text()).slice(0, MAX_BODY);
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    return { status: response.status, json };
  }

  private async detect(host: string): Promise<Probed | null> {
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const meta = await this.get(host, "/api/v3/meta").catch(() => undefined);
    if (meta?.status === 200 && object(meta.json)) {
      return { forge: "github", apiBase: apiBaseFor(host, "github") };
    }
    const gitea = await this.get(host, "/api/v1/version").catch(
      () => undefined,
    );
    if (
      gitea?.status === 200 &&
      object(gitea.json) &&
      typeof gitea.json.version === "string"
    ) {
      return { forge: "gitea", apiBase: apiBaseFor(host, "gitea") };
    }
    const gitlab = await this.get(host, "/api/v4/version").catch(
      () => undefined,
    );
    if (
      gitlab?.status === 401 ||
      (gitlab?.status === 200 &&
        object(gitlab.json) &&
        typeof gitlab.json.version === "string")
    ) {
      return { forge: "gitlab", apiBase: apiBaseFor(host, "gitlab") };
    }
    return null;
  }
}
