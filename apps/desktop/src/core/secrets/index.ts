/**
 * 密钥后端的挑选与装配（[外部服务 §12.1](../../../../../docs/design/external-services.md)）。
 *
 * | 条件                                         | 后端                     | 自报                     |
 * | -------------------------------------------- | ------------------------ | ------------------------ |
 * | `ARMADRA_SECRET_BACKEND=file`                | 0600 明文                | `file`                   |
 * | 壳经 `CorePlatform.secrets` 给了一个（服务器壳） | 它                       | 它的                     |
 * | 桌面壳写了 `ARMADRA_SECRET_SEALER=ipc:<kind>`  | `safeStorage` 经 IPC 封存 | `dpapi` / `libsecret`    |
 * | Windows，找得到 `armadra-winsec.exe`，且没有旧明文条目 | DPAPI（该工具）封存 | `dpapi`          |
 * | macOS，默认数据目录                            | `security(1)` 钥匙串      | `keychain`               |
 * | macOS，别的数据目录（开发、探针、隔离实例）       | 数据目录里的 master key   | `file-encrypted`         |
 * | 其余                                         | 0600 明文                | `file`                   |
 *
 * 壳说了要用 `safeStorage` 但通道不在（core 被别的壳接管）时，后端拒绝一切而不是
 * 降级成明文。
 *
 * 钥匙串条目按名字寻址、整个账户共用一份，所以只给默认数据目录（契约 §102.1）：
 * 指了别的数据目录的实例要是也用它，就会读到、覆盖真实应用的值。
 */

import { userInfo } from "node:os";
import { join, resolve } from "node:path";

import { dataDir as platformDataDir } from "../paths";

import { findWinsecExe } from "../windows/acl";
import { type SecretBackend, unavailableBackend } from "./backend";
import {
  encryptedFileBackend,
  hasEntryFiles,
  plainFileBackend,
  sealedFileBackend,
} from "./file";
import { type DpapiRunner, dpapiSealer } from "./dpapi";
import { type IpcChannel, ipcSealer, sealerKindFromEnv } from "./ipc";
import {
  type SecurityTool,
  keychainBackend,
  realSecurityTool,
} from "./keychain";

export * from "./backend";
export {
  DPAPI_MAX_PLAIN_BYTES,
  DPAPI_MAX_SEALED_BYTES,
  DPAPI_TIMEOUT_MS,
  dpapiSealer,
  realDpapiRunner,
  type DpapiRunOptions,
  type DpapiRunner,
  type DpapiSealerOptions,
} from "./dpapi";
export {
  encryptedFileBackend,
  hasEntryFiles,
  loadOrCreateMasterKey,
  masterKeyId,
  plainFileBackend,
  previousKeyFile,
  readMasterKey,
  rotateMasterKey,
  sealedFileBackend,
} from "./file";
export {
  SEALER_ENV,
  SECRETS_MESSAGE,
  ipcSealer,
  sealerKindFromEnv,
  type IpcChannel,
  type SealRequest,
  type SealResponse,
  type SealerKind,
} from "./ipc";
export {
  defaultKeychain,
  keychainBackend,
  realSecurityTool,
  type KeychainAddress,
  type KeychainOptions,
  type SecurityTool,
} from "./keychain";
export {
  migrateLegacySecrets,
  migrationRecordFile,
  type LegacySecret,
  type MigrationResult,
} from "./migrate";
export {
  SecretStore,
  legacyBinaryFile,
  legacyFile,
  legacyKeychain,
} from "./store";

/** 数据目录里放密钥文件的地方。 */
export function secretsDirectory(dataDir: string): string {
  return join(dataDir, "secrets");
}

/** `ARMADRA_SECRET_BACKEND=file`：测试与无人值守用，强制明文 0600。 */
export function forcedFileBackend(env: NodeJS.ProcessEnv): boolean {
  return (env.ARMADRA_SECRET_BACKEND ?? "").trim().toLowerCase() === "file";
}

/**
 * `ARMADRA_SECRET_BACKEND=file-encrypted`：无窗口的探针与端到端用，同服务器壳的
 * 默认（数据目录里的 master key，AES-256-GCM），既不碰系统钥匙串、也不是
 * 明文降级——节点凭据这类拒绝 `file` 的功能可以在临时数据目录里走通。
 */
export function forcedEncryptedBackend(env: NodeJS.ProcessEnv): boolean {
  return (
    (env.ARMADRA_SECRET_BACKEND ?? "").trim().toLowerCase() === "file-encrypted"
  );
}

export interface ResolveOptions {
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 壳注入的后端（服务器壳）。 */
  readonly injected?: SecretBackend | undefined;
  /** fork 的 IPC 通道；桌面壳起的 core 里就是 `process`。 */
  readonly channel?: IpcChannel | undefined;
  readonly platform?: NodeJS.Platform;
  readonly security?: SecurityTool;
  /** `armadra-winsec.exe` 的路径；不给时在 win32 上用 `findWinsecExe(env)` 找。 */
  readonly winsec?: string | undefined;
  /** 跑那个工具的方式；测试注入。 */
  readonly dpapiRunner?: DpapiRunner;
  /**
   * 这个账户的默认数据目录（macOS 上只有它用钥匙串）；不给时按账户记录里的家目录
   * 算（{@link standardDataDir}）。测试注入。
   */
  readonly standardDataDir?: string | undefined;
}

export interface ResolvedSecrets {
  readonly backend: SecretBackend;
  readonly dataDir: string;
  /** 读旧钥匙串条目用的工具；只在 `backend.kind === "keychain"` 时有意义。 */
  readonly security: SecurityTool;
}

/**
 * 这个账户在 macOS 上的默认数据目录。家目录取账户记录（`os.userInfo()`），**不随
 * `HOME` 变**：临时 HOME 下起的实例（探针、打包冒烟）不会被当成真实应用。拿不到
 * 账户记录时 `undefined`——那就没有哪个目录算默认。
 */
export function standardDataDir(): string | undefined {
  let home: string;
  try {
    home = userInfo().homedir;
  } catch {
    return undefined;
  }
  if (home === "") return undefined;
  return platformDataDir("darwin", { HOME: home });
}

/** 两个数据目录是不是同一个（按解析后的绝对路径比，同单实例锁）。 */
export function sameDataDir(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/** 数据目录里的 master key 封存（服务器壳的默认，也是非默认数据目录在 macOS 上的）。 */
function dataDirEncrypted(directory: string): SecretBackend {
  return encryptedFileBackend({
    directory,
    keyFile: join(directory, "master.key"),
    createKey: true,
  });
}

export function resolveSecretBackend(options: ResolveOptions): ResolvedSecrets {
  const env = options.env ?? process.env;
  const security = options.security ?? realSecurityTool;
  const directory = secretsDirectory(options.dataDir);
  const done = (backend: SecretBackend): ResolvedSecrets => ({
    backend,
    dataDir: options.dataDir,
    security,
  });
  if (forcedFileBackend(env)) return done(plainFileBackend(directory));
  if (forcedEncryptedBackend(env)) return done(dataDirEncrypted(directory));
  if (options.injected !== undefined) return done(options.injected);
  const sealer = sealerKindFromEnv(env);
  if (sealer !== undefined) {
    const channel = options.channel;
    if (channel === undefined || typeof channel.send !== "function") {
      return done(unavailableBackend(sealer, "shell_disconnected"));
    }
    return done(sealedFileBackend(directory, ipcSealer(sealer, channel)));
  }
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const standard =
      "standardDataDir" in options
        ? options.standardDataDir
        : standardDataDir();
    return done(
      standard !== undefined && sameDataDir(options.dataDir, standard)
        ? keychainBackend(security)
        : dataDirEncrypted(directory),
    );
  }
  // 目录里已有明文条目（此前没有 DPAPI 时存下的）就继续用明文：换成 DPAPI 会让
  // 它们读不到（两种后端各读各的文件），启动时宁可不换。要换的话先 `secrets set`
  // 重存、清掉旧 `.token`。
  if (platform === "win32" && !hasEntryFiles(directory, ".token")) {
    const exe = "winsec" in options ? options.winsec : findWinsecExe(env);
    if (exe !== undefined) {
      return done(
        sealedFileBackend(
          directory,
          dpapiSealer(
            exe,
            options.dpapiRunner === undefined
              ? {}
              : { run: options.dpapiRunner },
          ),
        ),
      );
    }
  }
  return done(plainFileBackend(directory));
}

/** 装配时能拿到的那一点：数据目录与壳给的平台。 */
export interface SecretContext {
  readonly dataDir: string;
  readonly platform: { readonly secrets?: SecretBackend | undefined };
}

const resolved = new WeakMap<object, ResolvedSecrets>();

/**
 * 这一轮 core 的密钥后端。按平台对象缓存：同一轮里各域拿到的是同一个后端（同一
 * 条 IPC 通道、同一组挂起请求）。
 */
export function secretsFor(context: SecretContext): ResolvedSecrets {
  const cached = resolved.get(context.platform);
  if (cached !== undefined && cached.dataDir === context.dataDir) return cached;
  const fresh = resolveSecretBackend({
    dataDir: context.dataDir,
    injected: context.platform.secrets,
    channel: process as unknown as IpcChannel,
  });
  resolved.set(context.platform, fresh);
  return fresh;
}
