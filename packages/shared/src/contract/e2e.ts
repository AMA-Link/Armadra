import { z } from "zod";

import { DEVICE_STATUSES } from "./devices.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `e2e.*`（契约 §78）：经中继的端到端通道 `armadra-e2e/1` 在 core 这一侧的几条。
 *
 * - `identity`：这台 core 的身份公钥（就是源钥，Ed25519）与指纹；配对页与客户端
 *   首次连接用。匿名。
 * - `wait`：新设备在待确认时长轮询，状态变了（或 25 秒）就答。匿名，但只在端到端
 *   通道上、只认这条通道自己的设备钥申请的记录，别处一律 404。
 * - `sign`：本机作为客户端连别的电脑时，设备钥由本机 core 保管（SecretStore），页面
 *   经回环请它签握手转录。只在回环、只有 owner。
 * - `waitSource`：本机 core 代页面连别的电脑（`sources.session`）时这台设备在对端
 *   待确认，页面经它等对端主人核对（core 经自己那条通道问对端的 `e2e.wait`）。
 */

const DEVICE_STATUS = z.enum(DEVICE_STATUSES);

export const e2eIdentitySchema = z.object({
  sourceId: z.string(),
  /** Ed25519 公钥，base64url（32 字节）。 */
  identityPub: z.string(),
  /** `base32(SHA-256(pub))` 的前 52 字符；界面分组显示前 16 位。 */
  fingerprint: z.string(),
});

export type E2eIdentity = z.infer<typeof e2eIdentitySchema>;

export const e2eSignatureSchema = z.object({
  /** 本机设备钥的公钥，base64url（32 字节）。 */
  publicKey: z.string(),
  /** 对 `"armadra-e2e/1 device" ‖ transcript` 的 Ed25519 签名，base64url。 */
  signature: z.string(),
});

export type E2eSignature = z.infer<typeof e2eSignatureSchema>;

export const E2E_IDENTITY_PATH = "/api/e2e/identity";
export const E2E_WAIT_PATH = "/api/e2e/wait";
export const E2E_SIGN_PATH = "/api/e2e/sign";
export const E2E_SOURCE_WAIT_PATH = "/api/e2e/sources/wait";
export const E2E_PAIRING_SECRET_PATH = "/api/e2e/pairing-secret";

/**
 * 配对二维码的载荷（契约 §80.1）：新设备扫到它就知道这台电脑的身份公钥（不走
 * TOFU），握手 m3 用秘密证明自己扫过码。二维码里放的是
 * `armadra://pair-e2e?d=<base64url(JSON)>`。
 */
export const e2ePairingPayloadSchema = z.object({
  sourceId: z.string(),
  /** 身份公钥，base64url（32 字节）。 */
  identityPub: z.string(),
  fingerprint: z.string(),
  /** 一次性配对秘密，base64url（16 字节）。 */
  secret: z.string(),
  /** 这台电脑登记到的远程服务（新设备经它们连）。 */
  issuers: z.array(z.string()),
  expiresAtMs: z.number().int(),
  /** 二维码里的那一串。 */
  uri: z.string(),
});

export type E2ePairingPayload = z.infer<typeof e2ePairingPayloadSchema>;

const base = { since: "1.45" } as const;

export const e2e = {
  /** 匿名：这台 core 的身份公钥与指纹。 */
  identity: oc
    .input(z.object({}).optional())
    .output(e2eIdentitySchema)
    .errors(errors.pick("unsupported"))
    .meta(
      meta({
        ...base,
        contract: "§78.1",
        scope: null,
        legacy: { method: "GET", path: E2E_IDENTITY_PATH },
      }),
    ),
  /** 匿名、只在通道上：等主人核对，答当前状态。 */
  wait: oc
    .input(z.object({ pendingId: z.string() }))
    .output(z.object({ status: DEVICE_STATUS }))
    .errors(errors.pick("bad_request", "not_found"))
    .meta(
      meta({
        ...base,
        contract: "§78.2",
        scope: null,
        legacy: { method: "POST", path: E2E_WAIT_PATH },
      }),
    ),
  /** owner：本机代连的那台电脑上，这台设备的待确认等到了什么（§78.4）。 */
  waitSource: oc
    .input(z.object({ sourceId: z.string(), pendingId: z.string() }))
    .output(z.object({ status: DEVICE_STATUS }))
    .errors(errors.pick("unauthenticated", "forbidden", "bad_request"))
    .meta(
      meta({
        ...base,
        contract: "§78.4",
        scope: "settings:write",
        legacy: { method: "POST", path: E2E_SOURCE_WAIT_PATH },
      }),
    ),
  /** owner（本机或已信任设备经通道）：签一枚 5 分钟、一次性的配对秘密，做二维码（§80.1）。 */
  pairingSecret: oc
    .input(z.object({}).optional())
    .output(e2ePairingPayloadSchema)
    .errors(errors.pick("unauthenticated", "forbidden", "unsupported"))
    .meta(
      meta({
        since: "1.47",
        contract: "§80.1",
        scope: "settings:write",
        legacy: { method: "POST", path: E2E_PAIRING_SECRET_PATH },
      }),
    ),
  /** 只在回环、owner：用本机设备钥签一次握手转录（32 字节）。 */
  sign: oc
    .input(z.object({ transcript: z.string() }))
    .output(e2eSignatureSchema)
    .errors({
      ...errors.pick("unauthenticated", "forbidden", "bad_request"),
      ...errors.pick("unsupported"),
    })
    .meta(
      meta({
        ...base,
        contract: "§78.3",
        scope: "settings:write",
        legacy: { method: "POST", path: E2E_SIGN_PATH },
      }),
    ),
};
