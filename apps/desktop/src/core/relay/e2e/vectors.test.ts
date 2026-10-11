import { describe, expect, it } from "vitest";

import {
  CoreHandshake,
  E2E_LABELS,
  ed25519SignerFromSeed,
  ed25519Verify,
  x25519FromSeed,
} from "@armadra/platform-protocol/e2e";
import { readJsonFixture } from "@armadra/platform-protocol/fixtures";

import { memoryBackend } from "../../identity/cloud/fake.fixture";
import { DeviceKey } from "./device-key";
import { deviceIdOf } from "./devices";
import { keyFingerprint } from "./routes";

/**
 * 黄金向量（协议包 `fixtures/e2e/handshake.json`，cloud 仓用 node:crypto 独立算出）：
 * core 一侧用同一组固定钥跑协议包的握手，消息字节、校验码与设备 id 逐字节对上；
 * core 自己算的设备 id 与指纹（node:crypto）与协议包（WebCrypto）一致。
 */

interface Vector {
  name: string;
  inputs: {
    sourceId: string;
    coreEphemeralSeed: string;
    coreIdentitySeed: string;
    proofSecret: string | null;
  };
  keys: {
    coreIdentityPub: string;
    devicePub: string;
    coreFingerprint: string;
    deviceId: string;
  };
  transcript: { h3: string };
  sas: string;
  messages: { m1: string; m2: string; m3: string };
}

const { vectors } = readJsonFixture<{ vectors: Vector[] }>(
  "e2e/handshake.json",
);
const hex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));

describe("armadra-e2e/1 黄金向量（core 一侧）", () => {
  for (const vector of vectors) {
    it(`${vector.name}：m2、设备、校验码与 proof 都对上`, async () => {
      const handshake = await CoreHandshake.accept(hex(vector.messages.m1), {
        sourceId: vector.inputs.sourceId,
        identity: await ed25519SignerFromSeed(
          hex(vector.inputs.coreIdentitySeed),
        ),
        ephemeral: await x25519FromSeed(hex(vector.inputs.coreEphemeralSeed)),
      });
      expect(Buffer.from(handshake.m2).toString("hex")).toBe(
        vector.messages.m2,
      );
      const result = await handshake.readDevice(hex(vector.messages.m3));
      expect(result.session.sas).toBe(vector.sas);
      expect(result.device.deviceId).toBe(vector.keys.deviceId);
      expect(deviceIdOf(hex(vector.keys.devicePub))).toBe(vector.keys.deviceId);
      expect(keyFingerprint(hex(vector.keys.coreIdentityPub))).toBe(
        vector.keys.coreFingerprint,
      );
      if (vector.inputs.proofSecret === null) {
        expect(result.hasProof).toBe(false);
      } else {
        expect(result.hasProof).toBe(true);
        expect(await result.verifyProof(hex(vector.inputs.proofSecret))).toBe(
          true,
        );
        expect(await result.verifyProof(new Uint8Array(16).fill(1))).toBe(
          false,
        );
      }
    });
  }

  it("改 m3 的任何一个字节都读不出设备", async () => {
    const vector = vectors[0]!;
    const m3 = hex(vector.messages.m3);
    m3[10] = (m3[10] as number) ^ 0x80;
    const handshake = await CoreHandshake.accept(hex(vector.messages.m1), {
      sourceId: vector.inputs.sourceId,
      identity: await ed25519SignerFromSeed(
        hex(vector.inputs.coreIdentitySeed),
      ),
      ephemeral: await x25519FromSeed(hex(vector.inputs.coreEphemeralSeed)),
    });
    await expect(handshake.readDevice(m3)).rejects.toThrow();
  });
});

describe("本机设备钥（e2e.sign）", () => {
  it("签的是协议包 m3 的签名输入：标签 ‖ 转录 ‖ 公钥", async () => {
    const backend = memoryBackend();
    const key = new DeviceKey(() => backend);
    const transcript = new Uint8Array(32).fill(0xab);
    const publicKey = await key.publicKey();
    const signature = await key.signTranscript(transcript);
    const input = Buffer.concat([
      Buffer.from(E2E_LABELS.deviceSignature, "utf8"),
      Buffer.from(transcript),
      Buffer.from(publicKey),
    ]);
    expect(await ed25519Verify(publicKey, signature, input)).toBe(true);
    // 同一个后端里第二次取到的是同一把钥。
    const again = new DeviceKey(() => backend);
    expect(Buffer.from(await again.publicKey())).toEqual(
      Buffer.from(publicKey),
    );
  });

  it("只签 32 字节的转录", async () => {
    const key = new DeviceKey(() => memoryBackend());
    await expect(key.signTranscript(new Uint8Array(31))).rejects.toThrow(
      RangeError,
    );
  });
});
