/**
 * macOS 登录钥匙串，经 `security(1)`。
 *
 * 桌面壳在 macOS 上维持这一条而不换成 `safeStorage`：已有的条目就在钥匙串里，
 * 换后端意味着同一个令牌有两套存放（[外部服务 §12.1](../../../../../docs/design/external-services.md)）。
 *
 * 工具经一个可注入的 {@link SecurityTool} 调用，测试永远不碰开发者真正的钥匙串。
 *
 * 条目按名字寻址、整个账户只有一份，所以只有默认数据目录的 core 用它（契约
 * §102.1，挑后端在 {@link ./index}）；用之前先不出声地确认有默认钥匙串，没有就
 * 不可用，从不让 `security` 弹窗。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import {
  type SecretBackend,
  SecretUnavailable,
  checkSecretName,
} from "./backend";

export interface SecurityResult {
  /** 退出码；`0` 成功，`44` 是「没有这个条目」。 */
  readonly code: number;
  readonly stdout: string;
}

/** 跑一次 `security`。`stdin` 给交互提示用，值从不出现在命令行上。 */
export type SecurityTool = (
  args: readonly string[],
  stdin?: string,
) => Promise<SecurityResult>;

/** `security` 对「没有这个条目」的退出码。 */
export const ITEM_NOT_FOUND = 44;

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export const realSecurityTool: SecurityTool = (args, stdin) =>
  new Promise((resolve) => {
    const child = execFile(
      "security",
      [...args],
      {
        timeout: 10_000,
        encoding: "utf8",
        maxBuffer: 1 << 20,
        env: minimalEnv(),
      },
      (error, stdout) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : -1;
        resolve({ code, stdout: typeof stdout === "string" ? stdout : "" });
      },
    );
    // `security` 可能没读标准输入就退了（钥匙串锁着、没有登录会话）：写端随后
    // 收到 EPIPE。没有监听器的 'error' 会让 core 整个崩掉；这里的答案是退出码。
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin ?? "");
  });

/**
 * `security -i` 一行命令约 4 KiB 封顶；留出命令本身与转义的余量。超过就明说，
 * 不截断。
 */
export const KEYCHAIN_MAX_VALUE = 3500;

/** `security -i` 的参数：双引号包起来，反斜杠与双引号前加反斜杠。 */
export function quoteForInteractive(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 一个钥匙串条目的地址。`account` 缺省时只按 service 找。 */
export interface KeychainAddress {
  readonly service: string;
  readonly account?: string;
}

function addressArgs(address: KeychainAddress): string[] {
  return address.account === undefined
    ? ["-s", address.service]
    : ["-a", address.account, "-s", address.service];
}

/**
 * 读一个条目；不在时 `undefined`，工具别的失败抛 {@link SecretUnavailable}。
 * `keychain` 给了就只在那个钥匙串文件里找，否则按搜索列表。
 */
export async function readKeychain(
  tool: SecurityTool,
  address: KeychainAddress,
  keychain?: string,
): Promise<string | undefined> {
  const result = await tool([
    "find-generic-password",
    ...addressArgs(address),
    "-w",
    ...(keychain === undefined ? [] : [keychain]),
  ]);
  if (result.code === ITEM_NOT_FOUND) return undefined;
  if (result.code !== 0) throw new SecretUnavailable("keychain_failed");
  const value = result.stdout.replace(/[\r\n]+$/, "");
  return value === "" ? undefined : value;
}

/** 删一个条目；不在是成功。 */
export async function deleteKeychain(
  tool: SecurityTool,
  address: KeychainAddress,
  keychain?: string,
): Promise<void> {
  const result = await tool([
    "delete-generic-password",
    ...addressArgs(address),
    ...(keychain === undefined ? [] : [keychain]),
  ]);
  if (result.code === 0 || result.code === ITEM_NOT_FOUND) return;
  throw new SecretUnavailable("keychain_failed");
}

/**
 * 这个账户的默认钥匙串文件；没有时 `undefined`。
 *
 * `security default-keychain` 只读偏好设置，不碰任何条目、从不弹窗。没有默认钥匙串
 * （临时 HOME、登录钥匙串被删）时条目命令不会失败退出，而是让 SecurityAgent 弹
 * 「找不到钥匙串」——所以先问这一句，并确认它说的文件真的在（`login.keychain` 在
 * 磁盘上是 `login.keychain-db`）。
 */
export async function defaultKeychain(
  tool: SecurityTool,
  exists: (path: string) => boolean = existsSync,
): Promise<string | undefined> {
  let result: SecurityResult;
  try {
    result = await tool(["default-keychain"]);
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;
  const quoted = /"([^"]+)"/.exec(result.stdout);
  const path = (quoted?.[1] ?? result.stdout).trim();
  if (!path.startsWith("/")) return undefined;
  if (exists(path)) return path;
  return exists(`${path}-db`) ? `${path}-db` : undefined;
}

/** 每个工具只问一次默认钥匙串：一轮 core 里各域拿到的后端共用答案。 */
const probes = new WeakMap<SecurityTool, Promise<string | undefined>>();

function probeOnce(
  tool: SecurityTool,
  exists: ((path: string) => boolean) | undefined,
): Promise<string | undefined> {
  if (exists !== undefined) return defaultKeychain(tool, exists);
  let probe = probes.get(tool);
  if (probe === undefined) {
    probe = defaultKeychain(tool);
    probes.set(tool, probe);
  }
  return probe;
}

export interface KeychainOptions {
  /** 文件在不在；测试注入。给了就不缓存默认钥匙串的答案。 */
  readonly exists?: (path: string) => boolean;
}

/**
 * 名字同时是 service 与 account：一个条目一个名字，在钥匙串访问里按 `armadra-`
 * 一搜就是全部。
 *
 * 每次存取先确认默认钥匙串（{@link defaultKeychain}）：没有就抛
 * `SecretUnavailable("keychain_missing")`，一条条目命令都不跑（同钥匙串锁住：hook
 * 密钥本轮 `ephemeral`）。有就把它的路径显式带给条目命令，`add-generic-password`
 * 永远不需要自己「找一个钥匙串来存」。
 */
export function keychainBackend(
  tool: SecurityTool = realSecurityTool,
  options: KeychainOptions = {},
): SecretBackend {
  const address = (name: string): KeychainAddress => {
    checkSecretName(name);
    return { service: name, account: name };
  };
  const keychain = async (): Promise<string> => {
    const path = await probeOnce(tool, options.exists);
    if (path === undefined) throw new SecretUnavailable("keychain_missing");
    return path;
  };
  return {
    kind: "keychain",
    async get(name) {
      const where = address(name);
      return readKeychain(tool, where, await keychain());
    },
    async set(name, value) {
      if (/[\r\n]/.test(value)) throw new Error("secret values are one line");
      const where = address(name);
      if (value.length > KEYCHAIN_MAX_VALUE) {
        throw new SecretUnavailable("keychain_value_too_long");
      }
      const file = await keychain();
      // 经 `security -i` 从标准输入读一整条命令写，而不是 `-w <值>`（参数会出现在
      // 进程命令行里），也不是 `-w` 的交互提示——那条走 getpass，超过 128 个字符
      // 的值会被悄悄截断，读回来对不上（远程服务的刷新令牌就比这长）。
      await tool(
        ["-i"],
        `add-generic-password -U ${addressArgs(where)
          .map(quoteForInteractive)
          .join(" ")} -w ${quoteForInteractive(value)} ${quoteForInteractive(
          file,
        )}\n`,
      );
      // 两次提示对不上时工具也退 0，所以写靠读回来确认。
      const stored = await readKeychain(tool, where, file).catch(
        () => undefined,
      );
      if (stored !== value) throw new SecretUnavailable("keychain_failed");
    },
    async delete(name) {
      const where = address(name);
      await deleteKeychain(tool, where, await keychain());
    },
  };
}
