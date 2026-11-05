/**
 * Windows DPAPI 封存，经 `armadra-winsec.exe` 的 `dpapi-protect` / `dpapi-unprotect`
 * （[契约 §102.7](../../../../../docs/contracts/core-json-api.md)）。
 *
 * 给没有桌面壳 `safeStorage` 可用的 core 用：Windows 上的服务器壳、无壳 core。
 * 密文与桌面壳 `safeStorage` 封的一样落在数据目录（{@link sealedFileBackend}），
 * 只是封存者是这个小工具。值只走子进程的 stdin / stdout，从不进命令行。
 *
 * 不用 PowerShell 做同样的事：冷启动一次要几百毫秒到数秒、受执行策略与受限语言
 * 模式影响，凭据读写在启动路径上，宁可没有 DPAPI 也不走那条路。
 */

import { execFile } from "node:child_process";

import { SecretUnavailable, type SecretSealer } from "./backend";

/** 一次封存 / 解封的明文上限，与 {@link ./file} 单个条目的上限一致。 */
export const DPAPI_MAX_PLAIN_BYTES = 32 * 1024;
/** 密文比明文多出几百字节的头；超出这个上限的输出不被信任。 */
export const DPAPI_MAX_SEALED_BYTES = DPAPI_MAX_PLAIN_BYTES + 4 * 1024;
export const DPAPI_TIMEOUT_MS = 10_000;

export interface DpapiRunOptions {
  readonly timeoutMs: number;
  /** stdout 的字节上限；超过就杀掉子进程并失败。 */
  readonly maxOutputBytes: number;
}

/** 以 `input` 为 stdin 跑 `file args`，resolve 它的 stdout；非零退出、超时、超限都 reject。 */
export type DpapiRunner = (
  file: string,
  args: readonly string[],
  input: Buffer,
  options: DpapiRunOptions,
) => Promise<Buffer>;

export const realDpapiRunner: DpapiRunner = (file, args, input, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        windowsHide: true,
        encoding: "buffer",
      },
      (error, stdout) => {
        // 错误对象的 message 里会带 stderr，但 stderr 只有系统的异常文案，不含输入。
        if (error !== null) reject(error);
        else resolve(stdout);
      },
    );
    // 子进程在读完 stdin 前就退出时 end() 会 EPIPE；真正的失败由回调报告。
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });

export interface DpapiSealerOptions {
  readonly run?: DpapiRunner;
  readonly timeoutMs?: number;
}

/**
 * 以 `armadra-winsec.exe` 为后端的 {@link SecretSealer}（`dpapi`）。
 *
 * 解封失败（密文被改、换了用户 / 机器、是别的封存者封的）统一是
 * {@link SecretUnavailable}，`reason` 只是代码，从不带值或工具的输出。
 */
export function dpapiSealer(
  exe: string,
  options: DpapiSealerOptions = {},
): SecretSealer {
  const run = options.run ?? realDpapiRunner;
  const timeoutMs = options.timeoutMs ?? DPAPI_TIMEOUT_MS;
  return {
    kind: "dpapi",
    async seal(plain) {
      if (plain.length > DPAPI_MAX_PLAIN_BYTES) {
        throw new SecretUnavailable("oversized");
      }
      let sealed: Buffer;
      try {
        sealed = await run(exe, ["dpapi-protect"], plain, {
          timeoutMs,
          maxOutputBytes: DPAPI_MAX_SEALED_BYTES,
        });
      } catch {
        throw new SecretUnavailable("dpapi_seal_failed");
      }
      if (sealed.length === 0) throw new SecretUnavailable("dpapi_seal_failed");
      return sealed;
    },
    async unseal(sealed) {
      if (sealed.length > DPAPI_MAX_SEALED_BYTES) {
        throw new SecretUnavailable("oversized");
      }
      try {
        return await run(exe, ["dpapi-unprotect"], sealed, {
          timeoutMs,
          maxOutputBytes: DPAPI_MAX_PLAIN_BYTES,
        });
      } catch {
        throw new SecretUnavailable("dpapi_unseal_failed");
      }
    },
  };
}
