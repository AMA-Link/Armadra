import { z } from "zod";

import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `devices.*`（契约 §77）：经中继端到端通道到达的客户端设备钥（`trusted_devices`）。
 *
 * 每台客户端设备持一把 Ed25519 设备钥，握手里签转录；core 把它绑到本机主体。新
 * 设备以某个主体第一次登录时进入「待确认」，主人在本机核对新设备屏幕上的 6 位
 * 校验码后放行（`approve`）。撤销即吊销经这把钥签的会话并断开它的通道。
 *
 * 只有 owner（全局 `settings:*`，成员一律 403）。答案里只有公钥指纹，不含任何
 * 会话凭据。
 */

export const DEVICE_STATUSES = [
  "pending",
  "trusted",
  "rejected",
  "revoked",
] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const trustedDeviceSchema = z.object({
  /** 设备钥公钥 SHA-256 的前 16 字节（32 位十六进制）。 */
  deviceId: z.string(),
  principalId: z.string(),
  principalName: z.string(),
  principalKind: z.string(),
  label: z.string(),
  platform: z.string(),
  status: z.enum(DEVICE_STATUSES),
  /** 待确认时的申请标识（`approve` / `reject` 用）；其余状态是 `null`。 */
  pendingId: z.string().nullable(),
  /** `local` / `pairing` / `endorse:<deviceId>` / `link:<linkId>`；未批是空串。 */
  approvedBy: z.string(),
  issuer: z.string(),
  /** 设备钥公钥的指纹（base32，52 字符，界面分组显示前 16 位）。 */
  fingerprint: z.string(),
  createdAtMs: z.number().int(),
  approvedAtMs: z.number().int(),
  lastSeenAtMs: z.number().int(),
  revokedAtMs: z.number().int(),
});

export type TrustedDevice = z.infer<typeof trustedDeviceSchema>;

export const trustedDeviceListSchema = z.object({
  devices: z.array(trustedDeviceSchema),
});

const deviceKey = {
  deviceId: z.string(),
  principalId: z.string(),
};

const ok = z.object({ ok: z.literal(true) });
const denied = errors.pick("unauthenticated", "forbidden");
const base = { since: "1.45", contract: "§77.1" } as const;

export const DEVICES_PATH = "/api/devices";

export const devices = {
  /** 全部设备钥（含待确认、被拒与撤销的），新的在前。 */
  list: oc
    .input(z.object({}).optional())
    .output(trustedDeviceListSchema)
    .errors(denied)
    .meta(
      meta({
        ...base,
        scope: "settings:read",
        legacy: { method: "GET", path: DEVICES_PATH },
      }),
    ),
  /** 核对校验码后放行一台待确认的设备。 */
  approve: oc
    .input(z.object({ pendingId: z.string(), sas: z.string() }))
    .output(z.object({ device: trustedDeviceSchema }))
    .errors({
      ...denied,
      ...errors.pick("bad_request", "not_found", "sas_mismatch", "sas_expired"),
    })
    .meta(
      meta({
        ...base,
        contract: "§77.2",
        scope: "settings:write",
        legacy: { method: "POST", path: `${DEVICES_PATH}/approve` },
      }),
    ),
  /** 拒绝一台待确认的设备；同一把钥再来直接答 `device_rejected`。 */
  reject: oc
    .input(z.object({ pendingId: z.string() }))
    .output(ok)
    .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
    .meta(
      meta({
        ...base,
        contract: "§77.2",
        scope: "settings:write",
        legacy: { method: "POST", path: `${DEVICES_PATH}/reject` },
      }),
    ),
  /** 撤销：吊销经这把钥签的会话并断开它的通道。 */
  revoke: oc
    .input(z.object(deviceKey))
    .output(ok)
    .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
    .meta(
      meta({
        ...base,
        contract: "§77.3",
        scope: "settings:write",
        legacy: { method: "POST", path: `${DEVICES_PATH}/revoke` },
      }),
    ),
  /** 删掉一行（被拒或撤销之后让它能重新申请）；还有效的先撤销。 */
  forget: oc
    .input(z.object(deviceKey))
    .output(ok)
    .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
    .meta(
      meta({
        ...base,
        contract: "§77.3",
        scope: "settings:write",
        legacy: { method: "POST", path: `${DEVICES_PATH}/forget` },
      }),
    ),
  rename: oc
    .input(z.object({ ...deviceKey, label: z.string() }))
    .output(ok)
    .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
    .meta(
      meta({
        ...base,
        contract: "§77.3",
        scope: "settings:write",
        legacy: { method: "POST", path: `${DEVICES_PATH}/rename` },
      }),
    ),
};
