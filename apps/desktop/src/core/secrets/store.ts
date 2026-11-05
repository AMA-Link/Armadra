/**
 * 一个具名的密钥，以及旧位置的读写器（给 {@link ./migrate}）。
 */

import { readFileSync, rmSync } from "node:fs";

import type { SecretBackend, SecretBackendKind } from "./backend";
import type { LegacySecret } from "./migrate";
import {
  type KeychainAddress,
  type SecurityTool,
  deleteKeychain,
  readKeychain,
} from "./keychain";

/**
 * 一个名字下的一个值。`ready` 是这个名字的旧条目迁移：第一次读写才触发、并等它
 * 做完，免得读到一个还没搬过来的空位；装配本身从不碰任何存储。
 */
export class SecretStore {
  constructor(
    private readonly secrets: SecretBackend,
    readonly name: string,
    private readonly ready: () => Promise<unknown> = () => Promise.resolve(),
  ) {}

  /** 这个值实际存在哪儿。报给设置页，从不带值。 */
  backend(): SecretBackendKind {
    return this.secrets.kind;
  }

  private async settled(): Promise<void> {
    await this.ready().catch(() => undefined);
  }

  /** 存着的值；没有、或这一刻打不开时 `undefined`。 */
  async read(): Promise<string | undefined> {
    await this.settled();
    try {
      return await this.secrets.get(this.name);
    } catch {
      return undefined;
    }
  }

  /**
   * 同 {@link read}，但打不开时**抛**（{@link SecretUnavailable} 或后端自己的错），
   * 不把「不在」与「这一刻拿不到」混成同一个 `undefined`。要决定「铸新值还是别碰」
   * 的调用方用它：把一个只是暂时锁住的值当成不存在、再铸一个覆盖上去，是不可恢复的。
   */
  async readStrict(): Promise<string | undefined> {
    await this.settled();
    return this.secrets.get(this.name);
  }

  /** 有没有值。刻意不返回值本身。 */
  async isSet(): Promise<boolean> {
    return (await this.read()) !== undefined;
  }

  async write(value: string): Promise<void> {
    await this.settled();
    await this.secrets.set(this.name, value);
  }

  async clear(): Promise<void> {
    await this.settled();
    await this.secrets.delete(this.name);
  }
}

/** 旧的 0600 明文文件。 */
export function legacyFile(id: string, to: string, path: string): LegacySecret {
  return {
    id,
    to,
    async read() {
      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
      const value = content.replace(/[\r\n]+$/, "").trim();
      return value === "" ? undefined : value;
    },
    async remove() {
      rmSync(path, { force: true });
    },
  };
}

/**
 * 旧的 0600 二进制文件（hook 实例密钥）：按字节读，必须**正好** `bytes` 字节才算
 * 一个值，以 base64url 交给新位置。长度不对的文件是残骸，当作没有（旧实现也是
 * 这么处理的：换一个新的）。
 */
export function legacyBinaryFile(
  id: string,
  to: string,
  path: string,
  bytes: number,
): LegacySecret {
  return {
    id,
    to,
    async read() {
      let content: Buffer;
      try {
        content = readFileSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
      return content.length === bytes
        ? content.toString("base64url")
        : undefined;
    },
    async remove() {
      rmSync(path, { force: true });
    },
  };
}

/** 旧的钥匙串条目（旧 service 名）。 */
export function legacyKeychain(
  id: string,
  to: string,
  tool: SecurityTool,
  address: KeychainAddress,
): LegacySecret {
  return {
    id,
    to,
    read: () => readKeychain(tool, address),
    remove: () => deleteKeychain(tool, address),
  };
}
