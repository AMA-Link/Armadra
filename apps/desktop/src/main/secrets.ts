import type { ChildProcess } from "node:child_process";
import {
  SEALER_ENV,
  SECRETS_MESSAGE,
  type SealRequest,
  type SealResponse,
  type SealerKind,
} from "../core/secrets/ipc";

/**
 * 桌面壳给 core 的密钥后端：Electron `safeStorage`，经 fork 的 IPC 通道
 * （[外部服务 §12.1](../../../../docs/design/external-services.md)）。
 *
 * core 是 `ELECTRON_RUN_AS_NODE` 的子进程，那里没有 `safeStorage`，所以这个模块在
 * 主进程里替它封与解；core 那一半在 `core/secrets/ipc.ts`。
 *
 * | 平台    | 用不用                                                              | 自报        |
 * | ------- | ------------------------------------------------------------------- | ----------- |
 * | macOS   | 不用：core 维持 `security(1)`，已有条目都在钥匙串里，不出两套存放 | `keychain`  |
 * | Windows | `isAsyncEncryptionAvailable()` 时用（DPAPI）                         | `dpapi`     |
 * | Linux   | 只在 `getSelectedStorageBackend()` 是 libsecret / kwallet 时用       | `libsecret` |
 *
 * Linux 的 `basic_text` 是一次 PBKDF2 迭代加写死的口令，等于明文，而可用性检查
 * 在某些版本对它仍答 true；`unknown` 是还没定下来。两者都当作「没有钥匙串」，core
 * 落回 0600 文件并如实自报 `file`。
 *
 * 只用异步那一组接口：同步的 `isEncryptionAvailable` / `encryptString` /
 * `decryptString` 在 Electron 45 弃用、46 删除。同步封的密文异步照样解得开，已有
 * 的 `.sealed` 文件不用迁移。
 *
 * 只能在 `app` ready 之后判定种类：之前 Linux 的后端还没选出来。壳在 ready 之后
 * 判一次（{@link secretChannel}），之后才 spawn core。
 */

/** 用到的那一小块 `safeStorage`，测试注入假的。 */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ result: string; shouldReEncrypt?: boolean }>;
  getSelectedStorageBackend?: () => string;
}

const LINUX_KEYRINGS = /^(gnome_libsecret|kwallet\d*)$/;

/** 这台机器上桌面壳能给的封存种类；给不了时 `undefined`。 */
export async function sealerKind(
  storage: SafeStorageLike,
  platform: NodeJS.Platform = process.platform,
): Promise<SealerKind | undefined> {
  if (platform === "win32") {
    return (await available(storage)) ? "dpapi" : undefined;
  }
  if (platform === "linux") {
    const backend = storage.getSelectedStorageBackend?.() ?? "unknown";
    if (!LINUX_KEYRINGS.test(backend)) return undefined;
    return (await available(storage)) ? "libsecret" : undefined;
  }
  return undefined;
}

/** 可用性检查抛错与答 false 一样：没有钥匙串。 */
async function available(storage: SafeStorageLike): Promise<boolean> {
  try {
    return await storage.isAsyncEncryptionAvailable();
  } catch {
    return false;
  }
}

/** spawn core 时加进它环境里的那一个变量；给不了时什么都不加。 */
export function sealerEnvironment(
  kind: SealerKind | undefined,
): Record<string, string> {
  return kind === undefined ? {} : { [SEALER_ENV]: `ipc:${kind}` };
}

function isRequest(message: unknown): message is SealRequest {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as Partial<SealRequest>;
  return (
    candidate.type === SECRETS_MESSAGE &&
    typeof candidate.id === "number" &&
    (candidate.op === "seal" || candidate.op === "unseal") &&
    typeof candidate.data === "string"
  );
}

/**
 * 答一条请求。值只在这一个调用里以明文存在；失败只回代码，不回 Electron 的错误
 * 文本。
 *
 * 封的是 base64 解出来的 UTF-8 文本——`safeStorage` 只吃字符串。
 */
export async function answer(
  storage: SafeStorageLike,
  request: SealRequest,
): Promise<SealResponse> {
  try {
    const input = Buffer.from(request.data, "base64");
    const data =
      request.op === "seal"
        ? await storage.encryptStringAsync(input.toString("utf8"))
        : Buffer.from((await storage.decryptStringAsync(input)).result, "utf8");
    return {
      type: SECRETS_MESSAGE,
      id: request.id,
      ok: true,
      data: data.toString("base64"),
    };
  } catch {
    return {
      type: SECRETS_MESSAGE,
      id: request.id,
      ok: false,
      code: request.op === "seal" ? "seal_failed" : "unseal_failed",
    };
  }
}

/** 在一个刚 spawn 的 core 上挂应答。别的消息不归这里管，原样忽略。 */
export function attachSecretChannel(
  child: Pick<ChildProcess, "on" | "send" | "connected">,
  storage: SafeStorageLike,
): void {
  child.on("message", (message: unknown) => {
    if (!isRequest(message)) return;
    void answer(storage, message).then((response) => {
      if (child.connected) child.send?.(response);
    });
  });
}

/** 壳 spawn core 时用的那一对：环境变量与通道应答。 */
export interface SecretChannel {
  environment(): Record<string, string>;
  attach(child: Pick<ChildProcess, "on" | "send" | "connected">): void;
}

/**
 * ready 之后判一次种类，之后每次 spawn 都用它（判定是异步的，spawn 时的环境变量
 * 是同步给的）。给不了时把变量设成空串，免得一个从外面继承来的值让 core 去等一个
 * 不会应答的壳。
 */
export async function secretChannel(
  storage: SafeStorageLike,
  platform: NodeJS.Platform = process.platform,
): Promise<SecretChannel> {
  const kind = await sealerKind(storage, platform);
  return {
    environment() {
      return { [SEALER_ENV]: "", ...sealerEnvironment(kind) };
    },
    attach(child) {
      if (kind !== undefined) attachSecretChannel(child, storage);
    },
  };
}
