/**
 * 复用本机登录（契约 §111.6）：读用户已有的 `gh` / `glab` / `tea` 登录，最后一档是
 * `git credential fill`。
 *
 * 规矩：
 *   * 按需读、短缓存（认到的 60 秒、没认到的 10 秒）、关掉开关即清，**绝不落库、
 *     不进日志与响应**。令牌只在这个对象的内存里，出去的只有 {@link LoginSource}
 *     与「有没有」。
 *   * 外部命令与文件读取全部可注入（{@link CommandRunner}、`readFile`），测试只
 *     用 mock，不起真的 gh / glab / git，也不读真 HOME。
 *   * `git credential fill` 只限 https 主机、不弹任何对话框（`GIT_TERMINAL_PROMPT=0`、
 *     `GCM_INTERACTIVE=never`），结果只用于同一个主机。
 *   * 一个主机的令牌只发给那个主机的 API：调用方按主机取，这里不做跨主机复用。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type CommandRunner, realRunner } from "./exec";
import type { ForgeKind } from "./types";

export type LoginSource = "ghCli" | "glab" | "tea" | "gitCredential";

export interface LoginToken {
  readonly token: string;
  readonly source: LoginSource;
}

const HOST =
  /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;
/** 令牌：一串可见 ASCII，不含空白。 */
const TOKEN = /^[\x21-\x7e]{1,512}$/;
const FOUND_TTL_MS = 60_000;
const MISSING_TTL_MS = 10_000;
const COMMAND_TIMEOUT_MS = 8_000;
const CREDENTIAL_TIMEOUT_MS = 5_000;
const CACHE_MAX = 128;
const MAX_FILE_BYTES = 256 << 10;

/** 读一个文本文件；不存在或读不了是 `undefined`。 */
export type FileReader = (path: string) => Promise<string | undefined>;

export const realFileReader: FileReader = async (path) => {
  try {
    const text = await readFile(path, "utf8");
    return text.length > MAX_FILE_BYTES ? undefined : text;
  } catch {
    return undefined;
  }
};

export interface LocalLoginsOptions {
  /** 现在开着没有；关着时一律不读、不返回缓存。 */
  readonly enabled: () => boolean;
  readonly run?: CommandRunner;
  readonly readFile?: FileReader;
  readonly home?: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
}

interface Entry {
  readonly value: LoginToken | null;
  readonly expiresMs: number;
}

/** 一个 tea 配置里的登录行（只取这里用得到的字段）。 */
interface TeaLogin {
  readonly url: string;
  readonly token: string;
}

/**
 * tea 的 `config.yml`：`logins:` 下是一串 `- name: … url: … token: …` 的映射。
 * 只读不写，只取 `url` 与 `token` 两个标量；不引 YAML 库。
 */
export function parseTeaLogins(text: string): TeaLogin[] {
  const logins: TeaLogin[] = [];
  let inLogins = false;
  let current: Record<string, string> | undefined;
  const flush = () => {
    if (current?.url !== undefined && current.token !== undefined) {
      logins.push({ url: current.url, token: current.token });
    }
    current = undefined;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\S/.test(line)) {
      flush();
      inLogins = /^logins:\s*$/.test(line);
      continue;
    }
    if (!inLogins) continue;
    let body = line.trim();
    if (body === "" || body.startsWith("#")) continue;
    if (body.startsWith("- ")) {
      flush();
      current = {};
      body = body.slice(2).trim();
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(body);
    if (match === null || current === undefined) continue;
    let value = (match[2] as string).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    current[match[1] as string] = value;
  }
  flush();
  return logins;
}

export class LocalLogins {
  private readonly run: CommandRunner;
  private readonly files: FileReader;
  private readonly now: () => number;
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<LoginToken | null>>();

  constructor(private readonly options: LocalLoginsOptions) {
    this.run = options.run ?? realRunner;
    this.files = options.readFile ?? realFileReader;
    this.now = options.now ?? (() => Date.now());
  }

  enabled(): boolean {
    return this.options.enabled();
  }

  /** 缓存里有的结果（不起命令）；开关关着、没读过或过期是 `undefined`。 */
  peek(host: string, forge: ForgeKind): LoginToken | null | undefined {
    if (!this.enabled()) return undefined;
    const entry = this.cache.get(`${forge}:${host}`);
    if (entry === undefined || entry.expiresMs <= this.now()) return undefined;
    return entry.value;
  }

  /** 这个主机的本机登录令牌；没有、关着或读不了是 `null`。不会抛。 */
  async resolve(host: string, forge: ForgeKind): Promise<LoginToken | null> {
    if (!this.enabled() || !HOST.test(host)) return null;
    const key = `${forge}:${host}`;
    const cached = this.peek(host, forge);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;
    const work = this.read(host, forge)
      .catch(() => null)
      .then((value) => {
        // 读的过程中开关被关了：不留这份令牌。
        if (!this.enabled()) return null;
        if (this.cache.size >= CACHE_MAX) this.cache.clear();
        this.cache.set(key, {
          value,
          expiresMs:
            this.now() + (value === null ? MISSING_TTL_MS : FOUND_TTL_MS),
        });
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, work);
    return work;
  }

  /** 丢掉缓存的令牌：关开关、令牌被远端拒、用户点「重试」时。 */
  forget(host?: string): void {
    if (host === undefined) {
      this.cache.clear();
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.endsWith(`:${host}`)) this.cache.delete(key);
    }
  }

  private async read(
    host: string,
    forge: ForgeKind,
  ): Promise<LoginToken | null> {
    const specific =
      forge === "github"
        ? await this.gh(host)
        : forge === "gitlab"
          ? await this.glab(host)
          : await this.tea(host);
    if (specific !== null) return specific;
    return await this.credential(host);
  }

  private async command(
    file: string,
    args: readonly string[],
  ): Promise<string | null> {
    const exe = this.options.platform === "win32" ? `${file}.exe` : file;
    const result = await this.run(exe, args, { timeoutMs: COMMAND_TIMEOUT_MS });
    if (!result.ok) return null;
    const token = result.stdout.trim();
    return TOKEN.test(token) ? token : null;
  }

  private async gh(host: string): Promise<LoginToken | null> {
    const token = await this.command("gh", [
      "auth",
      "token",
      "--hostname",
      host,
    ]);
    return token === null ? null : { token, source: "ghCli" };
  }

  private async glab(host: string): Promise<LoginToken | null> {
    const token = await this.command("glab", [
      "config",
      "get",
      "token",
      "--host",
      host,
    ]);
    return token === null ? null : { token, source: "glab" };
  }

  /** tea 配置的候选位置：`$XDG_CONFIG_HOME`、`~/.config`、macOS 的 Application Support。 */
  private teaConfigPaths(): string[] {
    const env = this.options.env ?? process.env;
    const home = (this.options.home ?? homedir)();
    const platform = this.options.platform ?? process.platform;
    const paths: string[] = [];
    const xdg = env.XDG_CONFIG_HOME;
    if (xdg !== undefined && xdg !== "")
      paths.push(join(xdg, "tea", "config.yml"));
    paths.push(join(home, ".config", "tea", "config.yml"));
    if (platform === "darwin") {
      paths.push(
        join(home, "Library", "Application Support", "tea", "config.yml"),
      );
    }
    if (platform === "win32" && env.APPDATA !== undefined) {
      paths.push(join(env.APPDATA, "tea", "config.yml"));
    }
    return paths;
  }

  private async tea(host: string): Promise<LoginToken | null> {
    for (const path of this.teaConfigPaths()) {
      const text = await this.files(path);
      if (text === undefined) continue;
      for (const login of parseTeaLogins(text)) {
        let loginHost: string;
        try {
          loginHost = new URL(login.url).hostname.toLowerCase();
        } catch {
          continue;
        }
        if (loginHost === host && TOKEN.test(login.token)) {
          return { token: login.token, source: "tea" };
        }
      }
    }
    return null;
  }

  /** 最后一档：只限 https，不弹框；令牌只用于同一个主机。 */
  private async credential(host: string): Promise<LoginToken | null> {
    const result = await this.run("git", ["credential", "fill"], {
      timeoutMs: CREDENTIAL_TIMEOUT_MS,
      env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      input: `protocol=https\nhost=${host}\n\n`,
    });
    if (!result.ok) return null;
    let password = "";
    let answered = "";
    for (const line of result.stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1).replace(/\r$/, "");
      if (key === "password") password = value;
      if (key === "host") answered = value.toLowerCase();
    }
    // 答的主机必须就是问的那个：不把别处的凭据拿来用。
    if (answered !== "" && answered !== host) return null;
    return TOKEN.test(password)
      ? { token: password, source: "gitCredential" }
      : null;
  }
}
