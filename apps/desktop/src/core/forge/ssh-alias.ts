/**
 * SSH 别名：`git@github-work:org/repo` 里的 `github-work` 是 `~/.ssh/config` 里的
 * `Host`，真实主机在它的 `HostName`。先问 `ssh -G <别名>`，再把地址里的主机换成
 * 真实主机交给识别；问不到（没有 ssh、超时、没配）就用原值。
 */

import type { CommandRunner } from "./exec";
import { realRunner } from "./exec";

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 256;

/** 这几个主机直接认，不必问 ssh。 */
const KNOWN_HOSTS = new Set([
  "github.com",
  "ssh.github.com",
  "gitlab.com",
  "gitea.com",
  "codeberg.org",
]);

/** 地址是 ssh 写法时，别名（主机）在哪：scp `[user@]host:path` 或 `ssh://[user@]host[:port]/path`。 */
function sshHost(url: string): string | undefined {
  const raw = url.trim();
  if (raw.includes("://")) {
    if (!/^ssh:\/\//i.test(raw)) return undefined;
    try {
      return new URL(raw).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  const at = raw.lastIndexOf("@");
  const rest = at >= 0 ? raw.slice(at + 1) : raw;
  const colon = rest.indexOf(":");
  if (colon <= 0) return undefined;
  // 盘符（`C:\repo`）与本地路径不是 scp 写法。
  const host = rest.slice(0, colon);
  return host.length === 1 ? undefined : host;
}

function replaceHost(url: string, from: string, to: string): string {
  const raw = url.trim();
  if (raw.includes("://")) {
    try {
      const parsed = new URL(raw);
      parsed.hostname = to;
      return parsed.toString();
    } catch {
      return url;
    }
  }
  const at = raw.lastIndexOf("@");
  const prefix = at >= 0 ? raw.slice(0, at + 1) : "";
  const rest = at >= 0 ? raw.slice(at + 1) : raw;
  return `${prefix}${to}${rest.slice(from.length)}`;
}

export interface SshAliasOptions {
  readonly run?: CommandRunner;
  readonly now?: () => number;
}

export class SshAliasResolver {
  private readonly run: CommandRunner;
  private readonly now: () => number;
  private readonly cache = new Map<string, { host: string; atMs: number }>();

  constructor(options: SshAliasOptions = {}) {
    this.run = options.run ?? realRunner;
    this.now = options.now ?? (() => Date.now());
  }

  /** 别名背后的真实主机；不是 ssh 写法或问不到时 `undefined`。 */
  private async hostName(alias: string): Promise<string | undefined> {
    const key = alias.toLowerCase();
    const hit = this.cache.get(key);
    if (hit !== undefined && this.now() - hit.atMs < CACHE_TTL_MS) {
      return hit.host === "" ? undefined : hit.host;
    }
    let host = "";
    try {
      const result = await this.run("ssh", ["-G", alias], {
        timeoutMs: TIMEOUT_MS,
      });
      if (result.ok) {
        for (const line of result.stdout.split("\n")) {
          const match = /^hostname\s+(\S+)\s*$/i.exec(line.trim());
          if (match !== null) {
            host = (match[1] as string).toLowerCase().replace(/\.$/, "");
            break;
          }
        }
      }
    } catch {
      host = "";
    }
    if (host === "" || host === key || !ALIAS.test(host)) host = "";
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(key, { host, atMs: this.now() });
    return host === "" ? undefined : host;
  }

  /**
   * 远端地址里是别名就换成真实主机；其余原样。不会抛。
   */
  async resolve(url: string): Promise<string> {
    const alias = sshHost(url);
    if (alias === undefined || !ALIAS.test(alias)) return url;
    if (KNOWN_HOSTS.has(alias.toLowerCase())) return url;
    const real = await this.hostName(alias);
    return real === undefined ? url : replaceHost(url, alias, real);
  }
}
