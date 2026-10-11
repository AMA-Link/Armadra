/**
 * 本机作为客户端时的设备钥（契约 §78.3）：桌面窗口连别的电脑（「我的其他电脑」）
 * 经中继的端到端通道时，握手 m3 要用一把 Ed25519 设备钥签转录。这把钥由本机 core
 * 保管——私钥 PKCS8 只在 SecretStore `armadra-device-key`，页面经回环请 core 签，
 * 私钥不出这个类、不进日志与任何答案。
 *
 * 只签 32 字节的转录哈希，签名域前缀与公钥固定由这里加（`"armadra-e2e/1 device" ‖ h ‖
 * pub`），页面给不了别的字节，所以这个接口不是一个任意签名器。
 */

import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";

import { E2E_LABELS } from "@armadra/platform-protocol/e2e";

import { type SecretBackend, checkSecretName } from "../../secrets/backend";

export const DEVICE_KEY_REF = checkSecretName("armadra-device-key");

/** 转录哈希的长度（SHA-256）。 */
export const TRANSCRIPT_BYTES = 32;

export class DeviceKey {
  private loading: Promise<KeyObject> | undefined;

  constructor(private readonly backend: () => SecretBackend) {}

  private key(): Promise<KeyObject> {
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }

  private async load(): Promise<KeyObject> {
    const backend = this.backend();
    const stored = await backend.get(DEVICE_KEY_REF);
    if (stored !== undefined && stored !== "") {
      return createPrivateKey({
        key: Buffer.from(stored, "base64"),
        format: "der",
        type: "pkcs8",
      });
    }
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    await backend.set(DEVICE_KEY_REF, Buffer.from(der).toString("base64"));
    return privateKey;
  }

  /** 公钥原文（32 字节）。 */
  async publicKey(): Promise<Uint8Array> {
    const jwk = createPublicKey(await this.key()).export({ format: "jwk" }) as {
      x?: string;
    };
    return new Uint8Array(Buffer.from(jwk.x ?? "", "base64url"));
  }

  /**
   * core 自己作为客户端（本机连别的电脑，`sources` 域经中继登录）时的签名方：握手
   * 交来的签名输入原样签。只在 core 进程里用，不经任何接口。
   */
  async signer(): Promise<{
    publicKey: Uint8Array;
    sign(data: Uint8Array): Promise<Uint8Array>;
  }> {
    const key = await this.key();
    const publicKey = await this.publicKey();
    return {
      publicKey,
      sign: async (data) => new Uint8Array(sign(null, data, key)),
    };
  }

  /**
   * 签 `"armadra-e2e/1 device" ‖ transcript ‖ 设备公钥`（协议包握手 m3 的签名输入）；
   * 转录必须正好 32 字节。
   */
  async signTranscript(transcript: Uint8Array): Promise<Uint8Array> {
    if (transcript.length !== TRANSCRIPT_BYTES) {
      throw new RangeError("转录哈希应为 32 字节");
    }
    const input = Buffer.concat([
      Buffer.from(E2E_LABELS.deviceSignature, "utf8"),
      Buffer.from(transcript),
      Buffer.from(await this.publicKey()),
    ]);
    return new Uint8Array(sign(null, input, await this.key()));
  }
}
