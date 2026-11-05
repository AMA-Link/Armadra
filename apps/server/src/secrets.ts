import { existsSync } from "node:fs";
import { join } from "node:path";

import { findWinsecExe } from "../../desktop/src/core/windows/acl";
import {
  type DpapiRunner,
  type SecretBackend,
  dpapiSealer,
  encryptedFileBackend,
  forcedFileBackend,
  loadOrCreateMasterKey,
  plainFileBackend,
  sealedFileBackend,
  secretsDirectory,
} from "../../desktop/src/core/secrets";

/**
 * 服务器壳的密钥后端（[外部服务 §12.1](../../../docs/design/external-services.md)）。
 *
 * 服务器上没有登录会话持有的钥匙串，所以条目用一把 master key 做 AES-256-GCM
 * 封装，自报 `file-encrypted`。钥匙默认在 `<数据目录>/secrets/master.key`（0600，
 * 首启生成）；`ARMADRA_SECRET_MASTER_KEY_FILE` 可以指到别处（如 systemd
 * `LoadCredential=`），那时缺了就拒绝启动而不是另生成一把——新钥匙打不开旧条目。
 *
 * Windows 上、没有 master key 在先、且找得到 `armadra-winsec.exe` 时改用 DPAPI
 * （自报 `dpapi`，密文同样在 `<数据目录>/secrets/`，契约 §102.7）。已经有
 * `master.key`（或运维用 `ARMADRA_SECRET_MASTER_KEY_FILE` 指了一把）就继续
 * `file-encrypted`：两种后端各读各的信封，换了会让已存的条目全部打不开。
 * 想从 `file-encrypted` 换到 DPAPI，要自己重存条目、删掉 `master.key`。
 *
 * `ARMADRA_SECRET_BACKEND=file` 强制明文 0600（测试与无人值守）。
 */

export const MASTER_KEY_ENV = "ARMADRA_SECRET_MASTER_KEY_FILE";

export function masterKeyFile(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { readonly path: string; readonly configured: boolean } {
  const configured = (env[MASTER_KEY_ENV] ?? "").trim();
  return configured === ""
    ? { path: join(secretsDirectory(dataDir), "master.key"), configured: false }
    : { path: configured, configured: true };
}

export interface ServerSecretsOptions {
  readonly platform?: NodeJS.Platform;
  /** `armadra-winsec.exe` 的路径；不给时在 win32 上用 `findWinsecExe(env)` 找。 */
  readonly winsec?: string | undefined;
  readonly dpapiRunner?: DpapiRunner;
}

/** `ARMADRA_SECRET_BACKEND` 没指名别的后端（空，或就是 `dpapi`）：DPAPI 才有资格。 */
function dpapiAllowed(env: NodeJS.ProcessEnv): boolean {
  const value = (env.ARMADRA_SECRET_BACKEND ?? "").trim().toLowerCase();
  return value === "" || value === "dpapi";
}

export function serverSecrets(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ServerSecretsOptions = {},
): SecretBackend {
  const directory = secretsDirectory(dataDir);
  if (forcedFileBackend(env)) return plainFileBackend(directory);
  const key = masterKeyFile(dataDir, env);
  if (
    dpapiAllowed(env) &&
    (options.platform ?? process.platform) === "win32" &&
    !key.configured &&
    !existsSync(key.path)
  ) {
    const exe = "winsec" in options ? options.winsec : findWinsecExe(env);
    if (exe !== undefined) {
      return sealedFileBackend(
        directory,
        dpapiSealer(
          exe,
          options.dpapiRunner === undefined ? {} : { run: options.dpapiRunner },
        ),
      );
    }
  }
  // 现在就读（或生成）一次：钥匙不对是启动时的错，不是第一次登录时的。
  loadOrCreateMasterKey(key.path, { create: !key.configured });
  return encryptedFileBackend({
    directory,
    keyFile: key.path,
    createKey: !key.configured,
  });
}
